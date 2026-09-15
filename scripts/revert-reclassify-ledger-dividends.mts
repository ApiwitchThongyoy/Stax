// Revert scripts/reclassify-ledger-dividends.mts (removed): restore the
// general-ledger income accounts to their account-name-consistent roles.
//
// The earlier reclassify swapped DATA against the account names, which was the
// wrong direction: it moved STATEMENT capital-gain rows (กำไรจากการขาย X) INTO
// the dividend account (4020) — filling the dividend account with capital gains
// — and moved the flat MANUAL รับเงินปันผล line OUT of 4020 into 4010, leaving
// 4010 (รายได้ - กำไรจากการขายหลักทรัพย์) empty for real users. The posting
// engine has ALWAYS posted gains -> 4010 and dividends -> 4020 (GAIN_INCOME /
// DIVIDEND_INCOME), so this script re-points the data back to match the code:
//
//   1. Moves every STATEMENT income line currently sitting on 4020 whose
//      description names a sold stock ("กำไรจากการขาย …", "ขาดทุนจากการขาย …",
//      "ขาย …") back to 4010. The per-stock memo stamped by the reclassify is
//      KEPT so the 4010 ledger still shows which stock each gain came from.
//   2. Moves the flat MANUAL "รับเงินปันผล" line currently on 4010 back to 4020
//      (it is real dividend income).
//
// Safe + idempotent: lines are re-pointed only while they sit on the account
// they are being moved FROM, so a re-run is a no-op. The ledger stays balanced
// (line-level account re-assignment keeps every entry's debits = credits).
//
// Run:  npx tsx scripts/revert-reclassify-ledger-dividends.mts [userId] [--dry-run]
import "dotenv/config";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../app/lib/drizzle-db";
import {
  users,
  journalEntries,
  journalEntryLines,
} from "../app/db/schema";
import { getAccounts } from "../app/lib/ledger-service";

const DIVIDEND_ACCOUNT_CODE = "4020";
const GAIN_ACCOUNT_CODE = "4010";

/** Ticker quoted after a sale prefix: "กำไรจากการขาย NVDA 2 @ ..." -> NVDA. */
const SELL_PREFIX =
  /(?:กำไรจากการขาย|ขาดทุนจากการขาย|ขายหลักทรัพย์|ขาย)\s+([A-Za-z0-9._-]{1,12})/;

function symbolFromDescription(description: string): string | null {
  if (!description) return null;
  const m = description.match(SELL_PREFIX);
  return m ? m[1].toUpperCase() : null;
}

async function main() {
  const filterUserId = process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2]
    : undefined;
  const dryRun = process.argv.includes("--dry-run");

  const rows = filterUserId
    ? [{ id: filterUserId }]
    : await db.select({ id: users.id }).from(users).execute();

  const summary = {
    movedStatementLines: 0,
    movedManualLines: 0,
    users: rows.length,
  };

  if (dryRun) console.log("[revert] DRY RUN — no changes written\n");

  const allMovedEntryIds = new Set<string>();

  for (const { id } of rows) {
    try {
      const result = await revertUser(id);
      summary.movedStatementLines += result.movedStatementLines;
      summary.movedManualLines += result.movedManualLines;
      for (const entryId of result.movedEntryIds) allMovedEntryIds.add(entryId);
      console.log(
        `[revert] user=${id} statementLinesTo4010=${result.movedStatementLines} ` +
          `manualLineTo4020=${result.movedManualLines} ${dryRun ? "[dry]" : ""}`
      );
    } catch (error) {
      console.error(`[revert] user=${id} FAILED`, error);
    }
  }

  if (!dryRun && allMovedEntryIds.size > 0) {
    for (const { id } of rows) {
      await printGainAccount(id);
    }
    await assertLedgerBalanced([...allMovedEntryIds]);
  }

  console.log(
    `\n[revert] done. users=${summary.users} ` +
      `statementLinesTo4010=${summary.movedStatementLines} ` +
      `manualLineTo4020=${summary.movedManualLines}`
  );
  process.exit(0);
}

