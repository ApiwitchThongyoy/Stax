// General-ledger database service.
//
// Persists accounts/journal entries/lines and builds the pure-engine reports
// from rows that are always scoped to the authenticated user. Every money value
// is stored as a decimal string; the pure engine (general-ledger.ts) stays
// entirely framework/DB-free so all invariants are tested without a database.
import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, lte, max, sql, type SQL } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "./drizzle-db";
import {
  accounts,
  capitalTransactions,
  journalEntries,
  journalEntryLines,
} from "../db/schema";
import {
  DEFAULT_CHART_OF_ACCOUNTS,
  balanceSheet,
  buildReversal,
  emptyTradeDetail,
  incomeStatement,
  summarizeLinesBySymbol,
  trialBalance,
  validateJournalEntry,
  type AccountMap,
  type BalanceSheetRow,
  type JournalEntryInput,
  type JournalLineInput,
  type JournalTradeDetail,
  type LedgerSymbolSummary,
  type PostingState,
  type Side,
  type ValidatedJournalEntry,
} from "./general-ledger";
import { buildStatementJournalEntries } from "./posting-engine";
import type { ValidatedCapitalRow } from "./statement-pipeline";

Decimal.set({ precision: 40 });

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

/** Idempotent: seeds the default CoA once, leaving existing rows untouched. */
export async function seedDefaultChartOfAccounts(userId: string): Promise<number> {
  const existing = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .limit(1)
    .execute();
  if (existing.length > 0) return existing.length;

  const now = new Date().toISOString();
  const values = DEFAULT_CHART_OF_ACCOUNTS.map((acc) => ({
    id: randomUUID(),
    userId,
    code: acc.code,
    name: acc.name,
    type: acc.type,
    currency: acc.currency,
    openingBalance: null,
    parentId: null,
    createdAt: now,
    updatedAt: now,
  }));
  if (values.length === 0) return 0;
  await db.insert(accounts).values(values).execute();
  return values.length;
}

export interface AccountRow {
  id: string;
  userId: string;
  code: string;
  name: string;
  type: string;
  currency: string;
  parentId: string | null;
  openingBalance: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toAccountMap(rows: AccountRow[]): AccountMap {
  const map: AccountMap = {};
  for (const r of rows) {
    const type = r.type;
    if (
      type !== "ASSET" &&
      type !== "LIABILITY" &&
      type !== "EQUITY" &&
      type !== "INCOME" &&
      type !== "EXPENSE"
    ) {
      continue;
    }
    map[r.id] = { code: r.code, name: r.name, type, currency: r.currency };
  }
  return map;
}

export async function getAccounts(userId: string): Promise<AccountRow[]> {
  return (await db
    .select()
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .orderBy(asc(accounts.code))
    .execute()) as AccountRow[];
}

export async function getActiveAccounts(userId: string): Promise<AccountRow[]> {
  return (await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.isActive, true)))
    .orderBy(asc(accounts.code))
    .execute()) as AccountRow[];
}

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------

export interface PersistedJournalLine {
  id: string;
  journalEntryId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  currency: string;
  side: Side;
  amount: string;
  amountThb: string;
  fxRateEffective: string;
  fxRateStatement: string | null;
  fxRateProvider: string | null;
  memo: string | null;
}

export interface PersistedJournalEntry {
  id: string;
  entryNo: number;
  entryDate: string;
  description: string;
  sourceType: string;
  sourceDocumentId: string | null;
  sourceTransactionId: string | null;
  status: string;
  createdAt: string;
  postingState: PostingState;
  skipReason: string | null;
  detail: {
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
    averageCost: string | null;
    currency: string | null;
    amount: string | null;
    amountThb: string | null;
    fxRateEffective: string | null;
    fxRateStatement: string | null;
    isFxConversion: boolean;
  };
  lines: PersistedJournalLine[];
}

export type CreateEntryResult =
  | { ok: true; entryId: string; entryNo: number }
  | { ok: false; errors: string[] };

interface ResolvedAccount {
  id: string;
  code: string;
  currency: string;
}

/**
 * Build a lookup over the user's ACTIVE accounts keyed by BOTH account id and
 * account code. Statement postings reference accounts by code (the posting
 * engine is pure/DB-free), manual entries reference them by id; this one map
 * accepts either and normalizes to the UUID `account_id` the schema requires.
 */
async function loadAccountLookup(userId: string): Promise<Map<string, ResolvedAccount>> {
  const rows = await getActiveAccounts(userId);
  const map = new Map<string, ResolvedAccount>();
  for (const r of rows) {
    const resolved = { id: r.id, code: r.code, currency: r.currency };
    map.set(r.id, resolved);
    map.set(r.code, resolved);
  }
  return map;
}

/**
 * Rewrite an entry's lines so each `accountId` (code OR id) resolves to the
 * user's real account UUID, failing cleanly on unknown/inactive accounts. Never
 * throws — returns structured errors like the pure validator does.
 */
