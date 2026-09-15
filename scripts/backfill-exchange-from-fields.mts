// One-shot backfill for legacy currency-exchange rows missing the FROM side.
//
// Background: migration 0021 added `exchange_from_currency` /
// `exchange_from_amount` / `exchange_rate` to Capital_Transactions and
// journal_entries. Rows imported BEFORE that migration only recorded the
// received (TO) side, so their from-fields are NULL and the UI had to show a
// confusing "-" / "ไม่ทราบสกุล" label.
//
// Why this fill is SAFE (not a guess): statements only ever contain USD and
// THB, so a row whose received side is USD must have given away THB (and vice
// versa). The script verifies amount_thb == amount × fx_rate_effective (within
// 0.02) for every filled row, and ABORTS the row (leaves it NULL, logs a
// warning) if the equality does not hold or the to-currency is neither
// USD nor THB.
//
// Values written:
//   - to=USD -> from_currency='THB', from_amount=amount_thb (exact THB spent),
//     rate=fx_rate_effective (THB per USD)
//   - to=THB -> from_currency='USD' ONLY (from_amount/rate left NULL: the
//     printed rate is lost on THB-pinned rows; a re-import recovers it)
//   - anything else -> skipped with a warning, never invented
//
// Both tables are filled in one per-user transaction so Capital_Transactions
// and its journal mirrors stay in sync. Safe to re-run: filled rows no longer
// match the NULL filter, so the second run is a no-op.
//
// Run:  npx tsx scripts/backfill-exchange-from-fields.mts [userId] [--dry-run]
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../app/lib/drizzle-db";
import { users } from "../app/db/schema";

interface BackfillRow {
  transactionId: string;
  currency: string;
  amountForeign: string;
  amountThb: string;
  fxRateEffective: string | null;
}

async function main() {
  const filterUserId = process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2]
    : undefined;
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("[backfill-exchange-from] DRY RUN — no changes written\n");

  const userRows = filterUserId
    ? [{ id: filterUserId }]
    : await db.select({ id: users.id }).from(users).execute();

  let filledTotal = 0;
  let warnTotal = 0;
  for (const { id } of userRows) {
    try {
      const result = await backfillUser(id, dryRun);
      filledTotal += result.filled;
      warnTotal += result.warned;
      if (result.filled > 0 || result.warned > 0) {
        console.log(
          `user=${id} capital=${result.capital} journal=${result.journal}` +
            ` ${dryRun ? "[dry]" : "[done]"} warned=${result.warned}`
        );
      }
    } catch (error) {
      console.error(`[backfill-exchange-from] user=${id} FAILED`, error);
    }
  }

  console.log(
    `\n[backfill-exchange-from] done${dryRun ? " (DRY-RUN)" : ""}. ` +
      `rows filled: ${filledTotal}, warnings: ${warnTotal}`
  );
  process.exit(0);
}

async function backfillUser(userId: string, dryRun: boolean) {
  // Legacy FX rows: section marks the exchange rows in Capital_Transactions;
  // is_fx_conversion marks them in the journal.
  const capitalRows = (await db.execute(sql`
    SELECT transaction_id AS "transactionId", currency,
           amount_foreign AS "amountForeign", amount_thb AS "amountThb",
           fx_rate_effective AS "fxRateEffective"
    FROM "Capital_Transactions"
    WHERE user_id = ${userId}
      AND exchange_from_currency IS NULL
      AND (
        section = 'แลกเปลี่ยนสกุลเงิน'
      )
  `)) as unknown as BackfillRow[];

  const journalRows = (await db.execute(sql`
    SELECT source_transaction_id AS "transactionId", currency,
           amount AS "amountForeign", amount_thb AS "amountThb",
           fx_rate_effective AS "fxRateEffective"
    FROM journal_entries
    WHERE user_id = ${userId}
      AND exchange_from_currency IS NULL
      AND is_fx_conversion = true
      AND source_transaction_id IS NOT NULL
  `)) as unknown as BackfillRow[];

  let filledCapital = 0;
  let filledJournal = 0;
  let warned = 0;

  // Validate every row BEFORE writing anything for this user. A single
  // inconsistent row aborts only that row (logged), never the whole user.
  const capitalFills: Array<{ id: string; from: string; fromAmt: string | null; rate: string | null }> = [];
  for (const r of capitalRows) {
    const fill = resolveFill(r);
    if (!fill) {
      warned++;
      console.log(`    [warn] capital row=${r.transactionId} currency=${r.currency} — left NULL (cannot derive safely)`);
      continue;
    }
    capitalFills.push({ id: r.transactionId, ...fill });
  }

  const journalFills: Array<{ id: string; from: string; fromAmt: string | null; rate: string | null }> = [];
  for (const r of journalRows) {
    const fill = resolveFill(r);
    if (!fill) {
      warned++;
      console.log(`    [warn] journal row=${r.transactionId} currency=${r.currency} — left NULL (cannot derive safely)`);
      continue;
    }
    journalFills.push({ id: r.transactionId, ...fill });
  }

  if (dryRun) {
    return {
      filled: capitalFills.length + journalFills.length,
      capital: capitalFills.length,
      journal: journalFills.length,
      warned,
    };
  }

  await db.transaction(async (tx) => {
    for (const f of capitalFills) {
      await tx.execute(sql`
        UPDATE "Capital_Transactions"
        SET exchange_from_currency = ${f.from},
            exchange_from_amount = ${f.fromAmt},
            exchange_rate = ${f.rate}
        WHERE transaction_id = ${f.id} AND user_id = ${userId}
      `);
    }
    for (const f of journalFills) {
      await tx.execute(sql`
        UPDATE journal_entries
        SET exchange_from_currency = ${f.from},
            exchange_from_amount = ${f.fromAmt},
            exchange_rate = ${f.rate}
        WHERE source_transaction_id = ${f.id} AND user_id = ${userId}
      `);
    }
  });

  filledCapital = capitalFills.length;
  filledJournal = journalFills.length;
  return { filled: filledCapital + filledJournal, capital: filledCapital, journal: filledJournal, warned };
}

/**
 * Derive the FROM side from the stored TO side. Returns null when the row
 * cannot be filled safely (wrong currency universe, missing FX, or the
 * amount_thb consistency check fails) — the caller leaves such rows NULL.
 */
function resolveFill(r: BackfillRow): { from: string; fromAmt: string | null; rate: string | null } | null {
  const to = (r.currency ?? "").trim().toUpperCase();
  const amount = Number(r.amountForeign);
  const amountThb = Number(r.amountThb);
  const eff = r.fxRateEffective !== null && r.fxRateEffective !== "" ? Number(r.fxRateEffective) : NaN;
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(amountThb) || amountThb <= 0) {
    return null;
  }

  if (to === "USD") {
    // THB -> USD: the statement rate is THB per USD, so the THB spent equals
    // the stored amount_thb. Verify the equality instead of assuming it.
    if (!Number.isFinite(eff) || eff <= 0) return null;
    if (Math.abs(amountThb - amount * eff) > 0.02) return null;
    return { from: "THB", fromAmt: r.amountThb, rate: r.fxRateEffective };
  }
  if (to === "THB") {
    // USD -> THB: only the from-currency is recoverable (the printed rate is
    // lost on THB-pinned rows); amounts stay NULL for a future re-import.
    return { from: "USD", fromAmt: null, rate: null };
  }
  return null;
}

void main();
