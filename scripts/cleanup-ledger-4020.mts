// One-shot 4020 (dividend account) noise cleanup for the general ledger.
//
// Context: the old statement parser emitted — for every computable SELL — BOTH
// the asset SELL row (gain -> 4010 / loss -> 5120) AND a duplicate income row
// with section "กำไรจากการขายหุ้น" that incomeAccountFor() mis-routed to the
// DIVIDEND account (4020). The revenue-categories fix stopped new postings, and
// backfill-revenue-categories.mts REVERSED the existing duplicates — but the
// ledger still shows the REVERSED originals + their MANUAL "กลับรายการ" mirrors
// as noise on 4020. The user approved deleting that noise for real.
//
// This script repairs EXISTING data for each user:
//   1. DELETES every journal entry that lands on 4020 with description
//      "กำไรจากการขายหุ้น" (STATEMENT — the mis-routed duplicate, REVERSED or
//      not) and every MANUAL "กลับรายการ: กำไรจากการขายหุ้น…" reversal. A
//      legitimate MANUAL entry like "รับเงินปันผล" is NOT touched.
//   2. REWRITES existing SELL entry descriptions to the wording the posting
//      engine now uses: computable gain -> "กำไรจากการขาย …", computable loss
//      -> "ขาดทุนจากการขาย …" (previously the bare "ขาย …" hid the outcome).
//
// Idempotent: already-deleted/rewritten items are no-ops on re-run.
//
// Run:  npx tsx scripts/cleanup-ledger-4020.mts [userId]
import "dotenv/config";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../app/lib/drizzle-db";
import { users } from "../app/db/schema";
import { capitalTransactions, journalEntries, journalEntryLines } from "../app/db/schema";
import { getAccounts } from "../app/lib/ledger-service";
import { sellRowDescription } from "../app/lib/posting-engine";

const DIVIDEND_ACCOUNT_CODE = "4020";
const GAIN_ACCOUNT_CODE = "4010";
const LOSS_ACCOUNT_CODE = "5120";
const CAPITAL_GAIN_SECTION = "กำไรจากการขายหุ้น";
const REVERSAL_PREFIX = `กลับรายการ: ${CAPITAL_GAIN_SECTION}`;

async function main() {
  const filterUserId = process.argv[2];

  const rows = filterUserId
    ? [{ id: filterUserId }]
    : await db.select({ id: users.id }).from(users).execute();

  const summary = { deletedEntries: 0, deletedLines: 0, rewritten: 0 };

  for (const { id } of rows) {
    try {
      const result = await cleanupUser(id);
      summary.deletedEntries += result.deletedEntries;
      summary.deletedLines += result.deletedLines;
      summary.rewritten += result.rewritten;
      console.log(
        `[cleanup] user=${id} deletedEntries=${result.deletedEntries} ` +
          `deletedLines=${result.deletedLines} rewrittenSellDescriptions=${result.rewritten}`
      );
    } catch (error) {
      console.error(`[cleanup] user=${id} FAILED`, error);
    }
  }

  console.log(
    `\n[cleanup] done. deletedEntries=${summary.deletedEntries} ` +
      `deletedLines=${summary.deletedLines} rewrittenSellDescriptions=${summary.rewritten}`
  );
  process.exit(0);
}