function resolveEntryAccountIds(
  input: JournalEntryInput,
  lookup: Map<string, ResolvedAccount>
): { ok: true; lines: JournalLineInput[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const lines: JournalLineInput[] = input.lines.map((line, i) => {
    const ref = (line.accountId ?? "").trim();
    const account = lookup.get(ref);
    if (!account) {
      errors.push(`line[${i}]: unknown account ${JSON.stringify(ref)}`);
      return line;
    }
    return { ...line, accountId: account.id };
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, lines };
}

async function nextEntryNo(userId: string): Promise<number> {
  const [{ value }] = await db
    .select({ value: max(journalEntries.entryNo) })
    .from(journalEntries)
    .where(eq(journalEntries.userId, userId))
    .execute();
  return (value ?? 0) + 1;
}

/** Persist one validated entry with its lines inside a transaction. */
export async function createJournalEntry(
  userId: string,
  input: JournalEntryInput
): Promise<CreateEntryResult> {
  let lookup = await loadAccountLookup(userId);
  // Existing users who registered before the default chart-of-accounts seeder
  // existed have no accounts yet. Lazy-seed once (idempotent) so their first
  // manual entry and statement postings work instead of failing "unknown account".
  if (lookup.size === 0) {
    const seeded = await seedDefaultChartOfAccounts(userId);
    if (seeded > 0) lookup = await loadAccountLookup(userId);
  }
  const resolved = resolveEntryAccountIds(input, lookup);
  if (!resolved.ok) {
    return { ok: false, errors: resolved.errors };
  }

  const validated = validateJournalEntry({
    ...input,
    lines: resolved.lines,
  });
  if (!validated.ok) {
    return { ok: false, errors: validated.errors };
  }

  // Account currency must match the line's currency. A THB deposit into the
  // USD owner-capital account (3010) is rejected here rather than silently
  // corrupting per-account currency consistency; the statement posting engine
  // skips such entries gracefully and the import itself still succeeds.
  const currencyErrors: string[] = [];
  validated.entry.lines.forEach((line, i) => {
    const account = lookup.get(line.accountId);
    if (!account) {
      currencyErrors.push(`line[${i}]: unknown account ${JSON.stringify(line.accountId)}`);
      return;
    }
    if (account.currency !== line.currency) {
      currencyErrors.push(
        `line[${i}]: account ${account.code} is ${account.currency}-denominated but the line is ${line.currency}`
      );
    }
  });
  if (currencyErrors.length > 0) {
    return { ok: false, errors: currencyErrors };
  }

  const entry = validated.entry;
  const entryId = randomUUID();
  const now = new Date().toISOString();

  try {
    await db.transaction(async (tx) => {
      const entryNo = await nextEntryNo(userId);
      await tx
        .insert(journalEntries)
        .values({
          id: entryId,
          userId,
          entryNo,
          entryDate: entry.entryDate,
          description: entry.description,
          sourceType: entry.sourceType,
          sourceDocumentId: entry.sourceDocumentId,
          sourceTransactionId: entry.sourceTransactionId,
          status: "POSTED",
          category: entry.detail.category,
          section: entry.detail.section,
          symbol: entry.detail.symbol,
          side: entry.detail.side,
          exchange: entry.detail.exchange,
          quantity: entry.detail.quantity,
          unitPrice: entry.detail.unitPrice,
          grossAmount: entry.detail.grossAmount,
          fees: entry.detail.fees,
          netAmount: entry.detail.netAmount,
          proceeds: entry.detail.proceeds,
          costBasis: entry.detail.costBasis,
          realizedGainLoss: entry.detail.realizedGainLoss,
          realizedGainLossThb: entry.detail.realizedGainLossThb,
          averageCost: entry.detail.averageCost,
          currency: entry.detail.currency,
          amount: entry.detail.amount,
          amountThb: entry.detail.amountThb,
          fxRateEffective: entry.detail.fxRateEffective,
          fxRateStatement: entry.detail.fxRateStatement,
          isFxConversion: entry.detail.isFxConversion,
          exchangeFromCurrency: entry.detail.exchangeFromCurrency,
          exchangeFromAmount: entry.detail.exchangeFromAmount,
          exchangeRate: entry.detail.exchangeRate,
          postingState: entry.postingState,
          skipReason: entry.skipReason,
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      for (const line of entry.lines) {
        await tx
          .insert(journalEntryLines)
          .values({
            id: randomUUID(),
            journalEntryId: entryId,
            userId,
            accountId: line.accountId,
            currency: line.currency,
            debitAmount: line.side === "DEBIT" ? line.amount : null,
            creditAmount: line.side === "CREDIT" ? line.amount : null,
            amountThb: line.amountThb,
            fxRateEffective: line.fxRateEffective,
            fxRateStatement: line.fxRateStatement,
            fxRateProvider: line.fxRateProvider,
            memo: line.memo,
          })
          .execute();
      }
    });
  } catch (error) {
    console.error("createJournalEntry: failed to persist entry", error);
    return { ok: false, errors: ["Failed to persist journal entry"] };
  }

  const entryNo =
    (await db
      .select({ entryNo: journalEntries.entryNo })
      .from(journalEntries)
      .where(eq(journalEntries.id, entryId))
      .execute())[0]?.entryNo ?? 0;

  return { ok: true, entryId, entryNo };
}

/** Bulk-persist already-validated entries (statement import). Best-effort: a
 *  failing entry is skipped and reported, never aborting the others. */
export async function insertPostings(
  userId: string,
  entries: JournalEntryInput[]
): Promise<{
  postedCount: number;
  entryNumbers: number[];
  skipped: { description: string; errors: string[] }[];
}> {
  const entryNumbers: number[] = [];
  const skipped: { description: string; errors: string[] }[] = [];
  for (const input of entries) {
    if (input.lines.length === 0) {
      skipped.push({ description: input.description, errors: ["entry has no lines"] });
      continue;
    }
    const result = await createJournalEntry(userId, input);
    if (!result.ok) {
      skipped.push({ description: input.description, errors: result.errors });
      continue;
    }
    entryNumbers.push(result.entryNo);
  }
  return { postedCount: entryNumbers.length, entryNumbers, skipped };
}

// ---------------------------------------------------------------------------
// Journal-as-SSOT: keep the manual capital-ledger rows mirrored in the journal
// ---------------------------------------------------------------------------

const MANUAL_CASH_THB = "1010";
const MANUAL_CASH_USD = "1020";
const MANUAL_EQUITY_CAPITAL = "3010";

export interface ManualCashJournalInput {
  transactionId: string;
  type: "CASH_IN" | "CASH_OUT";
  amountForeign: string;
  currency: string;
  transactionDate: string;
  fxRateEffective: string;
  amountThb: string;
}

function manualCashLines(
  input: { type: "CASH_IN" | "CASH_OUT"; amountForeign: string; currency: string; fxRateEffective: string }
): JournalLineInput[] {
  const cash = input.currency === "THB" ? MANUAL_CASH_THB : MANUAL_CASH_USD;
  const fx = input.fxRateEffective || "1";
  const line = (accountId: string, side: "debit" | "credit"): JournalLineInput => {
    const base: JournalLineInput = {
      accountId,
      currency: input.currency,
      fxRateEffective: fx,
      fxRateStatement: null,
      memo: null,
    };
    if (side === "debit") base.debit = input.amountForeign;
    else base.credit = input.amountForeign;
    return base;
  };
  // CASH_IN: money into broker cash (Dr cash / Cr owner equity).
  // CASH_OUT: money out of broker cash (Cr cash / Dr owner equity).
  return input.type === "CASH_IN"
    ? [line(cash, "debit"), line(MANUAL_EQUITY_CAPITAL, "credit")]
    : [line(MANUAL_EQUITY_CAPITAL, "debit"), line(cash, "credit")];
}

function manualCashDetail(
  input: ManualCashJournalInput
): JournalTradeDetail {
  return {
    category: "equity",
    section: null,
    symbol: null,
    side: null,
    exchange: null,
    quantity: null,
    unitPrice: null,
    grossAmount: null,
    fees: null,
    netAmount: null,
    proceeds: null,
    costBasis: null,
    realizedGainLoss: null,
    realizedGainLossThb: null,
    averageCost: null,
    currency: input.currency,
    amount: input.amountForeign,
    amountThb: input.amountThb,
    fxRateEffective: input.fxRateEffective || "1",
    fxRateStatement: null,
    isFxConversion: false,
    exchangeFromCurrency: null,
    exchangeFromAmount: null,
    exchangeRate: null,
  };
}

/**
 * Create the journal entry that mirrors a manual capital-ledger cash row
 * (POST /api/v1/capital-ledgers). The journal is the Single Source of Truth;
 * every screen reads it, so manual rows MUST be journaled too or they would
 * vanish from the ledger/cash views. Best-effort: returns the standard
 * CreateEntryResult; the route reports failures without aborting the insert.
 */
export async function insertManualCashJournal(
  userId: string,
  input: ManualCashJournalInput
): Promise<CreateEntryResult> {
  let lookup = await loadAccountLookup(userId);
  if (lookup.size === 0) {
    const seeded = await seedDefaultChartOfAccounts(userId);
    if (seeded > 0) lookup = await loadAccountLookup(userId);
  }
  const entryInput: JournalEntryInput = {
    entryDate: input.transactionDate,
    description:
      input.type === "CASH_IN" ? "ฝากเงินเข้าบัญชี" : "ถอนเงินจากบัญชี",
    sourceType: "MANUAL",
    sourceTransactionId: input.transactionId,
    lines: manualCashLines(input),
    postingState: "POSTED",
    skipReason: null,
    detail: manualCashDetail(input),
  };
  const resolved = resolveEntryAccountIds(entryInput, lookup);
  if (!resolved.ok) {
    return { ok: false, errors: resolved.errors };
  }
  const validated = validateJournalEntry({
    ...entryInput,
    lines: resolved.lines,
  });
  if (!validated.ok) {
    return { ok: false, errors: validated.errors };
  }

  const entry = validated.entry;
  const entryId = randomUUID();
  const now = new Date().toISOString();
  try {
    await db.transaction(async (tx) => {
      const entryNo = await nextEntryNo(userId);
      await tx
        .insert(journalEntries)
        .values({
          id: entryId,
          userId,
          entryNo,
          entryDate: entry.entryDate,
          description: entry.description,
          sourceType: entry.sourceType,
          sourceDocumentId: entry.sourceDocumentId,
          sourceTransactionId: entry.sourceTransactionId,
          status: "POSTED",
          category: entry.detail.category,
          section: entry.detail.section,
          symbol: entry.detail.symbol,
          side: entry.detail.side,
          exchange: entry.detail.exchange,
          quantity: entry.detail.quantity,
          unitPrice: entry.detail.unitPrice,
          grossAmount: entry.detail.grossAmount,
          fees: entry.detail.fees,
          netAmount: entry.detail.netAmount,
          proceeds: entry.detail.proceeds,
          costBasis: entry.detail.costBasis,
          realizedGainLoss: entry.detail.realizedGainLoss,
          realizedGainLossThb: entry.detail.realizedGainLossThb,
          averageCost: entry.detail.averageCost,
          currency: entry.detail.currency,
          amount: entry.detail.amount,
          amountThb: entry.detail.amountThb,
          fxRateEffective: entry.detail.fxRateEffective,
          fxRateStatement: entry.detail.fxRateStatement,
          isFxConversion: entry.detail.isFxConversion,
          exchangeFromCurrency: entry.detail.exchangeFromCurrency,
          exchangeFromAmount: entry.detail.exchangeFromAmount,
          exchangeRate: entry.detail.exchangeRate,
          postingState: entry.postingState,
          skipReason: entry.skipReason,
          type: input.type,
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      for (const line of entry.lines) {
        await tx
          .insert(journalEntryLines)
          .values({
            id: randomUUID(),
            journalEntryId: entryId,
            userId,
            accountId: line.accountId,
            currency: line.currency,
            debitAmount: line.side === "DEBIT" ? line.amount : null,
            creditAmount: line.side === "CREDIT" ? line.amount : null,
            amountThb: line.amountThb,
            fxRateEffective: line.fxRateEffective,
            fxRateStatement: line.fxRateStatement,
            fxRateProvider: line.fxRateProvider,
            memo: line.memo,
          })
          .execute();
      }
    });
  } catch (error) {
    console.error("insertManualCashJournal: failed to persist entry", error);
    return { ok: false, errors: ["Failed to persist journal entry"] };
  }
  const entryNo =
    (await db
      .select({ entryNo: journalEntries.entryNo })
      .from(journalEntries)
      .where(eq(journalEntries.id, entryId))
      .execute())[0]?.entryNo ?? 0;
  return { ok: true, entryId, entryNo };
}

export interface BackfilledJournalEntryInput {
  entryDate: string;
  description: string;
  sourceType: string;
  sourceDocumentId: string | null;
  sourceTransactionId: string;
  type: string | null;
  postingState: PostingState;
  skipReason: string | null;
  detail: JournalTradeDetail;
}

/**
 * Backfill a SINGLE legacy Capital_Transactions row into the journal (Phase 3)
 * as a SKIPPED, line-less mirror record: the journal is the complete daybook of
 * every committed row, but the GL postings for pre-journal-as-SSOT rows are
 * either already present as their own (unlinked) entries or deliberately left
 * untouched — no posting lines are ever invented here. Always inserts with
 * status 'POSTED' (an active/committed record) and postingState 'SKIPPED'
 * (no posting lines), exactly like statement-import SKIPPED rows. Best-effort.
 */
export async function insertBackfilledJournalEntry(
  userId: string,
  input: BackfilledJournalEntryInput
): Promise<CreateEntryResult> {
  const validated = validateJournalEntry({
    entryDate: input.entryDate,
    description: input.description,
    sourceType: input.sourceType === "MANUAL" ? "MANUAL" : "STATEMENT",
    sourceDocumentId: input.sourceDocumentId,
    sourceTransactionId: input.sourceTransactionId,
    lines: [],
    postingState: "SKIPPED",
    skipReason: input.skipReason ?? "backfilled-record-only",
    detail: input.detail,
  });
  if (!validated.ok) {
    return { ok: false, errors: validated.errors };
  }

  const entry = validated.entry;
  const entryId = randomUUID();
  const now = new Date().toISOString();
  try {
    await db.transaction(async (tx) => {
      const entryNo = await nextEntryNo(userId);
      await tx
        .insert(journalEntries)
        .values({
          id: entryId,
          userId,
          entryNo,
          entryDate: entry.entryDate,
          description: entry.description,
          sourceType: entry.sourceType,
          sourceDocumentId: entry.sourceDocumentId,
          sourceTransactionId: entry.sourceTransactionId,
          status: "POSTED",
          category: entry.detail.category,
          section: entry.detail.section,
          symbol: entry.detail.symbol,
          side: entry.detail.side,
          exchange: entry.detail.exchange,
          quantity: entry.detail.quantity,
          unitPrice: entry.detail.unitPrice,
          grossAmount: entry.detail.grossAmount,
          fees: entry.detail.fees,
          netAmount: entry.detail.netAmount,
          proceeds: entry.detail.proceeds,
          costBasis: entry.detail.costBasis,
          realizedGainLoss: entry.detail.realizedGainLoss,
          realizedGainLossThb: entry.detail.realizedGainLossThb,
          averageCost: entry.detail.averageCost,
          currency: entry.detail.currency,
          amount: entry.detail.amount,
          amountThb: entry.detail.amountThb,
          fxRateEffective: entry.detail.fxRateEffective,
          fxRateStatement: entry.detail.fxRateStatement,
          isFxConversion: entry.detail.isFxConversion,
          exchangeFromCurrency: entry.detail.exchangeFromCurrency,
          exchangeFromAmount: entry.detail.exchangeFromAmount,
          exchangeRate: entry.detail.exchangeRate,
          postingState: entry.postingState,
          skipReason: entry.skipReason,
          type: input.type,
          createdAt: now,
          updatedAt: now,
        })
        .execute();
    });
  } catch (error) {
    console.error("insertBackfilledJournalEntry: failed to persist entry", error);
    return { ok: false, errors: ["Failed to persist journal entry"] };
  }
  const entryNo =
    (await db
      .select({ entryNo: journalEntries.entryNo })
      .from(journalEntries)
      .where(eq(journalEntries.id, entryId))
      .execute())[0]?.entryNo ?? 0;
  return { ok: true, entryId, entryNo };
}

/**
 * Sync the linked journal entry when a capital-ledger row is edited (PUT).
 * Updates the money/date/currency/type header fields so every journal-based
 * read stays fresh, and rebuilds the two-line equity entry (cash + owner
 * equity) so the manual rows and the cash summary stay correct. Statement
 * multi-leg entries keep their original posting lines untouched (the GL remains
 * balanced; only the header detail is refreshed). Best-effort: never throws.
 */
export async function syncCapitalLedgerJournal(
  userId: string,
  transactionId: string,
  current: ManualCashJournalInput
): Promise<void> {
  try {
    const entries = await db
      .select({ id: journalEntries.id, entryNo: journalEntries.entryNo })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.userId, userId),
          eq(journalEntries.sourceTransactionId, transactionId)
        )
      )
      .limit(1)
      .execute();
    if (entries.length === 0) return;

    const { id: entryId } = entries[0];
    const detail = manualCashDetail(current);
    await db
      .update(journalEntries)
      .set({
        entryDate: current.transactionDate,
        description:
          current.type === "CASH_IN" ? "ฝากเงินเข้าบัญชี" : "ถอนเงินจากบัญชี",
        currency: current.currency,
        amount: current.amountForeign,
        amountThb: current.amountThb,
        fxRateEffective: current.fxRateEffective || "1",
        type: current.type,
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
        isFxConversion: detail.isFxConversion,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(journalEntries.id, entryId))
      .execute();

    // Two-line equity entries (manual cash rows) get their legs rebuilt to the
    // new amount/fx. Multi-leg statement entries keep the balanced lines.
    const lineCount = (
      await db
        .select({
          c: sql`COUNT(*)`.as<number>("c"),
        })
        .from(journalEntryLines)
        .where(eq(journalEntryLines.journalEntryId, entryId))
        .execute()
    )[0]?.c ?? 0;
    if (lineCount === 2) {
      await db
        .delete(journalEntryLines)
        .where(eq(journalEntryLines.journalEntryId, entryId))
        .execute();
      const entry = validateJournalEntry({
        entryDate: current.transactionDate,
        description:
          current.type === "CASH_IN" ? "ฝากเงินเข้าบัญชี" : "ถอนเงินจากบัญชี",
        sourceType: "MANUAL",
        sourceTransactionId: current.transactionId,
        lines: manualCashLines(current),
        postingState: "POSTED",
        skipReason: null,
        detail,
      });
      if (entry.ok) {
        for (const line of entry.entry.lines) {
          await db
            .insert(journalEntryLines)
            .values({
              id: randomUUID(),
              journalEntryId: entryId,
              userId,
              accountId: line.accountId,
              currency: line.currency,
              debitAmount: line.side === "DEBIT" ? line.amount : null,
              creditAmount: line.side === "CREDIT" ? line.amount : null,
              amountThb: line.amountThb,
              fxRateEffective: line.fxRateEffective,
              fxRateStatement: line.fxRateStatement,
              fxRateProvider: line.fxRateProvider,
              memo: line.memo,
            })
            .execute();
        }
      }
    }
  } catch (error) {
    console.error("syncCapitalLedgerJournal: failed to sync entry", error);
  }
}

/**
 * Remove the linked journal entry (and its lines) when a capital-ledger row is
 * deleted (DELETE), so journal-based reads stop showing the deleted row.
 * Best-effort: never throws — a deletion must not fail because of it.
 */
export async function removeCapitalLedgerJournal(
  userId: string,
  transactionId: string
): Promise<void> {
  try {
    const entries = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.userId, userId),
          eq(journalEntries.sourceTransactionId, transactionId)
        )
      )
      .limit(1)
      .execute();
    for (const { id } of entries) {
      await db
        .delete(journalEntryLines)
        .where(eq(journalEntryLines.journalEntryId, id))
        .execute();
      await db.delete(journalEntries).where(eq(journalEntries.id, id)).execute();
    }
  } catch (error) {
    console.error("removeCapitalLedgerJournal: failed to remove entry", error);
  }
}

// ---------------------------------------------------------------------------
// Atomic statement import (journal-as-SSOT)
// ---------------------------------------------------------------------------

export interface AtomicImportJournalStats {
  postedCount: number;
  skippedCount: number;
  entryNumbers: number[];
  skipped: { transactionId: string; reason: string }[];
}

export interface StatementImportResult {
  insertedCount: number;
  transactionIds: string[];
  journal: AtomicImportJournalStats;
}

/** Validate that each line's currency matches its resolved account's currency. */
function currencyMismatchErrors(
  entry: ValidatedJournalEntry,
  lookup: Map<string, ResolvedAccount>
): string[] {
  const errors: string[] = [];
  entry.lines.forEach((line, i) => {
    const account = lookup.get(line.accountId);
    if (!account) {
      errors.push(`line[${i}]: unknown account ${JSON.stringify(line.accountId)}`);
      return;
    }
    if (account.currency !== line.currency) {
      errors.push(
        `line[${i}]: account ${account.code} is ${account.currency}-denominated but the line is ${line.currency}`
      );
    }
  });
  return errors;
}

/**
 * Atomic import: Capital_Transactions rows AND their journal entries (every row
 * gets exactly one entry — POSTED with balanced lines, or SKIPPED recorded with
 * full trade detail and no lines) commit in a SINGLE transaction. This closes
 * the old best-effort gap where ledger postings happened after a committed
 * import and could drift or fail silently. A hard DB failure rolls the whole
 * import back; posting-eligibility failures (unresolvable accounts, currency
 * mismatches) downgrade the row's entry to SKIPPED instead of failing the
 * import, so the journal remains a COMPLETE record of the PDF.
 */
export async function insertStatementImport(
  userId: string,
  rows: ValidatedCapitalRow[]
): Promise<StatementImportResult> {
  if (rows.length === 0) {
    return {
      insertedCount: 0,
      transactionIds: [],
      journal: { postedCount: 0, skippedCount: 0, entryNumbers: [], skipped: [] },
    };
  }

  let lookup = await loadAccountLookup(userId);
  // Lazy-seed once for pre-CoA users (idempotent), like createJournalEntry.
  if (lookup.size === 0) {
    const seeded = await seedDefaultChartOfAccounts(userId);
    if (seeded > 0) lookup = await loadAccountLookup(userId);
  }

  const built = buildStatementJournalEntries(rows);
  const plans: {
    row: ValidatedCapitalRow;
    validated: { ok: true; entry: ValidatedJournalEntry };
    postingState: PostingState;
    reason?: string;
  }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const j = built[i];
    if (!j) {
      const reason = "missing statement posting plan";
      const v = validateJournalEntry({
        entryDate: row.transactionDate,
        description: `รายการจากงบ (${reason})`,
        sourceType: "STATEMENT",
        sourceDocumentId: row.sourceDocumentId,
        sourceTransactionId: row.transactionId,
        lines: [],
        postingState: "SKIPPED",
        skipReason: reason,
      });
      if (v.ok) plans.push({ row, validated: v, postingState: "SKIPPED", reason });
      continue;
    }

    if (j.postingState === "SKIPPED") {
      const v = validateJournalEntry(j.entry);
      if (v.ok) {
        plans.push({
          row,
          validated: v,
          postingState: "SKIPPED",
          reason: j.reason ?? j.entry.skipReason ?? undefined,
        });
      }
      continue;
    }

    const resolved = resolveEntryAccountIds(j.entry, lookup);
    if (!resolved.ok) {
      const reason = resolved.errors.join("; ");
      const v = validateJournalEntry({
        ...j.entry,
        lines: [],
        postingState: "SKIPPED",
        skipReason: reason,
      });
      if (v.ok) plans.push({ row, validated: v, postingState: "SKIPPED", reason });
      continue;
    }
    const validated = validateJournalEntry({ ...j.entry, lines: resolved.lines });
    if (!validated.ok) {
      const reason = `invalid entry: ${validated.errors.join("; ")}`;
      const v = validateJournalEntry({
        ...j.entry,
        lines: [],
        postingState: "SKIPPED",
        skipReason: reason,
      });
      if (v.ok) plans.push({ row, validated: v, postingState: "SKIPPED", reason });
      continue;
    }
    const currencyErrors = currencyMismatchErrors(validated.entry, lookup);
    if (currencyErrors.length > 0) {
      const reason = currencyErrors.join("; ");
      const v = validateJournalEntry({
        ...j.entry,
        lines: [],
        postingState: "SKIPPED",
        skipReason: reason,
      });
      if (v.ok) plans.push({ row, validated: v, postingState: "SKIPPED", reason });
      continue;
    }
    plans.push({ row, validated, postingState: "POSTED" });
  }

  const now = new Date().toISOString();
  const transactionIds: string[] = [];
  const journal: AtomicImportJournalStats = {
    postedCount: 0,
    skippedCount: 0,
    entryNumbers: [],
    skipped: [],
  };

  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx
        .insert(capitalTransactions)
        .values({
          transactionId: row.transactionId,
          userId: row.userId,
          amountForeign: row.amountForeign,
          currency: row.currency,
          transactionDate: row.transactionDate,
          fxRateBot: row.fxRateBot,
          amountThb: row.amountThb,
          type: row.type,
          sourceType: row.sourceType,
          sourceDocumentId: row.sourceDocumentId,
          category: row.category,
          section: row.section,
          symbol: row.symbol,
          side: row.side,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          grossAmount: row.grossAmount,
          fees: row.fees,
          netAmount: row.netAmount,
          proceeds: row.proceeds,
          costBasis: row.costBasis,
          realizedGainLoss: row.realizedGainLoss,
          realizedGainLossThb: row.realizedGainLossThb,
          fxRateStatement: row.fxRateStatement,
          fxRateEffective: row.fxRateEffective,
          exchange: row.exchange,
          exchangeFromCurrency: row.exchangeFromCurrency,
          exchangeFromAmount: row.exchangeFromAmount,
          exchangeRate: row.exchangeRate,
        })
        .execute();
      transactionIds.push(row.transactionId);
    }

    const base = await nextEntryNo(userId);
    for (const [idx, plan] of plans.entries()) {
      const entryNo = base + idx + 1;
      const entry = plan.validated.entry;
      const entryId = randomUUID();
      await tx
        .insert(journalEntries)
        .values({
          id: entryId,
          userId,
          entryNo,
          entryDate: entry.entryDate,
          description: entry.description,
          sourceType: entry.sourceType,
          sourceDocumentId: entry.sourceDocumentId,
          sourceTransactionId: entry.sourceTransactionId,
          status: "POSTED",
          category: entry.detail.category,
          section: entry.detail.section,
          symbol: entry.detail.symbol,
          side: entry.detail.side,
          exchange: entry.detail.exchange,
          quantity: entry.detail.quantity,
          unitPrice: entry.detail.unitPrice,
          grossAmount: entry.detail.grossAmount,
          fees: entry.detail.fees,
          netAmount: entry.detail.netAmount,
          proceeds: entry.detail.proceeds,
          costBasis: entry.detail.costBasis,
          realizedGainLoss: entry.detail.realizedGainLoss,
          realizedGainLossThb: entry.detail.realizedGainLossThb,
          averageCost: entry.detail.averageCost,
          currency: entry.detail.currency,
          amount: entry.detail.amount,
          amountThb: entry.detail.amountThb,
          fxRateEffective: entry.detail.fxRateEffective,
          fxRateStatement: entry.detail.fxRateStatement,
          isFxConversion: entry.detail.isFxConversion,
          exchangeFromCurrency: entry.detail.exchangeFromCurrency,
          exchangeFromAmount: entry.detail.exchangeFromAmount,
          exchangeRate: entry.detail.exchangeRate,
          postingState: entry.postingState,
          skipReason: entry.skipReason,
          type: plan.row.type,
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      for (const line of entry.lines) {
        await tx
          .insert(journalEntryLines)
          .values({
            id: randomUUID(),
            journalEntryId: entryId,
            userId,
            accountId: line.accountId,
            currency: line.currency,
            debitAmount: line.side === "DEBIT" ? line.amount : null,
            creditAmount: line.side === "CREDIT" ? line.amount : null,
            amountThb: line.amountThb,
            fxRateEffective: line.fxRateEffective,
            fxRateStatement: line.fxRateStatement,
            fxRateProvider: line.fxRateProvider,
            memo: line.memo,
          })
          .execute();
      }
      if (plan.postingState === "POSTED") {
        journal.postedCount++;
        journal.entryNumbers.push(entryNo);
      } else {
        journal.skippedCount++;
        journal.skipped.push({
          transactionId: plan.row.transactionId,
          reason: plan.reason ?? plan.validated.entry.skipReason ?? "skipped",
        });
      }
    }
  });

  return { insertedCount: transactionIds.length, transactionIds, journal };
}

