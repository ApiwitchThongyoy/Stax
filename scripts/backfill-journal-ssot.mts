// Journal-as-SSOT Phase 3 backfill: make the journal the complete daybook by
// mirroring every legacy Capital_Transactions row that has no journal entry.
//
// Context: statement imports and manual cash rows started writing to the
// journal (one entry per row) with the journal-as-SSOT work, but rows imported
// BEFORE that were never journaled. Reads (capital-ledgers, cash-summary,
// portfolio, document transactions) now serve FROM the journal, so those
// legacy rows would silently disappear unless they are backfilled.
//
// Per legacy row the script does exactly ONE of:
//   - alreadyMirrored : a journal entry already links this transaction_id.
//   - linkLegacy      : exactly ONE unlinked journal entry matches this row
//                       (same entry_date + description) — that is the row's OWN
//                       old GL posting; attach the link + full trade detail to
//                       it (no new entry, no new lines, existing postings kept).
//   - recordOnly      : no matching posting → insert a SKIPPED, line-less mirror
//                       record (status POSTED) so reads see the row, WITHOUT
//                       inventing GL postings (matches import SKIPPED semantics).
//   - manualCash      : legacy MANUAL CASH_IN/OUT with no posting → journal it
//                       as a real 2-leg POSTED equity entry (Dr cash / Cr owner
//                       capital), same as the manual POST handler does today.
//   - ambiguous       : more than one unlinked entry matches (rare) → record a
//                       SKIPPED mirror and never link the wrong one.
//
// Safe to re-run: rows already mirrored are no-ops. Postings are NEVER
// invented or modified besides attaching the link on unambiguous legacy
// entries. Run:  npx tsx scripts/backfill-journal-ssot.mts [userId] [--dry-run]
import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { db } from "../app/lib/drizzle-db";
import {
  capitalTransactions,
  journalEntries,
  users,
} from "../app/db/schema";
import { journalDetailOf, statementDescriptionFor } from "../app/lib/posting-engine";
import {
  insertBackfilledJournalEntry,
  insertManualCashJournal,
} from "../app/lib/ledger-service";
import type { ValidatedCapitalRow, ParsedCapitalType } from "../app/lib/statement-pipeline";

const VALID_TYPES = new Set(["CASH_IN", "CASH_OUT"]);

interface CapitalRowLike {
  transactionId: string;
  userId: string;
  amountForeign: string;
  currency: string;
  transactionDate: string;
  fxRateBot: string | null;
  amountThb: string;
  type: string | null;
  sourceType: string;
  sourceDocumentId: string | null;
  category: string | null;
  section: string | null;
  symbol: string | null;
  side: string | null;
  quantity: string | null;
  unitPrice: string | null;
  grossAmount: string | null;
  fees: string | null;
  netAmount: string | null;
  proceeds: string | null;
  costBasis: string | null;
  realizedGainLoss: string | null;
  realizedGainLossThb: string | null;
  fxRateStatement: string | null;
  fxRateEffective: string | null;
  exchange: string | null;
  exchangeFromCurrency: string | null;
  exchangeFromAmount: string | null;
  exchangeRate: string | null;
}

function rowToValidated(row: CapitalRowLike): ValidatedCapitalRow {
  const side = row.side === "BUY" || row.side === "SELL" ? row.side : null;
  const type: ParsedCapitalType = (
    VALID_TYPES.has(row.type ?? "") ? row.type : null
  ) as unknown as ParsedCapitalType;
  return {
    transactionId: row.transactionId,
    userId: row.userId,
    amountForeign: row.amountForeign,
    currency: row.currency,
    transactionDate: row.transactionDate,
    fxRateBot: row.fxRateBot,
    amountThb: row.amountThb,
    type,
    sourceType: "AI_PARSED",
    sourceDocumentId: row.sourceDocumentId ?? "",
    category: row.category ?? "",
    section: row.section ?? "",
    symbol: row.symbol,
    side,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    grossAmount: row.grossAmount,
    fees: row.fees,
    proceeds: row.proceeds,
    costBasis: row.costBasis,
    realizedGainLoss: row.realizedGainLoss,
    realizedGainLossThb: row.realizedGainLossThb,
    fxRateStatement: row.fxRateStatement,
    fxRateEffective: row.fxRateEffective,
    netAmount: row.netAmount,
    exchange: row.exchange,
    exchangeFromCurrency: row.exchangeFromCurrency,
    exchangeFromAmount: row.exchangeFromAmount,
    exchangeRate: row.exchangeRate,
  };
}

