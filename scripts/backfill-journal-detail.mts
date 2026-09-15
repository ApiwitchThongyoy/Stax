// Journal-detail backfill: restore the trade-detail columns on legacy journal
// entries so journal-as-SSOT reads see the same rows Capital_Transactions has.
//
// Context: migration 0020 added the trade-detail columns to journal_entries and
// journal reads (trading journal, per-stock portfolio, document transactions,
// capital ledger) classify/render rows from them. Journal entries created BEFORE
// those columns existed (legacy GL postings, now linked to Capital_Transactions
// rows by the Phase 3 backfill) still carry NULL in side/category/section/...,
// so every one of those rows silently drops out of scope-filtered reads —
// notably the trading journal ("สมุดบันทึกการซื้อขาย"), which admits only
// BUY/SELL/dividend rows and showed ZERO entries on real data.
//
// This script repairs exactly that gap: for every journal entry that has a
// source_transaction_id link to a still-existing Capital_Transactions row, it
// copies the capital row's trade detail (via journalDetailOf — the same pure
// mapper statement imports use) onto the entry's detail columns. It NEVER
// touches posting lines, amounts, dates, descriptions, document links, status,
// postingState, skipReason or notes — the GL stays exactly as balanced.
//
// Safe to re-run: entries whose detail already matches are no-ops. Orphaned
// entries (source link points at a deleted capital row) are skipped — there is
// no authoritative detail to restore from.
//
// Run:  npx tsx scripts/backfill-journal-detail.mts [userId] [--dry-run]
import "dotenv/config";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../app/lib/drizzle-db";
import {
  capitalTransactions,
  journalEntries,
  users,
} from "../app/db/schema";
import { journalDetailOf } from "../app/lib/posting-engine";
import type {
  ParsedCapitalType,
  ValidatedCapitalRow,
} from "../app/lib/statement-pipeline";

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

// Same reconstruction the Phase 3 backfill uses: BUY/SELL pass through,
// anything else becomes null (income/expense/equity/FX rows legitimately
// carry no journal side).
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

type DetailKey =
  | "category"
  | "section"
  | "symbol"
  | "side"
  | "exchange"
  | "quantity"
  | "unitPrice"
  | "grossAmount"
  | "fees"
  | "netAmount"
  | "proceeds"
  | "costBasis"
  | "realizedGainLoss"
  | "realizedGainLossThb"
  | "currency"
  | "amount"
  | "amountThb"
  | "fxRateEffective"
  | "fxRateStatement"
  | "exchangeFromCurrency"
  | "exchangeFromAmount"
  | "exchangeRate";

const DETAIL_KEYS: DetailKey[] = [
  "category",
  "section",
  "symbol",
  "side",
  "exchange",
  "quantity",
  "unitPrice",
  "grossAmount",
  "fees",
  "netAmount",
  "proceeds",
  "costBasis",
  "realizedGainLoss",
  "realizedGainLossThb",
  "currency",
  "amount",
  "amountThb",
  "fxRateEffective",
  "fxRateStatement",
  "exchangeFromCurrency",
  "exchangeFromAmount",
  "exchangeRate",
];

/** NULL, undefined and "" all mean "no stored detail" — never count as a change. */
function norm(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const t = value.trim();
  return t === "" ? null : t;
}

  // detail (trade fields only); identity, money postings, dates, links,
// status, notes are never touched.
type DetailPatch = {
  [K in DetailKey]?: string | null;
} & {
  averageCost?: string | null;
  isFxConversion?: boolean;
  type?: string | null;
  updatedAt: string;
};

