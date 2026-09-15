// One-shot revenue-category backfill: separate "กำไรจากการขายหุ้น" from
// dividends (4020) in the general ledger.
//
// Context: before this fix the statement parser emitted — for each computable
// SELL — BOTH the asset SELL row (gain posted to 4010) AND a duplicate income
// row (`section = "กำไรจากการขายหุ้น"`) that incomeAccountFor() routed to the
// DIVIDEND account (4020), double-counting the realized gain and polluting the
// dividend account. The posting engine now skips those duplicate rows.
//
// This script repairs EXISTING data for each user:
//   1. Reverses the journal entries that were created from the duplicate
//      "กำไรจากการขายหุ้น" income rows onto account 4020 (reversal entries are
//      real events; the SELL asset row's 4010 posting is untouched).
//   2. Back-fills `symbol` on dividend Capital_Transactions rows whose section
//      embeds the ticker ("เงินปันผล:X") but whose symbol column is NULL.
//   3. Back-fills the stock symbol into `memo` on the 4020 credit line of
//      existing dividend journal postings so the dividend account ledger shows
//      which stock each dividend came from.
//
// Safe to re-run: already-processed items are no-ops (entry already REVERSED,
// symbol already set, memo already filled).
//
// Run:  npx tsx scripts/backfill-revenue-categories.mts [userId]
import "dotenv/config";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../app/lib/drizzle-db";
import { users } from "../app/db/schema";
import { capitalTransactions, journalEntries, journalEntryLines } from "../app/db/schema";
import { getAccounts, reverseJournalEntry } from "../app/lib/ledger-service";

async function main() {
  const filterUserId = process.argv[2];

  const rows = filterUserId
    ? [{ id: filterUserId }]
    : await db.select({ id: users.id }).from(users).execute();

  const summary = { reversed: 0, symbolBackfilled: 0, memoBackfilled: 0 };

  for (const { id } of rows) {
    try {
      const result = await backfillUser(id);
      summary.reversed += result.reversed;
      summary.symbolBackfilled += result.symbolBackfilled;
      summary.memoBackfilled += result.memoBackfilled;
      console.log(
        `[backfill] user=${id} reversedGainRows=${result.reversed} ` +
          `symbolBackfilled=${result.symbolBackfilled} memoBackfilled=${result.memoBackfilled}`
      );
    } catch (error) {
      console.error(`[backfill] user=${id} FAILED`, error);
    }
  }

  console.log(
    `\n[backfill] done. reversed=${summary.reversed} symbolBackfilled=${summary.symbolBackfilled} memoBackfilled=${summary.memoBackfilled}`
  );
  process.exit(0);
}

const DIVIDEND_ACCOUNT_CODE = "4020";
const CAPITAL_GAIN_SECTION = "กำไรจากการขายหุ้น";

function symbolFromSection(section: string | null): string | null {
  if (!section) return null;
  const m = section.match(/เงินปันผล\s*[:：]\s*([A-Za-z0-9._-]+)/i);
  return m ? m[1].toUpperCase() : null;
}