// ---------------------------------------------------------------------------
// Reads + reports
// ---------------------------------------------------------------------------

interface RawLineWithEntry {
  line: {
    debitAmount: string | null;
    creditAmount: string | null;
    currency: string;
    amountThb: string;
    fxRateEffective: string;
    fxRateStatement: string | null;
    fxRateProvider: string | null;
    memo: string | null;
    accountId: string;
    id: string;
  };
  entry: {
    id: string;
    entryNo: number;
    entryDate: string;
    description: string;
    sourceType: string;
    sourceDocumentId: string | null;
    sourceTransactionId: string | null;
    status: string;
    createdAt: string;
    postingState: string;
    skipReason: string | null;
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
    averageCost: string | null;
    currency: string | null;
    amount: string | null;
    amountThb: string | null;
    fxRateEffective: string | null;
    fxRateStatement: string | null;
    isFxConversion: boolean;
  };
}

async function selectRawLines(conditions: (SQL | undefined)[]) {
  const rows = await db
    .select({
      line: {
        debitAmount: journalEntryLines.debitAmount,
        creditAmount: journalEntryLines.creditAmount,
        currency: journalEntryLines.currency,
        amountThb: journalEntryLines.amountThb,
        fxRateEffective: journalEntryLines.fxRateEffective,
        fxRateStatement: journalEntryLines.fxRateStatement,
        fxRateProvider: journalEntryLines.fxRateProvider,
        memo: journalEntryLines.memo,
        accountId: journalEntryLines.accountId,
        id: journalEntryLines.id,
      },
      entry: {
        id: journalEntries.id,
        entryNo: journalEntries.entryNo,
        entryDate: journalEntries.entryDate,
        description: journalEntries.description,
        sourceType: journalEntries.sourceType,
        sourceDocumentId: journalEntries.sourceDocumentId,
        sourceTransactionId: journalEntries.sourceTransactionId,
        status: journalEntries.status,
        createdAt: journalEntries.createdAt,
        postingState: journalEntries.postingState,
        skipReason: journalEntries.skipReason,
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
      },
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(...conditions))
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.entryNo), asc(journalEntryLines.id))
    .execute();
  return rows as unknown as RawLineWithEntry[];
}