interface LegacyEntry {
  id: string;
  entryNo: number;
  entryDate: string;
  description: string;
  sourceTransactionId: string | null;
}

async function backfillUser(
  userId: string,
  dryRun: boolean
): Promise<{
  totalRows: number;
  alreadyMirrored: number;
  linkedLegacy: number;
  recordOnly: number;
  manualCash: number;
  ambiguous: number;
  failed: number;
}> {
  const capRows = (await db
    .select({
      transactionId: capitalTransactions.transactionId,
      userId: capitalTransactions.userId,
      amountForeign: capitalTransactions.amountForeign,
      currency: capitalTransactions.currency,
      transactionDate: capitalTransactions.transactionDate,
      fxRateBot: capitalTransactions.fxRateBot,
      amountThb: capitalTransactions.amountThb,
      type: capitalTransactions.type,
      sourceType: capitalTransactions.sourceType,
      sourceDocumentId: capitalTransactions.sourceDocumentId,
      category: capitalTransactions.category,
      section: capitalTransactions.section,
      symbol: capitalTransactions.symbol,
      side: capitalTransactions.side,
      quantity: capitalTransactions.quantity,
      unitPrice: capitalTransactions.unitPrice,
      grossAmount: capitalTransactions.grossAmount,
      fees: capitalTransactions.fees,
      netAmount: capitalTransactions.netAmount,
      proceeds: capitalTransactions.proceeds,
      costBasis: capitalTransactions.costBasis,
      realizedGainLoss: capitalTransactions.realizedGainLoss,
      realizedGainLossThb: capitalTransactions.realizedGainLossThb,
      fxRateStatement: capitalTransactions.fxRateStatement,
      fxRateEffective: capitalTransactions.fxRateEffective,
      exchange: capitalTransactions.exchange,
      exchangeFromCurrency: capitalTransactions.exchangeFromCurrency,
      exchangeFromAmount: capitalTransactions.exchangeFromAmount,
      exchangeRate: capitalTransactions.exchangeRate,
    })
    .from(capitalTransactions)
    .where(eq(capitalTransactions.userId, userId))
    .orderBy(
      capitalTransactions.transactionDate,
      capitalTransactions.transactionId
    )
    .execute()) as CapitalRowLike[];

  const entries = (await db
    .select({
      id: journalEntries.id,
      entryNo: journalEntries.entryNo,
      entryDate: journalEntries.entryDate,
      description: journalEntries.description,
      sourceTransactionId: journalEntries.sourceTransactionId,
    })
    .from(journalEntries)
    .where(eq(journalEntries.userId, userId))
    .execute()) as LegacyEntry[];

  const linked = new Set<string>();
  const unlinkedByKey = new Map<string, LegacyEntry[]>();
  for (const e of entries) {
    if (e.sourceTransactionId) {
      linked.add(e.sourceTransactionId);
    } else {
      const key = `${e.entryDate}|${e.description}`;
      const list = unlinkedByKey.get(key) ?? [];
      list.push(e);
      unlinkedByKey.set(key, list);
    }
  }

  const stats = {
    totalRows: capRows.length,
    alreadyMirrored: 0,
    linkedLegacy: 0,
    recordOnly: 0,
    manualCash: 0,
    ambiguous: 0,
    failed: 0,
  };

  for (const row of capRows) {
    if (linked.has(row.transactionId)) {
      stats.alreadyMirrored++;
      continue;
    }
    const validated = rowToValidated(row);
    const description = statementDescriptionFor(validated);
    const candidates = unlinkedByKey.get(
      `${row.transactionDate}|${description}`
    ) ?? [];

    if (candidates.length === 1) {
      const entry = candidates[0];
      if (!dryRun) {
        const detail = journalDetailOf(validated);
        await db
          .update(journalEntries)
          .set({
            sourceTransactionId: row.transactionId,
            sourceDocumentId: row.sourceDocumentId,
            type: row.type,
            category: detail.category,
            section: detail.section,
            symbol: detail.symbol,
            side: detail.side,
            exchange: detail.exchange,
            quantity: detail.quantity,
            unitPrice: detail.unitPrice,
            grossAmount: detail.grossAmount,
            fees: detail.fees,
            netAmount: detail.netAmount,
            proceeds: detail.proceeds,
            costBasis: detail.costBasis,
            realizedGainLoss: detail.realizedGainLoss,
            realizedGainLossThb: detail.realizedGainLossThb,
            averageCost: detail.averageCost,
            currency: detail.currency,
            amount: detail.amount,
            amountThb: detail.amountThb,
            fxRateEffective: detail.fxRateEffective,
            fxRateStatement: detail.fxRateStatement,
            isFxConversion: detail.isFxConversion,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(journalEntries.id, entry.id))
          .execute();
      }
      linked.add(row.transactionId);
      stats.linkedLegacy++;
      continue;
    }

    const isManualCash =
      row.sourceType === "MANUAL" &&
      (row.type === "CASH_IN" || row.type === "CASH_OUT");

    if (candidates.length > 1) {
      if (!dryRun) {
        await insertBackfilledJournalEntry(userId, {
          entryDate: row.transactionDate,
          description,
          sourceType: row.sourceType,
          sourceDocumentId: row.sourceDocumentId,
          sourceTransactionId: row.transactionId,
          type: row.type,
          postingState: "SKIPPED",
          skipReason: "backfilled-ambiguous-legacy",
          detail: journalDetailOf(validated),
        });
      }
      stats.ambiguous++;
      continue;
    }

    if (isManualCash) {
      if (!dryRun) {
        await insertManualCashJournal(userId, {
          transactionId: row.transactionId,
          type: row.type as "CASH_IN" | "CASH_OUT",
          amountForeign: row.amountForeign,
          currency: row.currency,
          transactionDate: row.transactionDate,
          fxRateEffective: row.fxRateEffective ?? row.fxRateBot ?? "1",
          amountThb: row.amountThb,
        });
      }
      stats.manualCash++;
      continue;
    }

    if (!dryRun) {
      const result = await insertBackfilledJournalEntry(userId, {
        entryDate: row.transactionDate,
        description,
        sourceType: row.sourceType,
        sourceDocumentId: row.sourceDocumentId,
        sourceTransactionId: row.transactionId,
        type: row.type,
        postingState: "SKIPPED",
        skipReason: "backfilled-record-only",
        detail: journalDetailOf(validated),
      });
      if (!result.ok) {
        stats.failed++;
        console.error(
          `[backfill] user=${userId} row=${row.transactionId} journal insert failed: ${result.errors.join("; ")}`
        );
        continue;
      }
    }
    stats.recordOnly++;
  }

  if (dryRun) {
    console.log(
      `[backfill] user=${userId} DRY-RUN rows=${stats.totalRows} ` +
        `alreadyMirrored=${stats.alreadyMirrored} linkLegacy=${stats.linkedLegacy} ` +
        `recordOnly=${stats.recordOnly} manualCash=${stats.manualCash} ` +
        `ambiguous=${stats.ambiguous}`
    );
  } else {
    console.log(
      `[backfill] user=${userId} rows=${stats.totalRows} ` +
        `alreadyMirrored=${stats.alreadyMirrored} linkedLegacy=${stats.linkedLegacy} ` +
        `recordOnly=${stats.recordOnly} manualCash=${stats.manualCash} ` +
        `ambiguous=${stats.ambiguous} failed=${stats.failed}`
    );
  }
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  const filterUserId = args.find((a) => !a.startsWith("--")) || undefined;
  const dryRun = args.includes("--dry-run");

  if (dryRun) {
    console.log("[backfill] DRY-RUN: nothing will be written.\n");
  }

  const userIds = filterUserId
    ? [{ id: filterUserId }]
    : await db.select({ id: users.id }).from(users).execute();

  const summary = {
    totalRows: 0,
    alreadyMirrored: 0,
    linkedLegacy: 0,
    recordOnly: 0,
    manualCash: 0,
    ambiguous: 0,
    failed: 0,
  };

  for (const { id } of userIds) {
    try {
      const result = await backfillUser(id, dryRun);
      summary.totalRows += result.totalRows;
      summary.alreadyMirrored += result.alreadyMirrored;
      summary.linkedLegacy += result.linkedLegacy;
      summary.recordOnly += result.recordOnly;
      summary.manualCash += result.manualCash;
      summary.ambiguous += result.ambiguous;
      summary.failed += result.failed;
    } catch (error) {
      console.error(`[backfill] user=${id} FAILED`, error);
      summary.failed++;
    }
  }

  console.log(
    `\n[backfill] done${dryRun ? " (DRY-RUN)" : ""}. ` +
      `totalRows=${summary.totalRows} alreadyMirrored=${summary.alreadyMirrored} ` +
      `linkedLegacy=${summary.linkedLegacy} recordOnly=${summary.recordOnly} ` +
      `manualCash=${summary.manualCash} ambiguous=${summary.ambiguous} failed=${summary.failed}`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});