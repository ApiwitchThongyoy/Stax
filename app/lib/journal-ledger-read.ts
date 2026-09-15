// Journal-as-SSOT read layer (Phase 2): serves the "capital ledger" screens
// FROM the journal instead of recomputing from Capital_Transactions.
//
// The journal_entries table is now the complete, authoritative record of every
// transaction: statement imports write one entry per row (POSTED with posting
// lines, or SKIPPED with zero lines), and manual cash entries are journaled
// too. Every such journal entry carries the FULL source-row trade detail plus
// the linked Capital_Transactions.transaction_id in source_transaction_id.
//
// These helpers SELECT that 1:1 subset (source_transaction_id IS NOT NULL) and
// reconstruct the exact Capital_Transactions-shaped row the consumers already
// expect, so the API contracts and the frontend stay unchanged while the values
// now come straight from the journal.
import { and, asc, eq, or, sql } from "drizzle-orm";
import { db } from "./drizzle-db";
import { journalEntries } from "../db/schema";

/**
 * The journal columns needed to reconstruct a Capital_Transactions-equivalent
 * row. Numeric Drizzle columns are strings; matches the persisted trade-detail
 * columns on journal_entries (migration 0020).
 */
export interface CapitalJournalRecord {
  sourceTransactionId: string | null;
  userId: string;
  entryDate: string;
  sourceType: string;
  sourceDocumentId: string | null;
  category: string | null;
  section: string | null;
  symbol: string | null;
  side: string | null;
  exchange: string | null;
  quantity: string | null;
  unitPrice: string | null;
  grossAmount: string | null;
  fees: string | null;
  netAmount: string | null;
  proceeds: string | null;
  costBasis: string | null;
  realizedGainLoss: string | null;
  realizedGainLossThb: string | null;
  currency: string | null;
  amount: string | null;
  amountThb: string | null;
  fxRateEffective: string | null;
  fxRateStatement: string | null;
  isFxConversion: boolean;
  exchangeFromCurrency: string | null;
  exchangeFromAmount: string | null;
  exchangeRate: string | null;
  postingState: string | null;
  skipReason: string | null;
  type: string | null;
  /** Investor's own note on this entry (nullable free text, endpoint-written). */
  note: string | null;
}

/**
 * Pure mapper: a journal entry with source_transaction_id -> the exact
 * Capital_Transactions row shape the ledger/cash/portfolio consumers render.
 * DB-free and deterministic (Thal string values pass through verbatim, no
 * arithmetic, no invented FX rates).
 */
export function journalEntryToCapitalRow(e: CapitalJournalRecord) {
  return {
    transactionId: e.sourceTransactionId ?? "",
    userId: e.userId,
    amountForeign: e.amount,
    currency: e.currency,
    transactionDate: e.entryDate,
    fxRateBot: null,
    amountThb: e.amountThb,
    type: e.type,
    sourceType: e.sourceType === "MANUAL" ? "MANUAL" : "AI_PARSED",
    sourceDocumentId: e.sourceDocumentId,
    category: e.category,
    section: e.section,
    symbol: e.symbol,
    side: e.side,
    quantity: e.quantity,
    unitPrice: e.unitPrice,
    grossAmount: e.grossAmount,
    fees: e.fees,
    netAmount: e.netAmount,
    proceeds: e.proceeds,
    costBasis: e.costBasis,
    realizedGainLoss: e.realizedGainLoss,
    realizedGainLossThb: e.realizedGainLossThb,
    fxRateStatement: e.fxRateStatement,
    fxRateEffective: e.fxRateEffective,
    exchange: e.exchange,
    exchangeFromCurrency: e.exchangeFromCurrency,
    exchangeFromAmount: e.exchangeFromAmount,
    exchangeRate: e.exchangeRate,
  };
}