async function fetchRawLines(userId: string, from?: string, to?: string): Promise<RawLineWithEntry[]> {
  const conditions = [eq(journalEntryLines.userId, userId)];
  if (from) conditions.push(gte(journalEntries.entryDate, from));
  if (to) conditions.push(lte(journalEntries.entryDate, to));
  return selectRawLines(conditions);
}

function toPersistedEntry(
  grouped: Map<string, { entry: RawLineWithEntry["entry"]; lines: RawLineWithEntry["line"][] }>,
  accountMap: AccountMap
): PersistedJournalEntry[] {
  const out: PersistedJournalEntry[] = [];
  for (const { entry, lines } of grouped.values()) {
    out.push({
      id: entry.id,
      entryNo: entry.entryNo,
      entryDate: entry.entryDate,
      description: entry.description,
      sourceType: entry.sourceType,
      sourceDocumentId: entry.sourceDocumentId,
      sourceTransactionId: entry.sourceTransactionId,
      status: entry.status,
      createdAt: entry.createdAt,
      postingState: entry.postingState === "SKIPPED" ? "SKIPPED" : "POSTED",
      skipReason: entry.skipReason,
      detail: {
        category: entry.category,
        section: entry.section,
        symbol: entry.symbol,
        side: entry.side,
        exchange: entry.exchange,
        quantity: entry.quantity,
        unitPrice: entry.unitPrice,
        grossAmount: entry.grossAmount,
        fees: entry.fees,
        netAmount: entry.netAmount,
        proceeds: entry.proceeds,
        costBasis: entry.costBasis,
        realizedGainLoss: entry.realizedGainLoss,
        realizedGainLossThb: entry.realizedGainLossThb,
        averageCost: entry.averageCost,
        currency: entry.currency,
        amount: entry.amount,
        amountThb: entry.amountThb,
        fxRateEffective: entry.fxRateEffective,
        fxRateStatement: entry.fxRateStatement,
        isFxConversion: entry.isFxConversion,
      },
      lines: lines.map((l) => {
        const acc = accountMap[l.accountId];
        const side: Side = l.debitAmount != null ? "DEBIT" : "CREDIT";
        return {
          id: l.id,
          journalEntryId: entry.id,
          accountId: l.accountId,
          accountCode: acc?.code ?? l.accountId,
          accountName: acc?.name ?? "(ไม่รู้จักบัญชี)",
          accountType: acc?.type ?? "ASSET",
          currency: l.currency,
          side,
          amount: l.debitAmount ?? l.creditAmount ?? "0",
          amountThb: l.amountThb,
          fxRateEffective: l.fxRateEffective,
          fxRateStatement: l.fxRateStatement,
          fxRateProvider: l.fxRateProvider,
          memo: l.memo,
        };
      }),
    });
  }
  out.sort((a, b) => a.entryNo - b.entryNo);
  return out;
}