async function cleanupUser(userId: string) {
  const accounts = await getAccounts(userId);
  const dividendAccountId =
    accounts.find((a) => a.code === DIVIDEND_ACCOUNT_CODE)?.id ?? null;
  const gainAccountId =
    accounts.find((a) => a.code === GAIN_ACCOUNT_CODE)?.id ?? null;
  const lossAccountId =
    accounts.find((a) => a.code === LOSS_ACCOUNT_CODE)?.id ?? null;

  let deletedEntries = 0;
  let deletedLines = 0;
  let rewritten = 0;

  // ---- 1. Delete the mis-routed capital-gain duplicates + their MANUAL
  // reversals that sit on the dividend account (4020). ------------------------
  if (dividendAccountId) {
    const lineRows = await db
      .select({ journalEntryId: journalEntryLines.journalEntryId })
      .from(journalEntryLines)
      .where(
        and(
          eq(journalEntryLines.userId, userId),
          eq(journalEntryLines.accountId, dividendAccountId)
        )
      )
      .execute();
    const entryIds = [...new Set(lineRows.map((r) => r.journalEntryId))];

    if (entryIds.length > 0) {
      const noisy = await db
        .select({
          id: journalEntries.id,
          entryNo: journalEntries.entryNo,
          description: journalEntries.description,
          sourceType: journalEntries.sourceType,
        })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.userId, userId),
            inArray(journalEntries.id, entryIds),
            or(
              and(
                eq(journalEntries.sourceType, "STATEMENT"),
                eq(journalEntries.description, CAPITAL_GAIN_SECTION)
              ),
              and(
                eq(journalEntries.sourceType, "MANUAL"),
                sql`${journalEntries.description} LIKE ${REVERSAL_PREFIX + "%"}`
              )
            )
          )
        )
        .execute();

      for (const entry of noisy) {
        const del = await db
          .delete(journalEntryLines)
          .where(eq(journalEntryLines.journalEntryId, entry.id))
          .returning({ id: journalEntryLines.id })
          .execute();
        deletedLines += del.length;
        await db.delete(journalEntries).where(eq(journalEntries.id, entry.id)).execute();
        deletedEntries++;
        console.log(
          `    deleted entry #${entry.entryNo} (${entry.sourceType}: ${entry.description}) on ${DIVIDEND_ACCOUNT_CODE}`
        );
      }
    }
  }

  // ---- 2. Rewrite SELL entry descriptions to the current wording. ----------
  const sellRows = await db
    .select({
      transactionId: capitalTransactions.transactionId,
      symbol: capitalTransactions.symbol,
      quantity: capitalTransactions.quantity,
      unitPrice: capitalTransactions.unitPrice,
      currency: capitalTransactions.currency,
      costBasis: capitalTransactions.costBasis,
      realizedGainLoss: capitalTransactions.realizedGainLoss,
    })
    .from(capitalTransactions)
    .where(
      and(
        eq(capitalTransactions.userId, userId),
        eq(capitalTransactions.side, "SELL"),
        isNotNull(capitalTransactions.costBasis),
        isNotNull(capitalTransactions.realizedGainLoss)
      )
    )
    .execute();

  const computable = sellRows.filter(
    (r) => r.symbol && r.quantity != null && r.unitPrice != null
  );
  const sourceIds = computable.map((r) => r.transactionId);

  if (sourceIds.length > 0) {
    const entries = await db
      .select({ id: journalEntries.id, entryNo: journalEntries.entryNo, description: journalEntries.description, sourceTransactionId: journalEntries.sourceTransactionId })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.userId, userId),
          eq(journalEntries.sourceType, "STATEMENT"),
          inArray(journalEntries.sourceTransactionId, sourceIds)
        )
      )
      .execute();

    const rowBySource = new Map(computable.map((r) => [r.transactionId, r]));
    const gainLossLineAccounts = [
      gainAccountId ?? "__none__",
      lossAccountId ?? "__none__",
    ].filter((id) => id !== "__none__");

    for (const entry of entries) {
      const row = entry.sourceTransactionId
        ? rowBySource.get(entry.sourceTransactionId)
        : null;
      if (!row) continue;

      const expected = sellRowDescription({
        symbol: row.symbol ?? "",
        quantity: row.quantity ?? "",
        unitPrice: row.unitPrice ?? "",
        currency: row.currency,
        costBasis: row.costBasis,
        realizedGainLoss: row.realizedGainLoss,
      });
      if (expected === entry.description) continue;

      // Only rewrite entries that really carry the gain/loss leg (4010/5120).
      // A bare SELL without a computable basis was filtered out above, but this
      // keeps the rewrite safe against manual edits.
      if (gainLossLineAccounts.length > 0) {
        const leg = await db
          .select({ id: journalEntryLines.id })
          .from(journalEntryLines)
          .where(
            and(
              eq(journalEntryLines.journalEntryId, entry.id),
              inArray(journalEntryLines.accountId, gainLossLineAccounts)
            )
          )
          .limit(1)
          .execute();
        if (leg.length === 0) continue;
      }

      await db
        .update(journalEntries)
        .set({
          description: expected,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(journalEntries.id, entry.id))
        .execute();
      rewritten++;
      console.log(
        `    rewrote entry #${entry.entryNo} description -> "…${expected.slice(0, 40)}…"`
      );
    }
  }

  // ---- 2b. Orphaned SELL entries: the source Capital_Transactions row was
  // deleted (per-row ledger delete) but the journal entry remains with its
  // gain/loss leg. The leg account is itself the sign — 4010 => gain,
  // 5120 => loss — so we can still apply the current wording.
  // -------------------------------------------------------------------------
  const gainOrLossIds = [gainAccountId, lossAccountId].filter(
    (id): id is string => id != null
  );
  if (gainOrLossIds.length > 0) {
    const netLegs = await db
      .select({ journalEntryId: journalEntryLines.journalEntryId, accountId: journalEntryLines.accountId })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(journalEntryLines.userId, userId),
          inArray(journalEntryLines.accountId, gainOrLossIds),
          eq(journalEntries.sourceType, "STATEMENT"),
          sql`${journalEntries.description} LIKE ${"ขาย %"}`
        )
      )
      .execute();

    const accountCodeById = new Map([
      [gainAccountId ?? "", GAIN_ACCOUNT_CODE],
      [lossAccountId ?? "", LOSS_ACCOUNT_CODE],
    ]);
    for (const netLeg of netLegs) {
      const accountCode = accountCodeById.get(netLeg.accountId);
      if (!accountCode) continue;
      const [entry] = await db
        .select({ id: journalEntries.id, entryNo: journalEntries.entryNo, description: journalEntries.description })
        .from(journalEntries)
        .where(eq(journalEntries.id, netLeg.journalEntryId))
        .limit(1)
        .execute();
      if (!entry) continue;
      // Skip entries a healed source row already rewrote above (expected now
      // matches) and anything not in the bare "ขาย …" shape.
      if (!entry.description.startsWith("ขาย ")) continue;
      const rest = entry.description.slice("ขาย ".length);
      if (!rest.trim()) continue;
      const prefix = accountCode === GAIN_ACCOUNT_CODE ? "กำไรจากการขาย" : "ขาดทุนจากการขาย";
      const expected = `${prefix} ${rest}`.trim();
      if (expected === entry.description) continue;
      await db
        .update(journalEntries)
        .set({ description: expected, updatedAt: new Date().toISOString() })
        .where(eq(journalEntries.id, entry.id))
        .execute();
      rewritten++;
      console.log(
        `    rewrote orphaned SELL entry #${entry.entryNo} description -> "…${expected.slice(0, 40)}…"`
      );
    }
  }

  return { deletedEntries, deletedLines, rewritten };
}

void main();