const CAPITAL_JOURNAL_COLUMNS = {
  sourceTransactionId: journalEntries.sourceTransactionId,
  userId: journalEntries.userId,
  entryDate: journalEntries.entryDate,
  sourceType: journalEntries.sourceType,
  sourceDocumentId: journalEntries.sourceDocumentId,
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
  currency: journalEntries.currency,
  amount: journalEntries.amount,
  amountThb: journalEntries.amountThb,
  fxRateEffective: journalEntries.fxRateEffective,
  fxRateStatement: journalEntries.fxRateStatement,
  isFxConversion: journalEntries.isFxConversion,
  exchangeFromCurrency: journalEntries.exchangeFromCurrency,
  exchangeFromAmount: journalEntries.exchangeFromAmount,
  exchangeRate: journalEntries.exchangeRate,
  postingState: journalEntries.postingState,
  skipReason: journalEntries.skipReason,
  type: journalEntries.type,
  note: journalEntries.note,
};

/**
 * The user's full capital ledger, read from the journal: every entry that is
 * backed by a Capital_Transactions row (source_transaction_id set), oldest
 * entry first — the same rows the ledger screens show today.
 */
export async function listCapitalLedgerRows(
  userId: string
): Promise<CapitalJournalRecord[]> {
  return (await db
    .select(CAPITAL_JOURNAL_COLUMNS)
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, userId),
        sql`${journalEntries.sourceTransactionId} IS NOT NULL`
      )
    )
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.entryNo))
    .execute()) as CapitalJournalRecord[];
}

/** Single ledger row by its Capital_Transactions id (ownership-scoped). */
export async function getCapitalLedgerRow(
  userId: string,
  transactionId: string
): Promise<CapitalJournalRecord | null> {
  const rows = (await db
    .select(CAPITAL_JOURNAL_COLUMNS)
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, userId),
        eq(journalEntries.sourceTransactionId, transactionId)
      )
    )
    .limit(1)
    .execute()) as CapitalJournalRecord[];
  return rows[0] ?? null;
}

/** Ledger rows of one source document (the "statements of the day" view). */
export async function listCapitalLedgerRowsByDocument(
  userId: string,
  sourceDocumentId: string
): Promise<CapitalJournalRecord[]> {
  return (await db
    .select(CAPITAL_JOURNAL_COLUMNS)
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, userId),
        eq(journalEntries.sourceDocumentId, sourceDocumentId)
      )
    )
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.entryNo))
    .execute()) as CapitalJournalRecord[];
}

/** Ledger rows of one symbol (per-stock detail screen). */
export async function listCapitalLedgerRowsBySymbol(
  userId: string,
  symbol: string
): Promise<CapitalJournalRecord[]> {
  return (await db
    .select(CAPITAL_JOURNAL_COLUMNS)
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, userId),
        eq(journalEntries.symbol, symbol),
        eq(journalEntries.status, "POSTED")
      )
    )
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.entryNo))
    .execute()) as CapitalJournalRecord[];
}

/**
 * Equity-money-movement rows for the cash in/out summary, read from the journal
 * with EXACTLY the current Capital_Transactions semantics: category 'equity'
 * (AI-parsed deposits/withdrawals + manual cash rows) OR legacy sourceType
 * 'MANUAL', and only entries that are backed by a capital transaction (so
 * general-ledger manual journal entries that were never a ledger row are NOT
 * pulled in). The pure aggregator then applies the month/asOf/type filters.
 */
export async function listCashSummaryRows(
  userId: string
): Promise<CapitalJournalRecord[]> {
  return (await db
    .select(CAPITAL_JOURNAL_COLUMNS)
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, userId),
        sql`${journalEntries.sourceTransactionId} IS NOT NULL`,
        or(
          eq(journalEntries.category, "equity"),
          eq(journalEntries.sourceType, "MANUAL")
        )
      )
    )
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.entryNo))
    .execute()) as CapitalJournalRecord[];
}

/**
 * Currency-exchange rows for a user, read from the journal (SSOT). These are
 * STATEMENT rows the parser tagged category 'asset' with no side
 * (is_fx_conversion), recorded in the journal as SKIPPED entries but carrying
 * the full exchange detail — the cash page shows them in their own section,
 * never mixed into the equity money-movement totals. Ordered chronologically.
 */
export async function listFxConversionRows(
  userId: string
): Promise<CapitalJournalRecord[]> {
  return (await db
    .select(CAPITAL_JOURNAL_COLUMNS)
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, userId),
        sql`${journalEntries.sourceTransactionId} IS NOT NULL`,
        eq(journalEntries.isFxConversion, true)
      )
    )
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.entryNo))
    .execute()) as CapitalJournalRecord[];
}