/**
 * List the user's journal entries (with lines) for a date range, oldest first.
 */
export async function listJournalEntries(
  userId: string,
  from?: string,
  to?: string,
  filters?: JournalEntryListFilters
): Promise<PersistedJournalEntry[]> {
  const [accountRows, headers, raw] = await Promise.all([
    getAccounts(userId),
    fetchJournalHeaders(userId, from, to, filters),
    fetchRawLines(userId, from, to),
  ]);
  const accountMap = toAccountMap(accountRows);

  // Every header (POSTED AND SKIPPED) is a journal entry; lines only attach to
  // POSTED ones. SKIPPED entries simply have no lines — they must still appear
  // in the journal because the journal is the complete record of every import.
  const grouped = new Map<string, { entry: RawLineWithEntry["entry"]; lines: RawLineWithEntry["line"][] }>();
  for (const h of headers) grouped.set(h.id, { entry: h, lines: [] });
  for (const r of raw) {
    const bucket = grouped.get(r.entry.id);
    if (!bucket) continue;
    bucket.lines.push(r.line);
  }
  return toPersistedEntry(grouped, accountMap);
}

export interface JournalEntryListFilters {
  from?: string;
  to?: string;
  sourceType?: "MANUAL" | "STATEMENT";
  postingState?: PostingState;
}