async function revertUser(userId: string) {
  const accounts = await getAccounts(userId);
  const dividendAccountId =
    accounts.find((a) => a.code === DIVIDEND_ACCOUNT_CODE)?.id ?? null;
  const gainAccountId =
    accounts.find((a) => a.code === GAIN_ACCOUNT_CODE)?.id ?? null;

  let movedStatementLines = 0;
  let movedManualLines = 0;
  const movedEntryIds: string[] = [];

  // ---- 1. STATEMENT sell-income lines: 4020 -> 4010 (undo the reclassify's
  // 4010 -> 4020 move). Memo kept. -------------------------------------------
  if (dividendAccountId && gainAccountId) {
    const candidates = await db
      .select({
        lineId: journalEntryLines.id,
        entryId: journalEntryLines.journalEntryId,
        description: journalEntries.description,
      })
      .from(journalEntryLines)
      .innerJoin(
        journalEntries,
        and(
          eq(journalEntryLines.journalEntryId, journalEntries.id),
          eq(journalEntryLines.userId, journalEntries.userId)
        )
      )
      .where(
        and(
          eq(journalEntryLines.userId, userId),
          eq(journalEntryLines.accountId, dividendAccountId),
          eq(journalEntries.sourceType, "STATEMENT")
        )
      )
      .execute();

    const moves = new Map<string, string>(); // lineId -> symbol (kept as memo)
    const entryIdsInMoves: string[] = [];
    for (const c of candidates) {
      const symbol = symbolFromDescription(c.description);
      if (symbol) {
        moves.set(c.lineId, symbol);
        entryIdsInMoves.push(c.entryId);
      }
    }

    if (moves.size > 0) {
      if (process.argv.includes("--dry-run")) {
        movedStatementLines = moves.size;
      } else {
        for (const [lineId, symbol] of moves) {
          const existing = await db
            .select({ memo: journalEntryLines.memo })
            .from(journalEntryLines)
            .where(eq(journalEntryLines.id, lineId))
            .execute();
          const memo = existing[0]?.memo ?? null;
          await db
            .update(journalEntryLines)
            .set({ accountId: gainAccountId, memo: memo ?? symbol })
            .where(eq(journalEntryLines.id, lineId))
            .execute();
        }
        movedStatementLines = moves.size;
        movedEntryIds.push(...entryIdsInMoves);
      }
    }
  }

  // ---- 2. Flat MANUAL dividend line: 4010 -> 4020 (undo the reclassify's
  // 4020 -> 4010 move). ------------------------------------------------------
  if (dividendAccountId && gainAccountId) {
    const manualLines = await db
      .select({
        lineId: journalEntryLines.id,
        entryId: journalEntryLines.journalEntryId,
        description: journalEntries.description,
      })
      .from(journalEntryLines)
      .innerJoin(
        journalEntries,
        and(
          eq(journalEntryLines.journalEntryId, journalEntries.id),
          eq(journalEntryLines.userId, journalEntries.userId)
        )
      )
      .where(
        and(
          eq(journalEntryLines.userId, userId),
          eq(journalEntryLines.accountId, gainAccountId),
          eq(journalEntries.sourceType, "MANUAL"),
          sql`${journalEntries.description} LIKE ${"รับเงินปันผล%"}`
        )
      )
      .execute();

    if (manualLines.length > 0) {
      if (process.argv.includes("--dry-run")) {
        movedManualLines = manualLines.length;
      } else {
        for (const m of manualLines) {
          await db
            .update(journalEntryLines)
            .set({ accountId: dividendAccountId })
            .where(eq(journalEntryLines.id, m.lineId))
            .execute();
          movedEntryIds.push(m.entryId);
        }
        movedManualLines = manualLines.length;
      }
    }
  }

  return { movedStatementLines, movedManualLines, movedEntryIds };
}

async function printGainAccount(userId: string) {
  const accounts = await getAccounts(userId);
  const gainAccountId =
    accounts.find((a) => a.code === GAIN_ACCOUNT_CODE)?.id ?? null;
  if (!gainAccountId) return;

  const lines = await db
    .select({
      entryDate: journalEntries.entryDate,
      description: journalEntries.description,
      sourceType: journalEntries.sourceType,
      memo: journalEntryLines.memo,
      credit: journalEntryLines.creditAmount,
      debit: journalEntryLines.debitAmount,
    })
    .from(journalEntryLines)
    .innerJoin(
      journalEntries,
      and(
        eq(journalEntryLines.journalEntryId, journalEntries.id),
        eq(journalEntryLines.userId, journalEntries.userId)
      )
    )
    .where(
      and(
        eq(journalEntryLines.userId, userId),
        eq(journalEntryLines.accountId, gainAccountId)
      )
    )
    .orderBy(journalEntries.entryDate)
    .execute();

  console.log(`\n[revert] account ${GAIN_ACCOUNT_CODE} for ${userId}:`);
  if (lines.length === 0) {
    console.log("  (no lines)");
    return;
  }
  const bySymbol = new Map<string, { count: number; total: number }>();
  for (const l of lines) {
    const symbol = l.memo ?? "-";
    const amount = l.credit !== null ? Number(l.credit) : -Number(l.debit ?? 0);
    const cur = bySymbol.get(symbol) ?? { count: 0, total: 0 };
    cur.count += 1;
    cur.total += amount;
    bySymbol.set(symbol, cur);
  }
  for (const [symbol, s] of bySymbol) {
    console.log(
      `  ${symbol.padEnd(12)} lines=${s.count.toString().padStart(3)} net=${s.total.toFixed(2)}`
    );
  }
}

async function assertLedgerBalanced(movedEntryIds: string[]) {
  if (movedEntryIds.length === 0) {
    console.log("\n[revert] VERIFY: nothing moved — nothing to assert.");
    return;
  }
  // Tolerance 0.01: historical statement postings carry one-cent rounding
  // artifacts (e.g. CRWV 292.92 vs 292.93) that predate this script. The move
  // itself only re-points account_id — it can never change per-entry totals,
  // so anything beyond a cent is a real red flag.
  const bad = await db
    .select({ id: journalEntries.id, entryNo: journalEntries.entryNo })
    .from(journalEntries)
    .where(
      and(
        inArray(journalEntries.id, movedEntryIds),
        sql`EXISTS (
          SELECT 1 FROM journal_entry_lines l
          WHERE l.journal_entry_id = journal_entries.id
          GROUP BY l.journal_entry_id
          HAVING ABS(COALESCE(SUM(l.debit_amount), 0) - COALESCE(SUM(l.credit_amount), 0)) > 0.01
        )`
      )
    )
    .execute();
  if (bad.length === 0) {
    console.log("\n[revert] VERIFY: all moved entries remain balanced.");
  } else {
    console.error(
      `\n[revert] VERIFY FAILED: ${bad.length} moved entries are unbalanced:`,
      bad.map((b) => `#${b.entryNo}`).join(", ")
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});