async function backfillUser(
  userId: string,
  dryRun: boolean
): Promise<{
  linkedEntries: number;
  alreadyComplete: number;
  detailFilled: number;
  orphaned: number;
}> {
  const stats = {
    linkedEntries: 0,
    alreadyComplete: 0,
    detailFilled: 0,
    orphaned: 0,
  };

  const entries = await db
    .select({
      id: journalEntries.id,
      sourceTransactionId: journalEntries.sourceTransactionId,
      type: journalEntries.type,
      category: journalEntries.category,
      section: journalEntries.section,
      symbol: journalEntries.symbol,
      side: journalEntries.side,
      exchange: journalEntries.exchange,
      quantity: journalEntries.quantity,
      unitPrice: journalEntries.unitPrice,
      grossAmount: journalEntries.grossAmount,
      fees: journalEntries.fees,
      netAmount: journalEntries.netAmount,
      proceeds: journalEntries.proceeds,
      costBasis: journalEntries.costBasis,
      realizedGainLoss: journalEntries.realizedGainLoss,
      realizedGainLossThb: journalEntries.realizedGainLossThb,
      averageCost: journalEntries.averageCost,
      currency: journalEntries.currency,
      amount: journalEntries.amount,
      amountThb: journalEntries.amountThb,
      fxRateEffective: journalEntries.fxRateEffective,
      fxRateStatement: journalEntries.fxRateStatement,
      isFxConversion: journalEntries.isFxConversion,
      exchangeFromCurrency: journalEntries.exchangeFromCurrency,
      exchangeFromAmount: journalEntries.exchangeFromAmount,
      exchangeRate: journalEntries.exchangeRate,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, userId),
        isNotNull(journalEntries.sourceTransactionId)
      )
    )
    .execute();
  stats.linkedEntries = entries.length;
  if (entries.length === 0) return stats;

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
    .execute()) as CapitalRowLike[];
  const capById = new Map(capRows.map((r) => [r.transactionId, r]));

  for (const entry of entries) {
    const txId = entry.sourceTransactionId;
    if (!txId) continue;
    const cap = capById.get(txId);
    if (!cap) {
      // The source row was deleted — nothing authoritative to restore from.
      stats.orphaned++;
      continue;
    }
    const detail = journalDetailOf(rowToValidated(cap));

    const patch: DetailPatch = { updatedAt: new Date().toISOString() };
    let changed = false;
    for (const key of DETAIL_KEYS) {
      const want = norm(detail[key]);
      const have = norm(entry[key]);
      if (want !== have) {
        patch[key] = want;
        changed = true;
      }
    }
    // averageCost is part of the stored detail (SELL basis ÷ qty, import-time
    // derived). isFxConversion is derived the same way imports derive it.
    if (norm(detail.averageCost) !== norm(entry.averageCost)) {
      patch.averageCost = norm(detail.averageCost);
      changed = true;
    }
    if ((entry.isFxConversion ?? false) !== detail.isFxConversion) {
      patch.isFxConversion = detail.isFxConversion;
      changed = true;
    }
    // The capital type (CASH_IN/CASH_OUT) is part of the SSOT record; fill it
    // only when the entry has none so general-ledger manual rows are untouched
    // (they carry no source link and never reach this loop anyway).
    if (entry.type === null && cap.type !== null) {
      patch.type = cap.type;
      changed = true;
    }

    if (!changed) {
      stats.alreadyComplete++;
      continue;
    }
    if (!dryRun) {
      await db
        .update(journalEntries)
        .set(patch)
        .where(eq(journalEntries.id, entry.id))
        .execute();
    }
    stats.detailFilled++;
  }

  console.log(
    `[backfill-detail] user=${userId} linked=${stats.linkedEntries} ` +
      `complete=${stats.alreadyComplete} filled=${stats.detailFilled} ` +
      `orphaned=${stats.orphaned}`
  );
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  const filterUserId = args.find((a) => !a.startsWith("--")) || undefined;
  const dryRun = args.includes("--dry-run");

  if (dryRun) {
    console.log("[backfill-detail] DRY-RUN: nothing will be written.\n");
  }

  // Sequential per-user updates; the per-entry UPDATE touches only the
  // trade-detail columns, never posting lines, amounts or identity fields.

  const userIds = filterUserId
    ? [{ id: filterUserId }]
    : await db.select({ id: users.id }).from(users).execute();

  const summary = {
    linkedEntries: 0,
    alreadyComplete: 0,
    detailFilled: 0,
    orphaned: 0,
  };

  for (const { id } of userIds) {
    try {
      const r = await backfillUser(id, dryRun);
      summary.linkedEntries += r.linkedEntries;
      summary.alreadyComplete += r.alreadyComplete;
      summary.detailFilled += r.detailFilled;
      summary.orphaned += r.orphaned;
    } catch (error) {
      console.error(`[backfill-detail] user=${id} FAILED`, error);
    }
  }

  console.log(
    `\n[backfill-detail] done${dryRun ? " (DRY-RUN)" : ""}. ` +
      `linkedEntries=${summary.linkedEntries} ` +
      `alreadyComplete=${summary.alreadyComplete} ` +
      `detailFilled=${summary.detailFilled} orphaned=${summary.orphaned}`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