type JournalEntryHeaderRow = RawLineWithEntry["entry"];

async function fetchJournalHeaders(
  userId: string,
  from?: string,
  to?: string,
  filters?: JournalEntryListFilters
): Promise<JournalEntryHeaderRow[]> {
  const conditions: (SQL | undefined)[] = [eq(journalEntries.userId, userId)];
  if (filters?.sourceType) conditions.push(eq(journalEntries.sourceType, filters.sourceType));
  if (filters?.postingState) conditions.push(eq(journalEntries.postingState, filters.postingState));
  if (from) conditions.push(gte(journalEntries.entryDate, from));
  if (to) conditions.push(lte(journalEntries.entryDate, to));
  const rows = await db
    .select({
      id: journalEntries.id,
      entryNo: journalEntries.entryNo,
      entryDate: journalEntries.entryDate,
      description: journalEntries.description,
      sourceType: journalEntries.sourceType,
      sourceDocumentId: journalEntries.sourceDocumentId,
      sourceTransactionId: journalEntries.sourceTransactionId,
      status: journalEntries.status,
      createdAt: journalEntries.createdAt,
      postingState: journalEntries.postingState,
      skipReason: journalEntries.skipReason,
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
    })
    .from(journalEntries)
    .where(and(...conditions))
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.entryNo))
    .execute();
  return rows as unknown as JournalEntryHeaderRow[];
}

export interface LedgerLineView {
  lineId: string;
  journalEntryId: string;
  entryNo: number;
  entryDate: string;
  description: string;
  sourceType: string;
  sourceDocumentId: string | null;
  sourceTransactionId: string | null;
  side: Side;
  amount: string;
  amountThb: string;
  currency: string;
  memo: string | null;
  runningBalance: string;
}

function toSymbolSummaryLine(r: RawLineWithEntry) {
  return {
    currency: r.line.currency,
    memo: r.line.memo,
    debitAmount: r.line.debitAmount,
    creditAmount: r.line.creditAmount,
    amountThb: r.line.amountThb,
  };
}

/**
 * Account ledger with a running balance (signed debit-credit). `opening` is the
 * balance accumulated before `from` (account opening balance + prior postings).
 * `symbolSummary` groups the period's lines by their memo label (per-stock, for
 * a dividend account) — empty when no memo'd lines.
 */
