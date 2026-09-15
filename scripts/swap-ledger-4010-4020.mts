// Swap the CONTENTS of GL accounts 4010 (รายได้ - กำไรจากการขายหลักทรัพย์) and
// 4020 (รายได้ - เงินปันผล) for every user — a data-level 4010 <-> 4020 swap
// that mirrors the posting-engine layout swap (GAIN_INCOME <-> DIVIDEND_INCOME).
//
// What this does: every journal_entry_lines row on the user's 4010 account is
// moved to their 4020 account, and every line on 4020 is moved to 4010 (all
// legs: STATEMENT, MANUAL, reversals). Amounts / currency / FX / memo are kept
// verbatim; only the account_id is relabelled. Because whole lines are moved
// between two INCOME accounts, every journal entry still balances per-currency
// and the trial balance stays balanced — no entry totals change.
//
// Orientation guard: a blind swap is its own inverse, so re-running would undo
// it. Before swapping, the script checks which account currently carries the
// per-stock gain STATEMENT lines (description "กำไรจากการขาย <ticker> …" with a
// symbol memo). If those lines are already on 4020, the swap already happened —
// abort unless --force.
//
// Run:  npx tsx scripts/swap-ledger-4010-4020.mts [userId] [--dry-run] [--force]
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../app/lib/drizzle-db";
import { users } from "../app/db/schema";
import { getAccounts } from "../app/lib/ledger-service";

const GAIN_CODE = "4010";
const DIVIDEND_CODE = "4020";

async function main() {
  const filterUserId = process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2]
    : undefined;
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  if (dryRun) console.log("[swap-4010-4020] DRY RUN — no changes written\n");

  const userRows = filterUserId
    ? [{ id: filterUserId }]
    : await db.select({ id: users.id }).from(users).execute();

  const report: string[] = [];
  let swappedTotal = 0;
  let skippedTotal = 0;

  for (const { id } of userRows) {
    try {
      const result = await swapUser(id, { dryRun, force });
      swappedTotal += result.swapped;
      skippedTotal += result.skipped;
      if (result.swapped > 0 || result.skipped > 0) {
        report.push(
          `user=${id}\n    movedTo4020=${result.movedTo4020} movedTo4010=${result.movedTo4010} (${dryRun ? "dry" : "done"})`
        );
      }
    } catch (error) {
      console.error(`[swap-4010-4020] user=${id} FAILED`, error);
    }
  }

  if (report.length > 0) {
    console.log(report.join("\n"));
    console.log("");
  }

  console.log(
    `[swap-4010-4020] done. users=${userRows.length} swapped=${swappedTotal} ` +
      `skipped=${skippedTotal} ${dryRun ? "[dry]" : ""}${force ? " [forced]" : ""}`
  );
  process.exit(0);
}

async function swapUser(userId: string, opts: { dryRun: boolean; force: boolean }) {
  const accounts = await getAccounts(userId);
  const gainId = accounts.find((a) => a.code === GAIN_CODE)?.id ?? null;
  const dividendId = accounts.find((a) => a.code === DIVIDEND_CODE)?.id ?? null;
  if (!gainId || !dividendId) {
    console.log(`    [skip] user=${userId} missing ${GAIN_CODE}/${DIVIDEND_CODE} accounts`);
    return { swapped: 0, skipped: 1, movedTo4010: 0, movedTo4020: 0 };
  }

  // Orientation guard: per-stock gain STATEMENT lines (description
  // "กำไรจากการขาย <ticker> …" + symbol memo) must currently live on 4010.
  if (!opts.force) {
    const on4010 = await countGainLines(userId, gainId);
    const on4020 = await countGainLines(userId, dividendId);
    if (on4020 > 0 && on4010 === 0) {
      console.log(`    [skip] user=${userId} looks already swapped (per-stock gain lines on 4020) — use --force to swap again`);
      return { swapped: 0, skipped: 1, movedTo4010: 0, movedTo4020: 0 };
    }
  }

  const before = await countLines(userId, gainId, dividendId);

  if (opts.dryRun) {
    return { swapped: 1, skipped: 0, movedTo4010: before.on4020, movedTo4020: before.on4010 };
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE journal_entry_lines
      SET account_id = CASE
        WHEN account_id = ${gainId} THEN ${dividendId}
        WHEN account_id = ${dividendId} THEN ${gainId}
        ELSE account_id END
      WHERE user_id = ${userId} AND account_id IN (${gainId}, ${dividendId})
    `);
  });

  const after = await countLines(userId, gainId, dividendId);
  const movedTo4020 = before.on4010;
  const movedTo4010 = before.on4020;
  if (
    after.on4010 !== movedTo4010 ||
    after.on4020 !== movedTo4020 ||
    before.on4010 + before.on4020 !== after.on4010 + after.on4020
  ) {
    throw new Error(
      `user=${userId} count mismatch: before ${before.on4010}/${before.on4020} after ${after.on4010}/${after.on4020}`
    );
  }
  return { swapped: 1, skipped: 0, movedTo4010, movedTo4020 };
}

async function countGainLines(userId: string, accountId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM journal_entry_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id AND e.user_id = l.user_id
    WHERE l.user_id = ${userId}
      AND l.account_id = ${accountId}
      AND l.memo IS NOT NULL
      AND e.source_type = 'STATEMENT'
      AND e.description LIKE 'กำไรจากการขาย %'
  `);
  return Number(rows[0]?.n ?? 0);
}

async function countLines(
  userId: string,
  gainId: string,
  dividendId: string
): Promise<{ on4010: number; on4020: number }> {
  const rows = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE account_id = ${gainId})::int AS on_4010,
      COUNT(*) FILTER (WHERE account_id = ${dividendId})::int AS on_4020
    FROM journal_entry_lines
    WHERE user_id = ${userId} AND account_id IN (${gainId}, ${dividendId})
  `);
  return { on4010: Number(rows[0]?.on_4010 ?? 0), on4020: Number(rows[0]?.on_4020 ?? 0) };
}

void main();