async function backfillUser(userId: string) {
  const accounts = await getAccounts(userId);
  const dividendAccount = accounts.find((a) => a.code === DIVIDEND_ACCOUNT_CODE);
  const dividendAccountId = dividendAccount?.id ?? null;

  let reversed = 0;
  let symbolBackfilled = 0;
  let memoBackfilled = 0;

  // ---- 1. Reverse journal entries created from the duplicate capital-gain
  // income rows that landed on the DIVIDEND account (4020). -----------------
  const gainRows = await db
    .select({ transactionId: capitalTransactions.transactionId })
    .from(capitalTransactions)
    .where(
      and(
        eq(capitalTransactions.userId, userId),
        eq(capitalTransactions.category, "income"),
        eq(capitalTransactions.section, CAPITAL_GAIN_SECTION)
      )
    )
    .execute();

  if (gainRows.length > 0 && dividendAccountId) {
    const sourceIds = gainRows.map((r) => r.transactionId);
    const entries = await db
      .select({ id: journalEntries.id, entryNo: journalEntries.entryNo })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.userId, userId),
          eq(journalEntries.status, "POSTED"),
          eq(journalEntries.sourceType, "STATEMENT"),
          inArray(journalEntries.sourceTransactionId, sourceIds)
        )
      )
      .execute();

    for (const entry of entries) {
      // Only reverse when this entry really credited the dividend account (i.e.
      // it is the mis-routed duplicate, not some other posting that happens to
      // share the source row).
      const [line] = await db
        .select({ id: journalEntryLines.id })
        .from(journalEntryLines)
        .where(
          and(
            eq(journalEntryLines.journalEntryId, entry.id),
            eq(journalEntryLines.accountId, dividendAccountId)
          )
        )
        .limit(1)
        .execute();
      if (!line) continue;

      const result = await reverseJournalEntry(userId, entry.id);
      if (result.ok) {
        reversed++;
        console.log(
          `    reversed entry #${entry.entryNo} (mis-routed capital gain on ${DIVIDEND_ACCOUNT_CODE})`
        );
      } else {
        console.error(
          `    reverse FAILED for entry #${entry.entryNo}: ${result.errors.join("; ")}`
        );
      }
    }
  }

  // ---- 1b. Catch orphaned entries whose source Capital_Transactions row was
  // deleted (per-row ledger delete) but the journal entry remains POSTED on
  // 4020. Identify by description = "กำไรจากการขายหุ้น" + source_type STATEMENT.
  // Step 1 above already reversed entries that still had matching Capital_Transactions
  // rows; this pass catches the rest. ---------------------------------------
  if (dividendAccountId) {
    const orphanedGainEntries = await db
      .select({ id: journalEntries.id, entryNo: journalEntries.entryNo })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.userId, userId),
          eq(journalEntries.status, "POSTED"),
          eq(journalEntries.sourceType, "STATEMENT"),
          eq(journalEntries.description, CAPITAL_GAIN_SECTION)
        )
      )
      .execute();

    for (const entry of orphanedGainEntries) {
      const [line] = await db
        .select({ id: journalEntryLines.id })
        .from(journalEntryLines)
        .where(
          and(
            eq(journalEntryLines.journalEntryId, entry.id),
            eq(journalEntryLines.accountId, dividendAccountId)
          )
        )
        .limit(1)
        .execute();
      if (!line) continue;

      const result = await reverseJournalEntry(userId, entry.id);
      if (result.ok) {
        reversed++;
        console.log(
          `    reversed entry #${entry.entryNo} (orphaned capital gain on ${DIVIDEND_ACCOUNT_CODE})`
        );
      }
    }
  }

  // ---- 2. Back-fill symbol on dividend rows that embed the ticker in their
  // section label ("เงินปันผล:goog") but have a NULL symbol column. ---------
  const nullSymbolDividends = await db
    .select()
    .from(capitalTransactions)
    .where(
      and(
        eq(capitalTransactions.userId, userId),
        eq(capitalTransactions.category, "income"),
        sql`${capitalTransactions.section} LIKE ${"เงินปันผล:%"}`
      )
    )
    .execute();

  for (const row of nullSymbolDividends) {
    const symbol = symbolFromSection(row.section);
    if (!symbol) continue;
    if (row.symbol === symbol) continue;
    await db
      .update(capitalTransactions)
      .set({ symbol })
      .where(eq(capitalTransactions.transactionId, row.transactionId))
      .execute();
    symbolBackfilled++;
  }

  // ---- 3. Back-fill memo = stock symbol on the 4020 credit line of existing
  // dividend journal postings (so the dividend account ledger shows the stock).
  // Runs for every dividend section row regardless of the step-2 symbol change
  // (idempotent because it reads the current symbol from the transactions table).
  if (dividendAccountId) {
    const dividendRows = await db
      .select({
        transactionId: capitalTransactions.transactionId,
        symbol: capitalTransactions.symbol,
      })
      .from(capitalTransactions)
      .where(
        and(
          eq(capitalTransactions.userId, userId),
          eq(capitalTransactions.category, "income"),
          sql`${capitalTransactions.section} LIKE ${"เงินปันผล:%"}`
        )
      )
      .execute();

    const sourceIds = dividendRows.map((r) => r.transactionId);
    if (sourceIds.length > 0) {
      const entries = await db
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.userId, userId),
            inArray(journalEntries.sourceTransactionId, sourceIds)
          )
        )
        .execute();
      const symbolBySource = new Map(
        dividendRows.map((r) => [r.transactionId, r.symbol])
      );

      for (const entry of entries) {
        // Journal lines do not store the source transaction id; re-resolve via
        // the matching dividend row by loading this entry's source id.
        const [header] = await db
          .select({ sourceTransactionId: journalEntries.sourceTransactionId })
          .from(journalEntries)
          .where(eq(journalEntries.id, entry.id))
          .limit(1)
          .execute();
        const symbol = header?.sourceTransactionId
          ? symbolBySource.get(header.sourceTransactionId) ?? null
          : null;
        if (!symbol) continue;

        const lines = await db
          .select()
          .from(journalEntryLines)
          .where(
            and(
              eq(journalEntryLines.journalEntryId, entry.id),
              eq(journalEntryLines.accountId, dividendAccountId)
            )
          )
          .execute();
        for (const line of lines) {
          if (line.memo === symbol) continue;
          await db
            .update(journalEntryLines)
            .set({ memo: symbol })
            .where(eq(journalEntryLines.id, line.id))
            .execute();
          memoBackfilled++;
        }
      }
    }
  }

  return { reversed, symbolBackfilled, memoBackfilled };
}

void main();