export async function getAccountLedger(
  userId: string,
  accountId: string,
  from?: string,
  to?: string
): Promise<{
  opening: string;
  lines: LedgerLineView[];
  symbolSummary: LedgerSymbolSummary[];
}> {
  const [account, raw] = await Promise.all([
    db
      .select({ openingBalance: accounts.openingBalance })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
      .limit(1)
      .execute(),
    fetchRawLinesForAccount(userId, accountId, from, to),
  ]);

  const openingDec = new Decimal(account[0]?.openingBalance ?? "0");
  let running = openingDec;
  const lines: LedgerLineView[] = [];
  for (const r of raw) {
    const amount = new Decimal(r.line.debitAmount ?? r.line.creditAmount ?? "0");
    if (r.line.debitAmount != null) running = running.plus(amount);
    else running = running.minus(amount);
    lines.push({
      lineId: r.line.id,
      journalEntryId: r.entry.id,
      entryNo: r.entry.entryNo,
      entryDate: r.entry.entryDate,
      description: r.entry.description,
      sourceType: r.entry.sourceType,
      sourceDocumentId: r.entry.sourceDocumentId,
      sourceTransactionId: r.entry.sourceTransactionId,
      side: r.line.debitAmount != null ? "DEBIT" : "CREDIT",
      amount: r.line.debitAmount ?? r.line.creditAmount ?? "0",
      amountThb: r.line.amountThb,
      currency: r.line.currency,
      memo: r.line.memo,
      runningBalance: running.toFixed(2),
    });
  }
  return {
    opening: openingDec.toFixed(2),
    lines,
    symbolSummary: summarizeLinesBySymbol(raw.map(toSymbolSummaryLine)),
  };
}

export async function fetchRawLinesForAccount(
  userId: string,
  accountId: string,
  from?: string,
  to?: string
): Promise<RawLineWithEntry[]> {
  const conditions: (SQL | undefined)[] = [
    eq(journalEntryLines.userId, userId),
    eq(journalEntryLines.accountId, accountId),
  ];
  if (from) conditions.push(gte(journalEntries.entryDate, from));
  if (to) conditions.push(lte(journalEntries.entryDate, to));
  return selectRawLines(conditions);
}

/** Trial balance for a date range. */
export async function getTrialBalance(userId: string, from?: string, to?: string) {
  const [accountRows, raw] = await Promise.all([getAccounts(userId), fetchRawLines(userId, from, to)]);
  const accountMap = toAccountMap(accountRows);
  const lines = raw.map((r) => ({
    accountId: r.line.accountId,
    side: r.line.debitAmount != null ? ("DEBIT" as Side) : ("CREDIT" as Side),
    amount: r.line.debitAmount ?? r.line.creditAmount ?? "0",
    amountThb: r.line.amountThb,
    currency: r.line.currency,
  }));
  return trialBalance(lines, accountMap);
}

/** Sorted for stable UI rendering, oldest entry first. */
async function sortByEntry(raw: RawLineWithEntry[]): Promise<RawLineWithEntry[]> {
  return raw.sort(
    (a, b) =>
      a.entry.entryDate.localeCompare(b.entry.entryDate) ||
      a.entry.entryNo - b.entry.entryNo
  );
}

/** Income statement for a date range. */
export async function getIncomeStatement(userId: string, from?: string, to?: string) {
  const [accountRows, raw] = await Promise.all([
    getAccounts(userId),
    sortByEntry(await fetchRawLines(userId, from, to)),
  ]);
  const accountMap = toAccountMap(accountRows);
  const lines = raw.map((r) => ({
    accountId: r.line.accountId,
    currency: r.line.currency,
    side: r.line.debitAmount != null ? ("DEBIT" as Side) : ("CREDIT" as Side),
    amount: r.line.debitAmount ?? r.line.creditAmount ?? "0",
    amountThb: r.line.amountThb,
  }));
  const dividendAccountId = accountRows.find(
    (a) => a.code === "4010"
  )?.id;
  return {
    ...incomeStatement(lines, accountMap),
    // Per-stock dividend breakdown from the dividend account's memo'd lines.
    dividendsBySymbol:
      dividendAccountId != null
        ? summarizeLinesBySymbol(
            raw
              .filter((r) => r.line.accountId === dividendAccountId)
              .map(toSymbolSummaryLine)
          )
        : [],
  };
}

/** Balance sheet as of `to` (postings on or before the date + opening balances). */
export async function getBalanceSheet(userId: string, to?: string) {
  const [accountRows, raw] = await Promise.all([
    getAccounts(userId),
    fetchRawLines(userId, undefined, to),
  ]);
  const accountMap = toAccountMap(accountRows);
  const openingBalances: Record<string, string> = {};
  const openingBalancesThb: Record<string, string> = {};
  for (const acc of accountRows) {
    if (acc.openingBalance != null) {
      openingBalances[acc.id] = acc.openingBalance;
      // Only THB-denominated openings convert 1:1; foreign openings have no
      // rate at this layer, so they contribute 0 to the THB-base sums.
      if (acc.currency === "THB") openingBalancesThb[acc.id] = acc.openingBalance;
    }
  }
  const lines = raw.map((r) => ({
    accountId: r.line.accountId,
    side: r.line.debitAmount != null ? ("DEBIT" as Side) : ("CREDIT" as Side),
    amount: r.line.debitAmount ?? r.line.creditAmount ?? "0",
    amountThb: r.line.amountThb,
  }));
  return balanceSheet(lines, accountMap, openingBalances, openingBalancesThb);
}

// ---------------------------------------------------------------------------
// Ledger summary (overview)
// ---------------------------------------------------------------------------

export interface LedgerSummaryGroup {
  code: string;
  name: string;
  currency: string;
  /** Positive magnitude on the account's normal side. */
  balance: string;
  /** Same magnitude in THB-base. */
  balanceThb: string;
}

export interface LedgerSummaryByType {
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  currency: string;
  /** Signed total across accounts of this type/currency (normal-side positive). */
  total: string;
  /** Same total in THB-base. */
  totalThb: string;
  accounts: LedgerSummaryGroup[];
}

export interface LedgerSummary {
  /** Cash accounts (1010/1020/… whatever presents as cash) by currency. */
  groups: LedgerSummaryByType[];
  /** Balance-sheet totals per currency (A / L / E). */
  totalsByCurrency: {
    currency: string;
    assets: string;
    liabilities: string;
    equity: string;
    netIncome: string;
    /** THB-base parallels of the row above. */
    assetsThb: string;
    liabilitiesThb: string;
    equityThb: string;
    netIncomeThb: string;
    balanced: boolean;
  }[];
  /** THB-base grand totals across all currencies (the reportable sums). */
  totalsThb: {
    assets: string;
    liabilities: string;
    equity: string;
    netIncome: string;
    totalAssets: string;
    totalEquityAndLiabilities: string;
    balanced: boolean;
  };
  /** Raw balance-sheet flags (cross-currency naive totals, informational). */
  balanced: boolean;
  totalAssetsNaive: string;
  totalEquityAndLiabilitiesNaive: string;
}

/** Group the user's balance-sheet rows by (type, currency) for the overview. */
export function getLedgerSummary(userId: string): Promise<LedgerSummary> {
  return (async () => {
    const sheet = await getBalanceSheet(userId);

    const groups: LedgerSummaryByType[] = [];
    // Totals are accumulated per CURRENCY so one "งบดุล (USD)" card shows the
    // combined A / L / E for that currency (2030 asset + 2080 equity both USD
    // land in the same row). Grouped rows stay split by (type, currency).
    const totalsMap = new Map<
      string,
      {
        assets: Decimal;
        liabilities: Decimal;
        equity: Decimal;
        assetsThb: Decimal;
        liabilitiesThb: Decimal;
        equityThb: Decimal;
      }
    >();

    const pushGroup = (
      type: "ASSET" | "LIABILITY" | "EQUITY",
      rows: BalanceSheetRow[]
    ) => {
      const byCurrency = new Map<string, BalanceSheetRow[]>();
      for (const r of rows) {
        const arr = byCurrency.get(r.currency) ?? [];
        arr.push(r);
        byCurrency.set(r.currency, arr);
      }
      for (const [currency, rows2] of byCurrency) {
        let total = new Decimal(0);
        let totalThb = new Decimal(0);
        for (const acc of rows2) {
          total = total.plus(new Decimal(acc.balance));
          totalThb = totalThb.plus(new Decimal(acc.balanceThb));
        }
        const entry = totalsMap.get(currency) ?? {
          assets: new Decimal(0),
          liabilities: new Decimal(0),
          equity: new Decimal(0),
          assetsThb: new Decimal(0),
          liabilitiesThb: new Decimal(0),
          equityThb: new Decimal(0),
        };
        if (type === "ASSET") {
          entry.assets = entry.assets.plus(total);
          entry.assetsThb = entry.assetsThb.plus(totalThb);
        }
        if (type === "LIABILITY") {
          entry.liabilities = entry.liabilities.plus(total);
          entry.liabilitiesThb = entry.liabilitiesThb.plus(totalThb);
        }
        if (type === "EQUITY") {
          entry.equity = entry.equity.plus(total);
          entry.equityThb = entry.equityThb.plus(totalThb);
        }
        totalsMap.set(currency, entry);
        groups.push({
          type,
          currency,
          total: total.toFixed(2),
          totalThb: totalThb.toFixed(2),
          accounts: rows2.map((a) => ({
            code: a.code,
            name: a.name,
            currency: a.currency,
            balance: a.balance,
            balanceThb: a.balanceThb,
          })),
        });
      }
    };

    pushGroup("ASSET", sheet.assets);
    pushGroup("LIABILITY", sheet.liabilities);
    pushGroup("EQUITY", sheet.equity);

    const totalsByCurrency = Array.from(totalsMap.entries()).map(
      ([currency, val]) => {
        return {
          currency,
          assets: val.assets.toFixed(2),
          liabilities: val.liabilities.toFixed(2),
          equity: val.equity.toFixed(2),
          // Net income is folded into equity by the pure engine; it is not
          // broken out per foreign currency, so per-currency NI stays 0.00
          // while the THB-base NI below carries the reportable figure.
          netIncome: "0.00",
          assetsThb: val.assetsThb.toFixed(2),
          liabilitiesThb: val.liabilitiesThb.toFixed(2),
          equityThb: val.equityThb.toFixed(2),
          netIncomeThb: sheet.netIncomeThb,
          balanced: val.assets.equals(val.liabilities.plus(val.equity)),
        };
      }
    );

    return {
      groups,
      totalsByCurrency,
      totalsThb: {
        assets: sheet.totalsByCurrency.reduce(
          (s, t) => s.plus(new Decimal(t.assetsThb)),
          new Decimal(0)
        ).toFixed(2),
        liabilities: sheet.totalsByCurrency.reduce(
          (s, t) => s.plus(new Decimal(t.liabilitiesThb)),
          new Decimal(0)
        ).toFixed(2),
        equity: sheet.totalsByCurrency.reduce(
          (s, t) => s.plus(new Decimal(t.equityThb)),
          new Decimal(0)
        ).toFixed(2),
        netIncome: sheet.netIncomeThb,
        totalAssets: sheet.totalAssetsThb,
        totalEquityAndLiabilities: sheet.totalEquityAndLiabilitiesThb,
        balanced: sheet.balancedThb,
      },
      balanced: sheet.balanced,
      totalAssetsNaive: sheet.totalAssets,
      totalEquityAndLiabilitiesNaive: sheet.totalEquityAndLiabilities,
    };
  })();
}

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

export type ReversalResult =
  | { ok: true; reversalEntryId: string; reversalEntryNo: number }
  | { ok: false; errors: string[] };

/**
 * Reverse a POSTED entry: marks the original REVERSED and posts an inverted
 * mirror with a new entry number (reversals are real events, not deletes).
 */
export async function reverseJournalEntry(
  userId: string,
  entryId: string
): Promise<ReversalResult> {
  const rows = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, entryId)))
    .limit(1)
    .execute();
  const header = rows[0];
  if (!header) return { ok: false, errors: ["Journal entry not found"] };
  if (header.status === "REVERSED") {
    return { ok: false, errors: ["Journal entry is already reversed"] };
  }

  const lineRows = await db
    .select()
    .from(journalEntryLines)
    .where(and(eq(journalEntryLines.userId, userId), eq(journalEntryLines.journalEntryId, entryId)))
    .execute();
  if (lineRows.length < 2) {
    return { ok: false, errors: ["Journal entry has no valid lines to reverse"] };
  }

  const validated: ValidatedJournalEntry = {
    entryDate: header.entryDate,
    description: header.description,
    sourceType: header.sourceType === "STATEMENT" ? "STATEMENT" : "MANUAL",
    sourceDocumentId: header.sourceDocumentId,
    sourceTransactionId: header.sourceTransactionId,
    postingState: "POSTED",
    skipReason: null,
    detail: emptyTradeDetail(),
    lines: lineRows.map((l) => ({
      accountId: l.accountId,
      currency: l.currency,
      side: l.debitAmount != null ? "DEBIT" : "CREDIT",
      amount: l.debitAmount ?? l.creditAmount ?? "0",
      amountThb: l.amountThb,
      fxRateEffective: l.fxRateEffective,
      fxRateStatement: l.fxRateStatement,
      fxRateProvider: l.fxRateProvider,
      memo: l.memo,
    })),
  };

  const candidate = buildReversal(validated);
  const created = await createJournalEntry(userId, {
    entryDate: candidate.entryDate,
    description: candidate.description,
    sourceType: "MANUAL",
    sourceTransactionId: candidate.sourceTransactionId,
    lines: candidate.lines.map((l) => ({
      accountId: l.accountId,
      currency: l.currency,
      debit: l.side === "DEBIT" ? l.amount : null,
      credit: l.side === "CREDIT" ? l.amount : null,
      fxRateEffective: l.fxRateEffective,
      fxRateStatement: l.fxRateStatement,
      fxRateProvider: l.fxRateProvider,
      memo: l.memo,
    })),
  });
  if (!created.ok) return created;

  try {
    await db
      .update(journalEntries)
      .set({ status: "REVERSED", updatedAt: new Date().toISOString() })
      .where(eq(journalEntries.id, entryId))
      .execute();
  } catch (error) {
    console.error("reverseJournalEntry: failed to mark original reversed", error);
  }

  return { ok: true, reversalEntryId: created.entryId, reversalEntryNo: created.entryNo };
}