import { roundMoney, moneyInThb } from "./accounting-amounts";
// General-ledger database service.
//
// Persists accounts/journal entries/lines and builds the pure-engine reports
// from rows that are always scoped to the authenticated user. Every money value
// is stored as a decimal string; the pure engine (general-ledger.ts) stays
// entirely framework/DB-free so all invariants are tested without a database.
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, ilike, inArray, lte, max, sql, type SQL } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "./drizzle-db";
import { assertOwnedReferences } from "./resource-ownership";
import { safeErrorLog } from "./safe-error-log";
import { insertAuditLog, insertAuditLogStrict, AuditAction } from "./audit-log";
import {
  accounts,
  auditLogs,
  corporateActions,
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
  summarizeAccountLedgers,
  trialBalance,
  normalSideOf,
  validateJournalEntry,
  buildMonthlyClosing,
  ROUNDING_ADJUSTMENT_MEMO,
  type AccountLedgerSummaryInput,
  type AccountLedgerSummaryLineInput,
  type AccountLedgerSummaryResult,
  type AccountMap,
  type AccountType,
  type BalanceSheetRow,
  type JournalEntryInput,
  type JournalLineInput,
  type JournalTradeDetail,
  type LedgerSymbolSummary,
  type MonthlyClosingLineInput,
  type PostingState,
  type Side,
  type ValidatedJournalEntry,
} from "./general-ledger";
import {
  buildStatementJournalEntries,
  FX_VARIANCE_MEMO,
} from "./posting-engine";
import {
  recomputeAllGainLoss,
  recomputeCostBasisMap,
  saveCostBasisState,
  rebuildCostBasisStateFromLedger,
  backfillComputedGainLoss,
  type CostBasisActionRow,
  type ValidatedCapitalRow,
} from "./statement-pipeline";

Decimal.set({ precision: 40 });

/** The database client or an open transaction client (both expose the same
 *  insert/select/update/delete/execute surface used below). */
type DbClient = typeof db;
type TxClient = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Conn = DbClient | TxClient;

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

/** Idempotent per-code: inserts ONLY the default codes the user is missing,
 * leaving every existing row (incl. custom accounts) untouched. Grows the CoA
 * for pre-existing users when a new default (e.g. 3020 THB owner capital) is
 * introduced, exactly once per code — repeated calls are no-ops. */
export async function seedDefaultChartOfAccounts(
  userId: string,
  conn: Conn = db
): Promise<number> {
  const existingCodes = new Set(
    (
      await conn
        .select({ code: accounts.code })
        .from(accounts)
        .where(eq(accounts.userId, userId))
        .execute()
    ).map((r) => r.code)
  );
  const missing = DEFAULT_CHART_OF_ACCOUNTS.filter(
    (acc) => !existingCodes.has(acc.code)
  );
  if (missing.length === 0) return 0;

  const now = new Date().toISOString();
  const values = missing.map((acc) => ({
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
  await conn.insert(accounts).values(values).execute();
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

export async function getActiveAccounts(
  userId: string,
  conn: Conn = db
): Promise<AccountRow[]> {
  return (await conn
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
  updatedAt?: string;
  postingState: PostingState;
  skipReason: string | null;
  type?: string | null;
  note?: string | null;
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
    exchangeFromCurrency?: string | null;
    exchangeFromAmount?: string | null;
    exchangeRate?: string | null;
    isMonthlyFeeAggregate: boolean | null;
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
  type: string;
}

/**
 * Build a lookup over the user's ACTIVE accounts keyed by BOTH account id and
 * account code. Statement postings reference accounts by code (the posting
 * engine is pure/DB-free), manual entries reference them by id; this one map
 * accepts either and normalizes to the UUID `account_id` the schema requires.
 */
export async function loadAccountLookup(
  userId: string,
  conn: Conn = db
): Promise<Map<string, ResolvedAccount>> {
  const rows = await getActiveAccounts(userId, conn);
  const map = new Map<string, ResolvedAccount>();
  for (const r of rows) {
    const resolved = { id: r.id, code: r.code, currency: r.currency, type: r.type };
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
export function resolveEntryAccountIds(
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
    if (account.currency !== line.currency.trim().toUpperCase()) {
      errors.push(`line[${i}]: account ${account.code} is ${account.currency}-denominated but the line is ${line.currency}`);
    }
    if (input.detail?.isFxConversion === true) {
      const isCashAsset =
        account.type === "ASSET" && (account.code === "1010" || account.code === "1020");
      const isVarianceLeg =
        account.code === "5020" && (line.currency ?? "").trim().toUpperCase() === "THB";
      if (!isCashAsset && !isVarianceLeg) {
        errors.push(
          `line[${i}]: currency exchange requires a compatible cash asset account (or the 5020 THB FX-variance leg)`
        );
      }
    }
    return { ...line, accountId: account.id };
  });
  if (input.detail?.isFxConversion === true) {
    const varianceRefs = input.lines.filter(
      (l) => (l.accountId ?? "").trim() === "5020" && (l.currency ?? "").trim().toUpperCase() === "THB"
    );
    if (varianceRefs.length > 1) {
      errors.push("currency exchange allows at most one 5020 THB FX-variance leg");
    }
    if (errors.length > 0) return { ok: false, errors };
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, lines };
}

async function nextEntryNo(
  userId: string,
  conn: Conn = db,
): Promise<number> {
  // Serialize concurrent entry-number allocation for this user BEFORE reading
  // MAX(entry_no). Two simultaneous creates could otherwise both compute the
  // same next number and one would lose deterministically at write time (the
  // (user_id, entry_no) UNIQUE index still backstops integrity). The advisory
  // xact lock is scoped to the surrounding transaction (callers always allocate
  // inside one) and is released automatically at commit/rollback.
  await conn.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
  const [{ value }] = await conn
    .select({ value: max(journalEntries.entryNo) })
    .from(journalEntries)
    .where(eq(journalEntries.userId, userId))
    .execute();
  return (value ?? 0) + 1;
}

/** Persist one already-validated entry (header + lines) inside a transaction.
 *  Returns the allocated entry_no. Centralizes the header/line insert shape so
 *  the manual, backfill, reversal and statement paths cannot drift. */
async function persistJournalEntry(
  tx: TxClient,
  userId: string,
  entry: ValidatedJournalEntry,
  entryId: string,
  typeValue: string | null | undefined,
  now: string,
): Promise<number> {
  await assertOwnedReferences(tx, userId, entry);
  const entryNo = await nextEntryNo(userId, tx);
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
      isMonthlyFeeAggregate: entry.detail.isMonthlyFeeAggregate,
      postingState: entry.postingState,
      skipReason: entry.skipReason,
      type: entry.detail.isFxConversion ? null : (typeValue ?? null),
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
  return entryNo;
}

/** Persist one validated entry with its lines inside a transaction. */
export async function createJournalEntry(
  userId: string,
  input: JournalEntryInput,
  conn: Conn = db
): Promise<CreateEntryResult> {
  let lookup = await loadAccountLookup(userId, conn);
  // Existing users who registered before the default chart-of-accounts seeder
  // existed have no accounts yet. Lazy-seed once (idempotent) so their first
  // manual entry and statement postings work instead of failing "unknown account".
  if (lookup.size === 0) {
    const seeded = await seedDefaultChartOfAccounts(userId, conn);
    if (seeded > 0) lookup = await loadAccountLookup(userId, conn);
  } else if (!lookup.has("3020")) {
    // Grown CoA: per-code idempotent seed adds newly-introduced defaults (3020
    // THB owner capital) to existing users without touching custom accounts.
    const seeded = await seedDefaultChartOfAccounts(userId, conn);
    if (seeded > 0) lookup = await loadAccountLookup(userId, conn);
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
    const executePersist = async (tx: TxClient): Promise<{ entryId: string; entryNo: number }> => {
      const isReversal = entry.description.startsWith("กลับรายการ:");
      if (entry.sourceTransactionId && !isReversal) {
        // Serialize concurrent first-time journal creations for this (userId, sourceTransactionId)
        // BEFORE checking existing rows so that two simultaneous creations cannot both observe
        // zero rows and both INSERT. The advisory lock is transaction-scoped and auto-releases on commit/rollback.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${userId}), hashtext(${entry.sourceTransactionId}))`
        );

        const existingRows = await tx
          .select({
            id: journalEntries.id,
            entryNo: journalEntries.entryNo,
            postingState: journalEntries.postingState,
            status: journalEntries.status,
          })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.userId, userId),
              eq(journalEntries.sourceTransactionId, entry.sourceTransactionId)
            )
          )
          .for("update")
          .execute();

        const existingPosted = existingRows.find(
          (r) => r.postingState === "POSTED" && r.status === "POSTED"
        );
        if (existingPosted) {
          // Active POSTED journal already exists: treat as authoritative, never duplicate
          return { entryId: existingPosted.id, entryNo: existingPosted.entryNo };
        }

        const existingStub = existingRows.find((r) => r.postingState === "SKIPPED");
        if (existingStub) {
          // Reuse/promote the existing SKIPPED placeholder in place
          await tx
            .update(journalEntries)
            .set({
              entryDate: entry.entryDate,
              description: entry.description,
              sourceType: entry.sourceType,
              sourceDocumentId: entry.sourceDocumentId,
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
              isMonthlyFeeAggregate: entry.detail.isMonthlyFeeAggregate,
              postingState: entry.postingState,
              skipReason: entry.skipReason,
              updatedAt: now,
            })
            .where(
              and(
                eq(journalEntries.userId, userId),
                eq(journalEntries.id, existingStub.id)
              )
            )
            .execute();

          await tx
            .delete(journalEntryLines)
            .where(
              and(
                eq(journalEntryLines.userId, userId),
                eq(journalEntryLines.journalEntryId, existingStub.id)
              )
            )
            .execute();

          for (const line of entry.lines) {
            await tx
              .insert(journalEntryLines)
              .values({
                id: randomUUID(),
                journalEntryId: existingStub.id,
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

          return { entryId: existingStub.id, entryNo: existingStub.entryNo };
        }
      }

      const entryNo = await persistJournalEntry(tx, userId, entry, entryId, null, now);
      return { entryId, entryNo };
    };

    const res = await (conn === db
      ? db.transaction(async (tx) => executePersist(tx))
      : executePersist(conn as TxClient));
    return { ok: true, entryId: res.entryId, entryNo: res.entryNo };
  } catch (error) {
    console.error("createJournalEntry: failed to persist entry", safeErrorLog(error));
    return { ok: false, errors: ["Failed to persist journal entry"] };
  }
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
const MANUAL_EQUITY_CAPITAL_THB = "3020";

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
  // THB deposits need a THB owner-capital account (3020) so both legs share a
  // currency; USD uses the classic 3010. Unsupported currencies fall back to
  // 3010 and are rejected later by the account-currency compatibility check,
  // so they stay SKIPPED instead of posting mismatched legs.
  const equity = input.currency === "THB" ? MANUAL_EQUITY_CAPITAL_THB : MANUAL_EQUITY_CAPITAL;
  const fx = input.currency === "THB" ? "1" : input.fxRateEffective;
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
    ? [line(cash, "debit"), line(equity, "credit")]
    : [line(equity, "debit"), line(cash, "credit")];
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
    amount: roundMoney(input.amountForeign),
    amountThb: input.currency === "THB" ? roundMoney(input.amountForeign)
      : input.fxRateEffective && new Decimal(input.fxRateEffective).isFinite() && new Decimal(input.fxRateEffective).gt(0)
        ? moneyInThb(input.amountForeign, input.fxRateEffective) : null,
    fxRateEffective: input.currency === "THB" ? "1" : input.fxRateEffective || null,
    fxRateStatement: null,
    isFxConversion: false,
    exchangeFromCurrency: null,
    exchangeFromAmount: null,
    exchangeRate: null,
    isMonthlyFeeAggregate: false,
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
  input: ManualCashJournalInput,
  conn: Conn = db
): Promise<CreateEntryResult> {
  let lookup = await loadAccountLookup(userId, conn);
  if (lookup.size === 0) {
    const seeded = await seedDefaultChartOfAccounts(userId, conn);
    if (seeded > 0) lookup = await loadAccountLookup(userId, conn);
  } else if (!lookup.has("3020")) {
    const seeded = await seedDefaultChartOfAccounts(userId, conn);
    if (seeded > 0) lookup = await loadAccountLookup(userId, conn);
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
    return insertBackfilledJournalEntry(
      userId,
      {
        ...entryInput, sourceType: "MANUAL", sourceDocumentId: null,
        sourceTransactionId: input.transactionId, type: input.type,
        postingState: "SKIPPED", skipReason: resolved.errors.join("; "),
        detail: manualCashDetail(input),
      },
      conn,
    );
  }
  const validated = validateJournalEntry({
    ...entryInput,
    lines: resolved.lines,
  });
  if (!validated.ok) {
    return { ok: false, errors: validated.errors };
  }

  const entryId = randomUUID();
  const now = new Date().toISOString();
  try {
    let entryNo: number;
    if (conn === db) {
      entryNo = await db.transaction(async (tx) =>
        persistJournalEntry(tx, userId, validated.entry, entryId, input.type, now)
      );
    } else {
      entryNo = await persistJournalEntry(
        conn as TxClient,
        userId,
        validated.entry,
        entryId,
        input.type,
        now
      );
    }
    return { ok: true, entryId, entryNo };
  } catch (error) {
    console.error("insertManualCashJournal: failed to persist entry", safeErrorLog(error));
    return { ok: false, errors: ["Failed to persist journal entry"] };
  }
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
  input: BackfilledJournalEntryInput,
  conn: Conn = db
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

  const entryId = randomUUID();
  const now = new Date().toISOString();
  try {
    let entryNo: number;
    if (conn === db) {
      entryNo = await db.transaction(async (tx) =>
        persistJournalEntry(tx, userId, validated.entry, entryId, input.type, now)
      );
    } else {
      entryNo = await persistJournalEntry(
        conn as TxClient,
        userId,
        validated.entry,
        entryId,
        input.type,
        now
      );
    }
    return { ok: true, entryId, entryNo };
  } catch (error) {
    console.error("insertBackfilledJournalEntry: failed to persist entry", safeErrorLog(error));
    return { ok: false, errors: ["Failed to persist journal entry"] };
  }
}

/**
 * Sync the linked journal entry when a capital-ledger row is edited (PUT).
 * Updates the money/date/currency/type header fields so every journal-based
 * read stays fresh, and rebuilds the two-line equity entry (cash + owner
 * equity) so the manual rows and cash summary stay correct. Resolve currencies
 * and account UUIDs before replacing anything; unsupported accounts produce a
 * SKIPPED record. Statement entries are untouched. Best-effort: never throws.
 */
export async function syncCapitalLedgerJournal(
  userId: string,
  transactionId: string,
  current: ManualCashJournalInput,
  conn: Conn = db
): Promise<void> {
  const now = new Date().toISOString();
  // Only MANUAL two-leg equity entries are rebuilt; statement-linked entries
  // (created by insertStatementImport) keep their original posting lines.
  // When called with an explicit conn (the PUT route's atomic transaction), a
  // MANUAL entry that cannot represent the edited row is a real inconsistency
  // and is rethrown so the caller's transaction rolls back; the legacy
  // best-effort path (conn === db) swallows failures exactly as before.
  const runSync = async (c: DbClient | TxClient, strict: boolean) => {
    const [owned] = await c
      .select({ id: journalEntries.id, entryNo: journalEntries.entryNo })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.userId, userId),
          eq(journalEntries.sourceTransactionId, transactionId),
          eq(journalEntries.sourceType, "MANUAL")
        )
      )
      .limit(1)
      .for("update")
      .execute();
    if (!owned) return;

    const lookup = await loadAccountLookup(userId, c);
    const candidate: JournalEntryInput = {
      entryDate: current.transactionDate,
      description: current.type === "CASH_IN" ? "ฝากเงินเข้าบัญชี" : "ถอนเงินจากบัญชี",
      sourceType: "MANUAL", sourceTransactionId: transactionId,
      lines: manualCashLines(current), detail: manualCashDetail(current),
    };
    const resolved = resolveEntryAccountIds(candidate, lookup);
    const validated = resolved.ok
      ? validateJournalEntry({ ...candidate, lines: resolved.lines })
      : validateJournalEntry({ ...candidate, lines: [], postingState: "SKIPPED",
          skipReason: resolved.errors.join("; ") });
    if (!validated.ok) {
      if (strict) {
        throw new Error(
          `syncCapitalLedgerJournal: cannot represent edited row in journal: ${validated.errors.join("; ")}`
        );
      }
      return;
    }
    const entry = validated.entry;
    await c.update(journalEntries).set({
      ...entry.detail, entryDate: entry.entryDate, description: entry.description,
      type: current.type, postingState: entry.postingState, skipReason: entry.skipReason,
      updatedAt: now,
    }).where(and(eq(journalEntries.id, owned.id), eq(journalEntries.userId, userId)));
    await c.delete(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, owned.id), eq(journalEntryLines.userId, userId)));
    for (const line of entry.lines) {
      await c.insert(journalEntryLines).values({
        id: randomUUID(), journalEntryId: owned.id, userId, accountId: line.accountId,
        currency: line.currency, debitAmount: line.side === "DEBIT" ? line.amount : null,
        creditAmount: line.side === "CREDIT" ? line.amount : null, amountThb: line.amountThb,
        fxRateEffective: line.fxRateEffective, fxRateStatement: line.fxRateStatement,
        fxRateProvider: line.fxRateProvider, memo: line.memo,
      });
    }
  };

  try {
    if (conn === db) {
      await db.transaction((tx) => runSync(tx, false));
    } else {
      await runSync(conn, true);
    }
  } catch (error) {
    console.error("syncCapitalLedgerJournal: failed to sync entry", safeErrorLog(error));
    if (conn !== db) throw error;
  }
}

/**
 * Remove the linked journal entry (and its lines) when a capital-ledger row is
 * deleted (DELETE), so journal-based reads stop showing the deleted row.
 * Best-effort: never throws — a deletion must not fail because of it. With an
 * explicit conn the enclosing transaction owns atomicity with the capital row.
 */
export async function removeCapitalLedgerJournal(
  userId: string,
  transactionId: string,
  conn: Conn = db
): Promise<void> {
  try {
    const entries = await conn
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
      await conn
        .delete(journalEntryLines)
        .where(and(eq(journalEntryLines.journalEntryId, id), eq(journalEntryLines.userId, userId)))
        .execute();
      await conn
        .delete(journalEntries)
        .where(and(eq(journalEntries.id, id), eq(journalEntries.userId, userId)))
        .execute();
    }
  } catch (error) {
    console.error("removeCapitalLedgerJournal: failed to remove entry", safeErrorLog(error));
    // Inside the caller's transaction a commit-visible failure must abort the
    // whole DELETE (journal mirror + capital row together); the legacy
    // best-effort path keeps swallowing exactly as before.
    if (conn !== db) throw error;
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
  // seedDefaultChartOfAccounts is per-code idempotent, so this also grows the
  // CoA for existing users when a new default (3020 THB owner capital) appears.
  if (lookup.size === 0) {
    const seeded = await seedDefaultChartOfAccounts(userId);
    if (seeded > 0) lookup = await loadAccountLookup(userId);
  } else if (!lookup.has("3020")) {
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
    for (const sourceDocumentId of new Set(rows.map((row) => row.sourceDocumentId))) {
      await assertOwnedReferences(tx, userId, { sourceDocumentId });
    }
    for (const row of rows) {
      await tx
        .insert(capitalTransactions)
        .values({
          transactionId: row.transactionId,
          userId,
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
          isMonthlyFeeAggregate:
            row.isMonthlyFeeAggregate == null ? null : row.isMonthlyFeeAggregate === true,
        })
        .execute();
      transactionIds.push(row.transactionId);
    }

    const base = await nextEntryNo(userId, tx);
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
          isMonthlyFeeAggregate: entry.detail.isMonthlyFeeAggregate,
          postingState: entry.postingState,
          skipReason: entry.skipReason,
          type: entry.detail.isFxConversion ? null : plan.row.type,
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
// Persistence verification
// ---------------------------------------------------------------------------

export interface ImportPersistenceProof {
  ok: boolean;
  expectedRows: number;
  capitalRows: number;
  missingRows: string[];
  journalEntries: number;
  duplicateJournalTransactions: string[];
}

/**
 * Post-import persistence check. insertStatementImport commits Capital_Transactions
 * rows AND their journal entries atomically, but under a transaction pooler a
 * silent driver-level failure could still surface as a "success" with zero
 * persisted rows (the connection recycled mid-flow while named prepared
 * statements were in flight). So after an import we re-read the committed state
 * and require an EXACT match before the route writes STATEMENT_IMPORT success:
 *   - capital row count for the user+document must equal the count we just
 *     reported as inserted;
 *   - every transaction id we claimed to insert must exist as a committed row;
 *   - every claimed transaction id must have EXACTLY ONE linked journal entry
 *     (source_transaction_id), so the journal stays a 1:1 mirror of the ledger.
 * Pure read-only — never writes; safe to call after the import transaction.
 */
export async function verifyStatementImportPersistence(input: {
  userId: string;
  documentId: string;
  insertedCount: number;
  transactionIds: string[];
}): Promise<ImportPersistenceProof> {
  const { userId, documentId, insertedCount, transactionIds } = input;
  const proof: ImportPersistenceProof = {
    ok: false,
    expectedRows: insertedCount,
    capitalRows: 0,
    missingRows: [],
    journalEntries: 0,
    duplicateJournalTransactions: [],
  };

  if (insertedCount === 0) return proof;

  const capitalRows = await db
    .select({ transactionId: capitalTransactions.transactionId })
    .from(capitalTransactions)
    .where(
      and(
        eq(capitalTransactions.userId, userId),
        eq(capitalTransactions.sourceDocumentId, documentId),
        inArray(capitalTransactions.transactionId, transactionIds)
      )
    )
    .execute();
  proof.capitalRows = capitalRows.length;

  const foundIds = new Set(capitalRows.map((row) => row.transactionId));
  for (const id of transactionIds) {
    if (!foundIds.has(id)) proof.missingRows.push(id);
  }

  const journalProof = await db
    .select({
      sourceTransactionId: journalEntries.sourceTransactionId,
      total: sql<number>`count(*)::int`,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, userId),
        inArray(journalEntries.sourceTransactionId, transactionIds)
      )
    )
    .groupBy(journalEntries.sourceTransactionId)
    .execute();

  proof.journalEntries = journalProof.reduce(
    (sum, row) => sum + row.total,
    0
  );
  proof.duplicateJournalTransactions = journalProof
    .filter((row) => row.total > 1)
    .map((row) => row.sourceTransactionId ?? "");

  proof.ok =
    proof.missingRows.length === 0 &&
    proof.capitalRows === insertedCount &&
    proof.journalEntries === insertedCount &&
    proof.duplicateJournalTransactions.length === 0;
  return proof;
}

// ---------------------------------------------------------------------------
// Reconcile statement-derived state (SELL gains, journal postings, cost-basis
// cache) from the FINAL authoritative ledger rows + corporate actions. A pure
// function of the row set, so the outcome never depends on import/delete order:
//   - reconcileStatementDeletion — runs INSIDE the caller's deletion
//     transaction, AFTER the deleted rows/entries are gone (failures roll back
//     the whole delete).
//   - reconcileStatementImport   — runs inside its OWN transaction AFTER an
//     import committed, so deleting a statement and re-importing it converges
//     to the SAME state as a clean (never-deleted) import of the same set.
//
// Recomputed deterministically (never a fill-NULL-only backfill): the affected
// AI_PARSED SELL rows, their linked journal entries (accounts resolved, entries
// validated, lines rewritten) and the rebuilt cost-basis cache.
export async function reconcileStatementDeletion(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  affectedSymbols: Set<string>,
): Promise<void> {
  await reconcileStatementState(userId, affectedSymbols, tx);
}

/**
 * Reconcile cost basis, gain/loss, journal lines, and cost_basis_state for affected symbols.
 */
export async function reconcileAffectedInvestmentState(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  affectedSymbols: Set<string>,
): Promise<void> {
  await reconcileStatementState(userId, affectedSymbols, tx);
}

/** Reconcile in a fresh transaction after a committed statement import. */
export async function reconcileStatementImport(
  userId: string,
  affectedSymbols: Set<string>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await reconcileStatementState(userId, affectedSymbols, tx);
  });
}

async function reconcileStatementState(
  userId: string,
  affectedSymbols: Set<string>,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<void> {
  const rows = await tx.select().from(capitalTransactions)
    .where(eq(capitalTransactions.userId, userId))
    .orderBy(capitalTransactions.transactionDate, capitalTransactions.transactionId);
  const actions = await tx.select().from(corporateActions)
    .where(eq(corporateActions.userId, userId)) as CostBasisActionRow[];
  // A parent position can contribute basis to a renamed/spun-off child.
  for (let i = 0; i < actions.length; i++) {
    for (const action of actions) {
      if (affectedSymbols.has(action.symbol) && action.newSymbol) affectedSymbols.add(action.newSymbol);
    }
  }
  const { updates } = recomputeAllGainLoss(rows, actions);
  const gains = new Map(updates.map(update => [update.transactionId, update.update]));
  const accountRows = await tx.select().from(accounts).where(eq(accounts.userId, userId));
  const lookup = new Map<string, ResolvedAccount>();
  for (const account of accountRows) {
    lookup.set(account.id, account);
    lookup.set(account.code, account);
  }
  for (const row of rows) {
    if (row.sourceType !== "AI_PARSED" || row.side !== "SELL" || !row.symbol || !affectedSymbols.has(row.symbol)) continue;
    // A deleted BUY can make an already-computed SELL non-computable. The
    // hole-only backfill cannot clear these stale values.
    const update = gains.get(row.transactionId) ?? {
      costBasis: null, proceeds: row.proceeds, realizedGainLoss: null, realizedGainLossThb: null,
    };
    const changed = Object.entries(update).some(([key, value]) => {
      const old = row[key as keyof typeof update];
      return old === null || value === null ? old !== value : !new Decimal(old).eq(value);
    });
    if (!changed) continue;
    await tx.update(capitalTransactions).set(update).where(and(
      eq(capitalTransactions.userId, userId), eq(capitalTransactions.transactionId, row.transactionId)));
    const [plan] = buildStatementJournalEntries([{ ...row, ...update } as ValidatedCapitalRow]);
    const resolved = resolveEntryAccountIds(plan.entry, lookup);
    if (!resolved.ok) throw new Error("Cannot reconcile statement accounts");
    const validated = validateJournalEntry({ ...plan.entry, lines: resolved.lines });
    if (!validated.ok || currencyMismatchErrors(validated.entry, lookup).length) {
      throw new Error("Cannot reconcile statement journal");
    }
    const entry = validated.entry;
    const linked = await tx.select().from(journalEntries).where(and(
      eq(journalEntries.userId, userId), eq(journalEntries.sourceType, "STATEMENT"),
      eq(journalEntries.sourceTransactionId, row.transactionId)));
    for (const journal of linked) {
      await tx.delete(journalEntryLines).where(and(eq(journalEntryLines.userId, userId),
        eq(journalEntryLines.journalEntryId, journal.id)));
      await tx.update(journalEntries).set({
        ...update, averageCost: entry.detail.averageCost ?? null,
        postingState: entry.postingState, skipReason: entry.skipReason ?? null, updatedAt: new Date().toISOString(),
      }).where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, journal.id)));
      for (const line of entry.lines) {
        await tx.insert(journalEntryLines).values({
          id: randomUUID(), userId, journalEntryId: journal.id, accountId: line.accountId,
          currency: line.currency, debitAmount: line.side === "DEBIT" ? line.amount : null,
          creditAmount: line.side === "CREDIT" ? line.amount : null, amountThb: line.amountThb,
          fxRateEffective: line.fxRateEffective, fxRateStatement: line.fxRateStatement,
          fxRateProvider: line.fxRateProvider, memo: line.memo,
        });
      }
    }
  }
  const basis = recomputeCostBasisMap(rows, actions);
  await saveCostBasisState(userId, basis, tx);
}

/** Result of a deterministic replay of SKIPPED STATEMENT equity rows. */
export interface ReconcileSkippedEquityResult {
  /** Journal entries whose linked source row was re-evaluated. */
  scanned: number;
  /** SKIPPED entries whose replay produced a keepable POSTED entry (both modes). */
  promotable: number;
  /** SKIPPED entries the replay promoted to POSTED (real lines written). 0 in a dry run. */
  promoted: number;
  /** Rows that remain SKIPPED after the replay + why (idempotent re-run safe). */
  stillSkipped: { transactionId: string; reason: string }[];
  /** True when opts.apply was NOT set: zero database writes were made. */
  dryRun: boolean;
}

/**
 * Deterministic reconcile of existing SKIPPED STATEMENT equity rows (the
 * pre-3020 THB deposits are the motivating case: posted 1010/3010 was never
 * possible, so imports SKIPPED them). This re-runs the REAL posting engine —
 * postCapitalRow/buildStatementPostings — against the user's CURRENT chart of
 * accounts (3020 seeded idempotently if missing). Every promoted entry is
 * rebuilt through validateJournalEntry + resolveEntryAccountIds +
 * currencyMismatchErrors, exactly like a fresh import, so NO hand-written lines
 * and NO mutation of the source Capital_Transactions values: a re-import of the
 * same statement produces the identical entry. Non-equity SKIPPED rows (SELL
 * without basis, FX-only, standalone-fee ambiguity) are never touched.
 *
 * DEFAULT IS A DRY RUN (`opts.apply` absent/false): it only SELECTs and reports
 * what WOULD be promoted (promoted stays 0). `apply: true` seeds the CoA (3020
 * is a default) and promotes in per-entry transactions. Idempotent: a second
 * apply promotes 0.
 */
export async function reconcileSkippedEquityPostings(
  userId: string,
  opts: { apply?: boolean } = {}
): Promise<ReconcileSkippedEquityResult> {
  const dryRun = opts.apply !== true;
  // A dry run must make ZERO database writes: never seed the chart of accounts
  // (that INSERTs). Promotion seeds first so a missing 3020 is not a blocker.
  let lookup = await loadAccountLookup(userId);
  if (!dryRun) {
    const seeded = await seedDefaultChartOfAccounts(userId);
    if (seeded > 0) lookup = await loadAccountLookup(userId);
  }

  const rows = await db
    .select()
    .from(capitalTransactions)
    .where(eq(capitalTransactions.userId, userId))
    .orderBy(capitalTransactions.transactionDate, capitalTransactions.transactionId)
    .execute();
  const rowById = new Map(rows.map((r) => [r.transactionId, r]));

  const skippedEntries = await db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, userId),
        eq(journalEntries.sourceType, "STATEMENT"),
        eq(journalEntries.postingState, "SKIPPED")
      )
    )
    .orderBy(asc(journalEntries.entryNo))
    .execute();

  const result: ReconcileSkippedEquityResult = {
    scanned: 0, promotable: 0, promoted: 0, stillSkipped: [], dryRun,
  };
  const now = new Date().toISOString();

  for (const entry of skippedEntries) {
    if (!entry.sourceTransactionId) continue;
    const row = rowById.get(entry.sourceTransactionId);
    if (!row) continue;
    if ((row.category ?? "").trim().toLowerCase() !== "equity") continue;

    result.scanned += 1;
    // Replay ONLY through the pure engine (identical to a fresh import).
    const [plan] = buildStatementJournalEntries([row as ValidatedCapitalRow]);
    if (!plan || plan.postingState !== "POSTED") {
      result.stillSkipped.push({
        transactionId: row.transactionId,
        reason: plan?.reason ?? entry.skipReason ?? "replay did not produce a keepable entry",
      });
      continue;
    }

    const resolved = resolveEntryAccountIds(plan.entry, lookup);
    if (!resolved.ok) {
      result.stillSkipped.push({
        transactionId: row.transactionId,
        reason: resolved.errors.join("; "),
      });
      continue;
    }
    const validated = validateJournalEntry({ ...plan.entry, lines: resolved.lines });
    if (!validated.ok || currencyMismatchErrors(validated.entry, lookup).length > 0) {
      const reason = !validated.ok
        ? `invalid entry: ${validated.errors.join("; ")}`
        : currencyMismatchErrors(validated.entry, lookup).join("; ");
      result.stillSkipped.push({ transactionId: row.transactionId, reason });
      continue;
    }

    result.promotable += 1;
    // Dry run: report what WOULD be promoted; zero database writes.
    if (dryRun) continue;

    // Promote: replace the SKIPPED record with the same header + REAL lines.
    try {
      await db.transaction(async (tx) => {
        await tx
          .delete(journalEntryLines)
          .where(
            and(
              eq(journalEntryLines.userId, userId),
              eq(journalEntryLines.journalEntryId, entry.id)
            )
          )
          .execute();
        await tx
          .update(journalEntries)
          .set({ postingState: "POSTED", skipReason: null, updatedAt: now })
          .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, entry.id)))
          .execute();
        for (const line of validated.entry.lines) {
          await tx.insert(journalEntryLines).values({
            id: randomUUID(), userId, journalEntryId: entry.id, accountId: line.accountId,
            currency: line.currency, debitAmount: line.side === "DEBIT" ? line.amount : null,
            creditAmount: line.side === "CREDIT" ? line.amount : null, amountThb: line.amountThb,
            fxRateEffective: line.fxRateEffective, fxRateStatement: line.fxRateStatement,
            fxRateProvider: line.fxRateProvider, memo: line.memo,
          }).execute();
        }
      });
      result.promoted += 1;
    } catch (error) {
      safeErrorLog(error);
      result.stillSkipped.push({
        transactionId: row.transactionId,
        reason: "transaction failed during promotion",
      });
    }
  }

  return result;
}

/** One evaluated SKIPPED STATEMENT currency-exchange row. */
export interface FxReconcileEntryReport {
  transactionId: string;
  transactionDate: string;
  from: string | null;
  to: string | null;
  /** Sent amount in the source currency (statement verbatim). */
  sentAmount: string;
  /** Received amount in the target currency (statement verbatim). */
  receivedAmount: string;
  oldSkipReason: string | null;
  /** Candidate line count (3 = with 5020 variance leg, 2 = balanced). */
  lineCount: number;
  /** THB 5020 FX-variance leg amount (null when the exchange balances natively). */
  varianceThb: string | null;
  varianceSide: "DEBIT" | "CREDIT" | null;
  /** Candidate total THB debits and credits (equal for a keepable entry). */
  debitThb: string;
  creditThb: string;
}

export interface ReconcileSkippedFxResult {
  scanned: number;
  /** Rows whose replay produced a keepable POSTED entry (both modes). */
  promotable: number;
  /** Rows actually promoted (real lines written). 0 in a dry run. */
  promoted: number;
  /** Rows that remain SKIPPED after the replay + why (idempotent re-run safe). */
  stillSkipped: { transactionId: string; reason: string }[];
  entries: FxReconcileEntryReport[];
  /** True when opts.apply was NOT set: zero database writes were made. */
  dryRun: boolean;
}

/**
 * Deterministic reconcile of existing SKIPPED STATEMENT currency-exchange rows.
 * Confirmed exchanges (category asset, side null, type FX_CONVERSION) that were
 * recorded SKIPPED by earlier imports — e.g. the production row pairs whose
 * statement FX yields a small THB variance (5000 THB -> 158.60 USD @ 31.5457 =
 * +3.15) — are replayed through the REAL engine and, when keepable, promoted
 * with their cash legs + the 5020 THB FX-variance leg, exactly like a fresh
 * import of the same statement would produce. NEVER writes by hand and NEVER
 * mutates the source Capital_Transactions values.
 *
 * DEFAULT IS A DRY RUN (`opts.apply` absent/false): it only SELECTs and reports
 * what WOULD be promoted (promoted stays 0). `apply: true` seeds the CoA (5020
 * is a default) and promotes in per-entry transactions, preserving the existing
 * journal entry id/entry_no and source links. Idempotent: a second apply
 * promotes 0.
 */
export async function reconcileSkippedFxPostings(
  userId: string,
  opts: { apply?: boolean } = {}
): Promise<ReconcileSkippedFxResult> {
  const dryRun = opts.apply !== true;
  // A dry run must make ZERO database writes: never seed the chart of accounts
  // (that INSERTs). Promotion seeds first so a missing 5020 is not a blocker.
  let lookup = await loadAccountLookup(userId);
  if (!dryRun) {
    const seeded = await seedDefaultChartOfAccounts(userId);
    if (seeded > 0) lookup = await loadAccountLookup(userId);
  }

  const rows = await db
    .select()
    .from(capitalTransactions)
    .where(eq(capitalTransactions.userId, userId))
    .orderBy(capitalTransactions.transactionDate, capitalTransactions.transactionId)
    .execute();
  const rowById = new Map(rows.map((r) => [r.transactionId, r]));

  const skippedEntries = await db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, userId),
        eq(journalEntries.sourceType, "STATEMENT"),
        eq(journalEntries.postingState, "SKIPPED")
      )
    )
    .orderBy(asc(journalEntries.entryNo))
    .execute();

  const result: ReconcileSkippedFxResult = {
    scanned: 0, promotable: 0, promoted: 0, stillSkipped: [], entries: [], dryRun,
  };
  const now = new Date().toISOString();
  const cashIds = new Set(
    [...lookup.values()]
      .filter((a) => a.type === "ASSET" && (a.code === "1010" || a.code === "1020"))
      .map((a) => a.id)
  );

  for (const entry of skippedEntries) {
    if (!entry.sourceTransactionId) continue;
    const row = rowById.get(entry.sourceTransactionId);
    if (!row) continue;
    const category = (row.category ?? "").trim().toLowerCase();
    const sideRaw = (row.side ?? "").trim();
    const isFxRow =
      category === "asset" &&
      (sideRaw === "" || sideRaw === "null") &&
      (row.type ?? "").trim() === "FX_CONVERSION";
    if (!isFxRow) continue;

    result.scanned += 1;
    // Replay ONLY through the pure engine (identical to a fresh import).
    const [plan] = buildStatementJournalEntries([row as ValidatedCapitalRow]);
    if (!plan || plan.postingState !== "POSTED") {
      result.stillSkipped.push({
        transactionId: row.transactionId,
        reason: plan?.reason ?? entry.skipReason ?? "replay did not produce a keepable entry",
      });
      continue;
    }

    const resolved = resolveEntryAccountIds(plan.entry, lookup);
    if (!resolved.ok) {
      result.stillSkipped.push({
        transactionId: row.transactionId,
        reason: resolved.errors.join("; "),
      });
      continue;
    }
    const validated = validateJournalEntry({ ...plan.entry, lines: resolved.lines });
    if (!validated.ok || currencyMismatchErrors(validated.entry, lookup).length > 0) {
      const reason = !validated.ok
        ? `invalid entry: ${validated.errors.join("; ")}`
        : currencyMismatchErrors(validated.entry, lookup).join("; ");
      result.stillSkipped.push({ transactionId: row.transactionId, reason });
      continue;
    }

    const varianceLine = validated.entry.lines.find(
      (l) => l.currency === "THB" && !cashIds.has(l.accountId) && l.memo === FX_VARIANCE_MEMO
    );
    const debitThb = Decimal.sum(
      0,
      ...validated.entry.lines.filter((l) => l.side === "DEBIT").map((l) => l.amountThb)
    ).toFixed(2);
    const creditThb = Decimal.sum(
      0,
      ...validated.entry.lines.filter((l) => l.side === "CREDIT").map((l) => l.amountThb)
    ).toFixed(2);
    result.entries.push({
      transactionId: row.transactionId,
      transactionDate: row.transactionDate,
      from: row.exchangeFromCurrency ?? null,
      to: row.currency ?? null,
      sentAmount: row.exchangeFromAmount ?? "",
      receivedAmount: row.amountForeign ?? "",
      oldSkipReason: entry.skipReason,
      lineCount: validated.entry.lines.length,
      varianceThb: varianceLine?.amount ?? null,
      varianceSide: varianceLine?.side ?? null,
      debitThb,
      creditThb,
    });
    result.promotable += 1;
    if (dryRun) continue;

    // Promote: replace the SKIPPED record with the same header + REAL lines.
    try {
      await db.transaction(async (tx) => {
        await tx
          .delete(journalEntryLines)
          .where(
            and(
              eq(journalEntryLines.userId, userId),
              eq(journalEntryLines.journalEntryId, entry.id)
            )
          )
          .execute();
        await tx
          .update(journalEntries)
          .set({ postingState: "POSTED", skipReason: null, updatedAt: now })
          .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, entry.id)))
          .execute();
        for (const line of validated.entry.lines) {
          await tx.insert(journalEntryLines).values({
            id: randomUUID(), userId, journalEntryId: entry.id, accountId: line.accountId,
            currency: line.currency, debitAmount: line.side === "DEBIT" ? line.amount : null,
            creditAmount: line.side === "CREDIT" ? line.amount : null, amountThb: line.amountThb,
            fxRateEffective: line.fxRateEffective, fxRateStatement: line.fxRateStatement,
            fxRateProvider: line.fxRateProvider, memo: line.memo,
          }).execute();
        }
      });
      result.promoted += 1;
    } catch (error) {
      safeErrorLog(error);
      result.stillSkipped.push({
        transactionId: row.transactionId,
        reason: "transaction failed during promotion",
      });
    }
  }

  return result;
}

/** One evaluated SKIPPED STATEMENT THB-imbalance row. */
export interface RoundingReconcileEntryReport {
  transactionId: string;
  transactionDate: string;
  oldSkipReason: string | null;
  /** Candidate line count (4 = with the 5020 THB rounding adjustment leg). */
  lineCount: number;
  /** THB 5020 rounding-adjustment leg amount (null when the entry needs none). */
  adjustmentThb: string | null;
  adjustmentSide: "DEBIT" | "CREDIT" | null;
  /** Candidate total THB debits and credits (equal for a keepable entry). */
  debitThb: string;
  creditThb: string;
}

export interface ReconcileSkippedRoundingResult {
  scanned: number;
  /** Rows whose replay produced a keepable POSTED entry (both modes). */
  promotable: number;
  /** Rows actually promoted (real lines written). 0 in a dry run. */
  promoted: number;
  /** Rows that remain SKIPPED after the replay + why (idempotent re-run safe). */
  stillSkipped: { transactionId: string; reason: string }[];
  entries: RoundingReconcileEntryReport[];
  /** True when opts.apply was NOT set: zero database writes were made. */
  dryRun: boolean;
}

/**
 * Deterministic reconcile of existing SKIPPED STATEMENT rows whose journal entry
 * carries a THB reporting-base imbalance (skipReason `THB does not balance`).
 * The auto rounding-adjustment leg now fixes otherwise-valid single-currency
 * non-THB entries whose per-leg THB rounding drifts by <= 0.01 (e.g. a BUY
 * whose Dr 1110 + Dr 5010 report 2733.97 against a Cr 1020 of 2733.96 posts a
 * CREDIT 5020 0.01). Every candidate is replayed through the REAL engine
 * (postCapitalRow -> auto rounding leg -> validate) and, when keepable, the
 * SKIPPED record is promoted with the exact engine lines. NEVER writes by hand,
 * NEVER mutates the source Capital_Transactions values, and NEVER touches FX
 * conversion rows (category asset, side null, type FX_CONVERSION) — those
 * belong exclusively to reconcileSkippedFxPostings.
 *
 * DEFAULT IS A DRY RUN (`opts.apply` absent/false): it only SELECTs and reports
 * what WOULD be promoted (promoted stays 0). `apply: true` seeds the CoA (5020
 * is a default) and promotes in per-entry transactions, preserving the existing
 * journal entry id/entry_no and source links. Idempotent: a second apply
 * promotes 0.
 */
export async function reconcileSkippedRoundingPostings(
  userId: string,
  opts: { apply?: boolean } = {}
): Promise<ReconcileSkippedRoundingResult> {
  const dryRun = opts.apply !== true;
  // A dry run must make ZERO database writes: never seed the chart of accounts
  // (that INSERTs). Promotion seeds first so a missing 5020 is not a blocker.
  let lookup = await loadAccountLookup(userId);
  if (!dryRun) {
    const seeded = await seedDefaultChartOfAccounts(userId);
    if (seeded > 0) lookup = await loadAccountLookup(userId);
  }

  const rows = await db
    .select()
    .from(capitalTransactions)
    .where(eq(capitalTransactions.userId, userId))
    .orderBy(capitalTransactions.transactionDate, capitalTransactions.transactionId)
    .execute();
  const rowById = new Map(rows.map((r) => [r.transactionId, r]));

  const skippedEntries = await db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, userId),
        eq(journalEntries.sourceType, "STATEMENT"),
        eq(journalEntries.postingState, "SKIPPED"),
        ilike(journalEntries.skipReason, "%THB does not balance%")
      )
    )
    .orderBy(asc(journalEntries.entryNo))
    .execute();

  const result: ReconcileSkippedRoundingResult = {
    scanned: 0, promotable: 0, promoted: 0, stillSkipped: [], entries: [], dryRun,
  };
  const now = new Date().toISOString();

  for (const entry of skippedEntries) {
    if (!entry.sourceTransactionId) continue;
    const row = rowById.get(entry.sourceTransactionId);
    if (!row) continue;
    const category = (row.category ?? "").trim().toLowerCase();
    const sideRaw = (row.side ?? "").trim();
    const isFxRow =
      category === "asset" &&
      (sideRaw === "" || sideRaw === "null") &&
      (row.type ?? "").trim() === "FX_CONVERSION";
    if (isFxRow) continue;

    result.scanned += 1;
    // Replay ONLY through the pure engine (identical to a fresh import).
    const [plan] = buildStatementJournalEntries([row as ValidatedCapitalRow]);
    if (!plan || plan.postingState !== "POSTED") {
      result.stillSkipped.push({
        transactionId: row.transactionId,
        reason: plan?.reason ?? entry.skipReason ?? "replay did not produce a keepable entry",
      });
      continue;
    }

    const resolved = resolveEntryAccountIds(plan.entry, lookup);
    if (!resolved.ok) {
      result.stillSkipped.push({
        transactionId: row.transactionId,
        reason: resolved.errors.join("; "),
      });
      continue;
    }
    const validated = validateJournalEntry({ ...plan.entry, lines: resolved.lines });
    if (!validated.ok || currencyMismatchErrors(validated.entry, lookup).length > 0) {
      const reason = !validated.ok
        ? `invalid entry: ${validated.errors.join("; ")}`
        : currencyMismatchErrors(validated.entry, lookup).join("; ");
      result.stillSkipped.push({ transactionId: row.transactionId, reason });
      continue;
    }

    const cashIds = new Set(
      [...lookup.values()]
        .filter((a) => a.type === "ASSET" && (a.code === "1010" || a.code === "1020"))
        .map((a) => a.id)
    );
    const adjustmentLine = validated.entry.lines.find(
      (l) => l.currency === "THB" && !cashIds.has(l.accountId) && l.memo === ROUNDING_ADJUSTMENT_MEMO
    );
    const debitThb = Decimal.sum(
      0,
      ...validated.entry.lines.filter((l) => l.side === "DEBIT").map((l) => l.amountThb)
    ).toFixed(2);
    const creditThb = Decimal.sum(
      0,
      ...validated.entry.lines.filter((l) => l.side === "CREDIT").map((l) => l.amountThb)
    ).toFixed(2);
    result.entries.push({
      transactionId: row.transactionId,
      transactionDate: row.transactionDate,
      oldSkipReason: entry.skipReason,
      lineCount: validated.entry.lines.length,
      adjustmentThb: adjustmentLine?.amount ?? null,
      adjustmentSide: adjustmentLine?.side ?? null,
      debitThb,
      creditThb,
    });
    result.promotable += 1;
    if (dryRun) continue;

    // Promote: replace the SKIPPED record with the same header + REAL lines.
    try {
      await db.transaction(async (tx) => {
        await tx
          .delete(journalEntryLines)
          .where(
            and(
              eq(journalEntryLines.userId, userId),
              eq(journalEntryLines.journalEntryId, entry.id)
            )
          )
          .execute();
        await tx
          .update(journalEntries)
          .set({ postingState: "POSTED", skipReason: null, updatedAt: now })
          .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, entry.id)))
          .execute();
        for (const line of validated.entry.lines) {
          await tx.insert(journalEntryLines).values({
            id: randomUUID(), userId, journalEntryId: entry.id, accountId: line.accountId,
            currency: line.currency, debitAmount: line.side === "DEBIT" ? line.amount : null,
            creditAmount: line.side === "CREDIT" ? line.amount : null, amountThb: line.amountThb,
            fxRateEffective: line.fxRateEffective, fxRateStatement: line.fxRateStatement,
            fxRateProvider: line.fxRateProvider, memo: line.memo,
          }).execute();
        }
      });
      result.promoted += 1;
    } catch (error) {
      safeErrorLog(error);
      result.stillSkipped.push({
        transactionId: row.transactionId,
        reason: "transaction failed during promotion",
      });
    }
  }

  return result;
}

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
    isMonthlyFeeAggregate: boolean | null;
    exchangeFromCurrency: string | null;
    exchangeFromAmount: string | null;
    exchangeRate: string | null;
    type: string | null;
    note: string | null;
    updatedAt: string;
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
        updatedAt: journalEntries.updatedAt,
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
        exchangeFromCurrency: journalEntries.exchangeFromCurrency,
        exchangeFromAmount: journalEntries.exchangeFromAmount,
        exchangeRate: journalEntries.exchangeRate,
        isMonthlyFeeAggregate: journalEntries.isMonthlyFeeAggregate,
        type: journalEntries.type,
        note: journalEntries.note,
      },
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, and(eq(journalEntryLines.journalEntryId, journalEntries.id), eq(journalEntries.userId, journalEntryLines.userId)))
    .innerJoin(accounts, and(eq(accounts.id, journalEntryLines.accountId), eq(accounts.userId, journalEntryLines.userId)))
    // REVERSED originals remain posted economic events: their reversing entry offsets them.
    // Excluding the original would count only the inverse and corrupt every report.
    .where(and(...conditions, eq(journalEntries.postingState, "POSTED")))
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
      updatedAt: entry.updatedAt,
      postingState: entry.postingState === "SKIPPED" ? "SKIPPED" : "POSTED",
      skipReason: entry.skipReason,
      type: entry.type,
      note: entry.note,
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
        exchangeFromCurrency: entry.exchangeFromCurrency,
        exchangeFromAmount: entry.exchangeFromAmount,
        exchangeRate: entry.exchangeRate,
        isMonthlyFeeAggregate: entry.isMonthlyFeeAggregate,
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
      updatedAt: journalEntries.updatedAt,
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
      exchangeFromCurrency: journalEntries.exchangeFromCurrency,
      exchangeFromAmount: journalEntries.exchangeFromAmount,
      exchangeRate: journalEntries.exchangeRate,
      isMonthlyFeeAggregate: journalEntries.isMonthlyFeeAggregate,
      type: journalEntries.type,
      note: journalEntries.note,
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
 * Account ledger with a signed running balance in the DEBIT-POSITIVE accounting
 * convention (debits +, credits −), matching the Trial Balance `balance` column,
 * so credit-normal accounts (INCOME/LIABILITY/EQUITY) show negative balances
 * (e.g. a realized gain shows as a negative Y thousands in the gain account).
 * `opening` is the balance accumulated before `from` (account opening balance +
 * prior postings). `symbolSummary` groups the period's lines by their memo label
 * (per-stock, for a dividend account) — empty when no memo'd lines.
 */
export async function getAccountLedger(
  userId: string,
  accountId: string,
  from?: string,
  to?: string
): Promise<{
  opening: string;
  movement: string;
  closing: string;
  normalSide: Side;
  lines: LedgerLineView[];
  symbolSummary: LedgerSymbolSummary[];
} | null> {
  const [account, raw] = await Promise.all([
    db
      .select({ openingBalance: accounts.openingBalance, type: accounts.type })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
      .limit(1)
      .execute(),
    fetchRawLinesForAccount(userId, accountId, undefined, to),
  ]);

  if (!account.length) return null;

  const normalSide = normalSideOf(account[0].type as AccountMap[string]["type"]);
  let openingDec = new Decimal(account[0]?.openingBalance ?? "0");
  const movementOf = (r: RawLineWithEntry) => new Decimal(r.line.debitAmount ?? r.line.creditAmount ?? "0").mul(r.line.debitAmount != null ? 1 : -1);
  for (const r of raw) if (from && r.entry.entryDate < from) openingDec = openingDec.plus(movementOf(r));
  const period = raw.filter(r => !from || r.entry.entryDate >= from);
  let running = openingDec;
  const lines: LedgerLineView[] = [];
  for (const r of period) {
    running = running.plus(movementOf(r));
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
    movement: running.minus(openingDec).toFixed(2),
    closing: running.toFixed(2),
    normalSide,
    lines,
    symbolSummary: summarizeLinesBySymbol(period.map(toSymbolSummaryLine)),
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

/** Actual balances through to; from is retained for API compatibility, not a lower cutoff. */
export async function getTrialBalance(userId: string, from?: string, to?: string) {
  const [accountRows, raw] = await Promise.all([getAccounts(userId), fetchRawLines(userId, undefined, to)]);
  const accountMap = toAccountMap(accountRows);
  const lines = raw.map((r) => ({
    accountId: r.line.accountId,
    side: r.line.debitAmount != null ? ("DEBIT" as Side) : ("CREDIT" as Side),
    amount: r.line.debitAmount ?? r.line.creditAmount ?? "0",
    amountThb: r.line.amountThb,
    currency: r.line.currency,
  }));
  return trialBalance(lines, accountMap, Object.fromEntries(accountRows.filter(a => a.openingBalance != null).map(a => [a.id, a.openingBalance!])));
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
  const periodFrom = (to ?? new Date().toISOString().slice(0,10)).slice(0,4) + "-01-01";
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
      // rate at this layer, so nonzero foreign openings make THB totals unavailable.
      if (acc.currency === "THB") openingBalancesThb[acc.id] = acc.openingBalance;
    }
  }
  const lines = raw.map((r) => ({
    accountId: r.line.accountId,
    side: r.line.debitAmount != null ? ("DEBIT" as Side) : ("CREDIT" as Side),
    amount: r.line.debitAmount ?? r.line.creditAmount ?? "0",
    amountThb: r.line.amountThb,
  }));
  return { ...balanceSheet(lines, accountMap, openingBalances, openingBalancesThb, lines.filter((_, i) => raw[i].entry.entryDate >= periodFrom)), periodFrom };
}

// ---------------------------------------------------------------------------
// Monthly closing (งบปิดเดือน)
// ---------------------------------------------------------------------------

/**
 * Per-month account balances for the user's chart of accounts. `from`/`to`
 * are ISO dates that only limit WHICH months are reported; every month's
 * opening is still computed from the stored opening balance plus the full
 * prior history, so the figures equal a plain book-closing run regardless of
 * the requested window. Only POSTED lines (selectRawLines) feed the engine —
 * SKIPPED entries can never move a total or inflate a lineCount.
 */
export async function getMonthlyClosing(userId: string, from?: string, to?: string) {
  const [accountRows, raw] = await Promise.all([
    getAccounts(userId),
    fetchRawLines(userId, undefined, undefined),
  ]);
  const accounts: AccountLedgerSummaryInput[] = accountRows.map((a) => ({
    accountId: a.id,
    code: a.code,
    name: a.name,
    type: a.type as AccountType,
    currency: a.currency,
    openingBalance: a.openingBalance,
  }));
  const lines: MonthlyClosingLineInput[] = raw.map((r) => ({
    accountId: r.line.accountId,
    entryDate: r.entry.entryDate,
    side: r.line.debitAmount != null ? ("DEBIT" as Side) : ("CREDIT" as Side),
    amount: r.line.debitAmount ?? r.line.creditAmount ?? "0",
    amountThb: r.line.amountThb,
  }));
  return buildMonthlyClosing(accounts, lines, from, to);
}

// ---------------------------------------------------------------------------
// Ledger summary (overview)
// ---------------------------------------------------------------------------

export async function getLedgerSummary(userId: string) {
  const sheet = await getBalanceSheet(userId);
  const groups = (["ASSET", "LIABILITY", "EQUITY"] as const).flatMap(type => {
    const rows = type === "ASSET" ? sheet.assets : type === "LIABILITY" ? sheet.liabilities : sheet.equity;
    return [...new Set(rows.map(r => r.currency))].map(currency => {
      const accounts = rows.filter(r => r.currency === currency);
      return { type, currency, accounts,
        total: accounts.reduce((s,r) => s.plus(r.balance),new Decimal(0)).toFixed(2),
        totalThb: accounts.some(r => r.balanceThb == null) ? null : accounts.reduce((s,r) => s.plus(r.balanceThb!),new Decimal(0)).toFixed(2) };
    });
  });
  return { groups, totalsByCurrency: sheet.totalsByCurrency,
    totalsThb: { assets: sheet.totalAssetsThb, liabilities: sheet.totalLiabilitiesThb, equity: sheet.totalEquityThb,
      netIncome: sheet.netIncomeThb, totalAssets: sheet.totalAssetsThb, totalEquityAndLiabilities: sheet.totalEquityAndLiabilitiesThb, balanced: sheet.balancedThb },
    reportingStatus: sheet.reportingStatus, balanced: sheet.balanced, totalAssetsNaive: sheet.totalAssets, totalEquityAndLiabilitiesNaive: sheet.totalEquityAndLiabilities };
}
export type LedgerSummary = Awaited<ReturnType<typeof getLedgerSummary>>;
export type LedgerSummaryByType = LedgerSummary["groups"][number];
export type LedgerSummaryGroup = LedgerSummaryByType["accounts"][number];

// ---------------------------------------------------------------------------
// Account-category batch summary (one call per category, NO per-account N+1)
// ---------------------------------------------------------------------------

/**
 * Batch ledger summary for every account of one account class (ASSET, LIABILITY,
 * EQUITY, INCOME, EXPENSE). ONE database read fetches all POSTED lines for the
 * user's accounts of that type (bounded by `to`); the pure engine
 * `summarizeAccountLedgers` partitions them into opening (postings before `from`)
 * and period movement with exactly the same semantics as `getAccountLedger`.
 * SKIPPED entries are excluded by `selectRawLines` (postingState = POSTED), so
 * they can never move a total or inflate a lineCount.
 */
export async function getAccountCategorySummary(
  userId: string,
  type: AccountType,
  from?: string,
  to?: string
): Promise<{
  type: AccountType;
  from: string | null;
  to: string | null;
  summary: AccountLedgerSummaryResult;
  accounts: (AccountRow & { type: AccountType })[];
}> {
  const accountRows = (await getAccounts(userId)).filter((a): a is AccountRow & { type: AccountType } => a.type === type);
  if (accountRows.length === 0) {
    return { accounts: accountRows, type, from: from ?? null, to: to ?? null, summary: { rows: [], totalsByCurrency: [] } };
  }
  const ids = accountRows.map((a) => a.id);
  const conditions: (SQL | undefined)[] = [
    eq(journalEntryLines.userId, userId),
    inArray(journalEntryLines.accountId, ids),
  ];
  if (to) conditions.push(lte(journalEntries.entryDate, to));

  const raw = await selectRawLines(conditions);
  const lines: AccountLedgerSummaryLineInput[] = raw.map((r) => ({
    accountId: r.line.accountId,
    entryDate: r.entry.entryDate,
    side: r.line.debitAmount != null ? ("DEBIT" as Side) : ("CREDIT" as Side),
    amount: r.line.debitAmount ?? r.line.creditAmount ?? "0",
  }));
  const inputs: AccountLedgerSummaryInput[] = accountRows.map((a) => ({
    accountId: a.id,
    code: a.code,
    name: a.name,
    type: a.type as AccountType,
    currency: a.currency,
    openingBalance: a.openingBalance,
  }));
  return {
    type,
    from: from ?? null,
    to: to ?? null,
    summary: summarizeAccountLedgers(inputs, lines, from),
    accounts: accountRows,
  };
}

export type AccountCategorySummary = Awaited<ReturnType<typeof getAccountCategorySummary>>;

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

export type ReversalResult =
  | { ok: true; reversalEntryId: string; reversalEntryNo: number }
  | { ok: false; errors: string[] };

/**
 * Reverse a POSTED entry: marks the original REVERSED and posts an inverted
 * mirror with a new entry number (reversals are real events, not deletes).
 * Both the reversal entry AND the original's REVERSED flip commit in ONE
 * transaction, and the original row is locked FOR UPDATE so two concurrent
 * reversal requests serialize: the second one deterministically sees
 * "already reversed" instead of racing to post a duplicate mirror.
 */
export async function reverseJournalEntry(
  userId: string,
  entryId: string
): Promise<ReversalResult> {
  const now = new Date().toISOString();
  try {
    return await db.transaction(async (tx) => {
      const [header] = await tx
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, entryId)))
        .limit(1)
        .for("update")
        .execute();
      if (!header) return { ok: false, errors: ["Journal entry not found"] };
      if (header.status === "REVERSED") {
        return { ok: false, errors: ["Journal entry is already reversed"] };
      }

      const lineRows = await tx
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
        detail: { ...emptyTradeDetail(), isFxConversion: header.isFxConversion,
          category: header.category, currency: header.currency, amount: header.amount,
          exchangeFromCurrency: header.exchangeFromCurrency, exchangeFromAmount: header.exchangeFromAmount },
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

      // Create the reversal with the same resolve/validate chain as
      // createJournalEntry (lazy CoA seed not needed — a reversed entry by
      // definition already had resolvable accounts).
      const lookup = await loadAccountLookup(userId, tx);
      const resolved = resolveEntryAccountIds(
        {
          entryDate: candidate.entryDate,
          description: candidate.description,
          sourceType: "MANUAL",
          sourceTransactionId: candidate.sourceTransactionId,
          detail: candidate.detail,
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
        },
        lookup
      );
      if (!resolved.ok) return { ok: false, errors: resolved.errors };

      const validatedReversal = validateJournalEntry({
        entryDate: candidate.entryDate,
        description: candidate.description,
        sourceType: "MANUAL",
        sourceTransactionId: candidate.sourceTransactionId,
        detail: candidate.detail,
        lines: resolved.lines,
      });
      if (!validatedReversal.ok) return { ok: false, errors: validatedReversal.errors };

      const reversalEntryId = randomUUID();
      const reversalEntryNo = await persistJournalEntry(
        tx,
        userId,
        validatedReversal.entry,
        reversalEntryId,
        null,
        now
      );

      await tx
        .update(journalEntries)
        .set({ status: "REVERSED", updatedAt: now })
        .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, entryId)))
        .execute();

      return { ok: true, reversalEntryId, reversalEntryNo };
    });
  } catch (error) {
    console.error("reverseJournalEntry: failed to persist reversal", safeErrorLog(error));
    return { ok: false, errors: ["Failed to persist journal entry"] };
  }
}

/**
 * Fetch a single journal entry by its UUID with its lines and account details.
 */
export async function getJournalEntryById(
  userId: string,
  entryId: string
): Promise<PersistedJournalEntry | null> {
  const [accountRows, headerRows, lineRows] = await Promise.all([
    getAccounts(userId),
    db
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
        updatedAt: journalEntries.updatedAt,
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
        exchangeFromCurrency: journalEntries.exchangeFromCurrency,
        exchangeFromAmount: journalEntries.exchangeFromAmount,
        exchangeRate: journalEntries.exchangeRate,
        isMonthlyFeeAggregate: journalEntries.isMonthlyFeeAggregate,
        type: journalEntries.type,
        note: journalEntries.note,
      })
      .from(journalEntries)
      .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, entryId)))
      .limit(1)
      .execute(),
    db
      .select({
        id: journalEntryLines.id,
        journalEntryId: journalEntryLines.journalEntryId,
        accountId: journalEntryLines.accountId,
        currency: journalEntryLines.currency,
        debitAmount: journalEntryLines.debitAmount,
        creditAmount: journalEntryLines.creditAmount,
        amountThb: journalEntryLines.amountThb,
        fxRateEffective: journalEntryLines.fxRateEffective,
        fxRateStatement: journalEntryLines.fxRateStatement,
        fxRateProvider: journalEntryLines.fxRateProvider,
        memo: journalEntryLines.memo,
      })
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.userId, userId), eq(journalEntryLines.journalEntryId, entryId)))
      .orderBy(asc(journalEntryLines.id))
      .execute(),
  ]);

  const header = headerRows[0];
  if (!header) return null;
  const accountMap = toAccountMap(accountRows);
  const grouped = new Map<string, { entry: any; lines: any[] }>();
  grouped.set(header.id, { entry: header, lines: lineRows });
  const entries = toPersistedEntry(grouped, accountMap);
  return entries[0] ?? null;
}

export interface JournalAuditRecord {
  id: string;
  action: string;
  createdAt: string;
  details: unknown;
}

/**
 * Fetch audit log history for a journal entry.
 */
export async function getJournalEntryAuditHistory(
  userId: string,
  entryId: string
): Promise<JournalAuditRecord[]> {
  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      createdAt: auditLogs.createdAt,
      details: auditLogs.details,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.userId, userId),
        eq(auditLogs.entityId, entryId)
      )
    )
    .orderBy(desc(auditLogs.createdAt))
    .execute();
  return rows;
}

export interface EditJournalEntryInput {
  entryDate?: string;
  description?: string;
  note?: string | null;
  category?: string | null;
  type?: string | null;
  symbol?: string | null;
  side?: string | null;
  quantity?: string | null;
  unitPrice?: string | null;
  grossAmount?: string | null;
  fees?: string | null;
  netAmount?: string | null;
  currency?: string | null;
  amount?: string | null;
  fxRateEffective?: string | null;
  lines?: JournalLineInput[];
}

export type EditJournalEntryResult =
  | { ok: true; entry: PersistedJournalEntry }
  | { ok: false; status: number; errors: string[] };

/**
 * Edit a non-reversed journal entry atomically in a single transaction with
 * cost-basis recomputation and audit logging.
 */
export async function editJournalEntry(
  userId: string,
  entryId: string,
  updates: EditJournalEntryInput,
  reason?: string
): Promise<EditJournalEntryResult> {
  const now = new Date().toISOString();
  try {
    return await db.transaction(async (tx) => {
      const [header] = await tx
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, entryId)))
        .limit(1)
        .for("update")
        .execute();

      if (!header) {
        return { ok: false, status: 404, errors: ["Journal entry not found"] };
      }
      if (header.status === "REVERSED") {
        return { ok: false, status: 400, errors: ["Cannot edit a reversed journal entry"] };
      }
      if (header.description.startsWith("[REVERSAL OF #")) {
        return { ok: false, status: 400, errors: ["Cannot edit a reversing journal entry"] };
      }

      const existingLines = await tx
        .select()
        .from(journalEntryLines)
        .where(and(eq(journalEntryLines.userId, userId), eq(journalEntryLines.journalEntryId, entryId)))
        .orderBy(asc(journalEntryLines.id))
        .execute();

      const oldValues = {
        entryDate: header.entryDate,
        description: header.description,
        note: header.note,
        category: header.category,
        symbol: header.symbol,
        side: header.side,
        quantity: header.quantity,
        unitPrice: header.unitPrice,
        grossAmount: header.grossAmount,
        fees: header.fees,
        netAmount: header.netAmount,
        currency: header.currency,
        amount: header.amount,
        fxRateEffective: header.fxRateEffective,
        lines: existingLines.map((l) => ({
          accountId: l.accountId,
          currency: l.currency,
          side: l.debitAmount != null ? "DEBIT" : "CREDIT",
          amount: l.debitAmount ?? l.creditAmount ?? "0",
          memo: l.memo,
        })),
      };

      const newEntryDate = updates.entryDate?.trim() || header.entryDate;
      const newDescription = updates.description?.trim() || header.description;
      const newNote = updates.note !== undefined ? (updates.note?.trim() || null) : header.note;
      const newCategory = updates.category !== undefined ? updates.category : header.category;
      const newSymbol = updates.symbol !== undefined ? updates.symbol : header.symbol;
      const newSide = updates.side !== undefined ? updates.side : header.side;
      const newQuantity = updates.quantity !== undefined ? updates.quantity : header.quantity;
      const newUnitPrice = updates.unitPrice !== undefined ? updates.unitPrice : header.unitPrice;
      const newGrossAmount = updates.grossAmount !== undefined ? updates.grossAmount : header.grossAmount;
      const newFees = updates.fees !== undefined ? updates.fees : header.fees;
      const newNetAmount = updates.netAmount !== undefined ? updates.netAmount : header.netAmount;
      const newCurrency = updates.currency !== undefined ? updates.currency : header.currency;
      const newAmount = updates.amount !== undefined ? updates.amount : header.amount;
      const newFxRateEffective = updates.fxRateEffective !== undefined ? updates.fxRateEffective : header.fxRateEffective;

      let updatedPostingLines: {
        accountId: string;
        currency: string;
        debitAmount: string | null;
        creditAmount: string | null;
        amountThb: string;
        fxRateEffective: string;
        fxRateStatement: string | null;
        fxRateProvider: string | null;
        memo: string | null;
      }[] = [];

      let shouldReplaceLines = false;

      // Case A: explicit lines supplied
      if (updates.lines && updates.lines.length >= 2) {
        const lookup = await loadAccountLookup(userId, tx);
        const resolved = resolveEntryAccountIds(
          {
            entryDate: newEntryDate,
            description: newDescription,
            lines: updates.lines,
          },
          lookup
        );
        if (!resolved.ok) return { ok: false, status: 422, errors: resolved.errors };

        const validated = validateJournalEntry({
          entryDate: newEntryDate,
          description: newDescription,
          lines: resolved.lines,
        });
        if (!validated.ok) return { ok: false, status: 422, errors: validated.errors };

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
        if (currencyErrors.length > 0) return { ok: false, status: 422, errors: currencyErrors };

        shouldReplaceLines = true;
        updatedPostingLines = validated.entry.lines.map((l) => ({
          accountId: l.accountId,
          currency: l.currency,
          debitAmount: l.side === "DEBIT" ? l.amount : null,
          creditAmount: l.side === "CREDIT" ? l.amount : null,
          amountThb: l.amountThb,
          fxRateEffective: l.fxRateEffective,
          fxRateStatement: l.fxRateStatement,
          fxRateProvider: l.fxRateProvider,
          memo: l.memo,
        }));
      }

      // If linked to a Capital_Transactions row, update it and recompute cost basis
      if (header.sourceTransactionId) {
        const capUpdate: Record<string, unknown> = {};
        if (updates.entryDate) capUpdate.transactionDate = newEntryDate;
        if (updates.symbol !== undefined) capUpdate.symbol = newSymbol;
        if (updates.side !== undefined) capUpdate.side = newSide;
        if (updates.quantity !== undefined) capUpdate.quantity = newQuantity;
        if (updates.unitPrice !== undefined) capUpdate.unitPrice = newUnitPrice;
        if (updates.grossAmount !== undefined) capUpdate.grossAmount = newGrossAmount;
        if (updates.fees !== undefined) capUpdate.fees = newFees;
        if (updates.netAmount !== undefined) capUpdate.netAmount = newNetAmount;
        if (updates.currency !== undefined) capUpdate.currency = newCurrency;
        if (updates.amount !== undefined) capUpdate.amountForeign = newAmount;
        if (updates.fxRateEffective !== undefined) capUpdate.fxRateEffective = newFxRateEffective;

        if (Object.keys(capUpdate).length > 0) {
          await tx
            .update(capitalTransactions)
            .set(capUpdate)
            .where(
              and(
                eq(capitalTransactions.userId, userId),
                eq(capitalTransactions.transactionId, header.sourceTransactionId)
              )
            )
            .execute();

          if (!shouldReplaceLines) {
            const [updatedCapRow] = await tx
              .select()
              .from(capitalTransactions)
              .where(
                and(
                  eq(capitalTransactions.userId, userId),
                  eq(capitalTransactions.transactionId, header.sourceTransactionId)
                )
              )
              .limit(1)
              .execute();

            if (updatedCapRow) {
              const [plan] = buildStatementJournalEntries([updatedCapRow as ValidatedCapitalRow]);
              if (plan && plan.entry.lines.length > 0) {
                const lookup = await loadAccountLookup(userId, tx);
                const resolved = resolveEntryAccountIds(plan.entry, lookup);
                if (resolved.ok) {
                  const validated = validateJournalEntry({ ...plan.entry, lines: resolved.lines });
                  if (validated.ok && !currencyMismatchErrors(validated.entry, lookup).length) {
                    shouldReplaceLines = true;
                    updatedPostingLines = validated.entry.lines.map((l) => ({
                      accountId: l.accountId,
                      currency: l.currency,
                      debitAmount: l.side === "DEBIT" ? l.amount : null,
                      creditAmount: l.side === "CREDIT" ? l.amount : null,
                      amountThb: l.amountThb,
                      fxRateEffective: l.fxRateEffective,
                      fxRateStatement: l.fxRateStatement,
                      fxRateProvider: l.fxRateProvider,
                      memo: l.memo,
                    }));
                  }
                }
              }
            }
          }

          // Deterministic recomputation: recalculates affected SELL gains, updates GL lines and cache
          const affectedSymbols = new Set<string>();
          if (newSymbol) affectedSymbols.add(newSymbol);
          if (header.symbol) affectedSymbols.add(header.symbol);
          await reconcileStatementState(userId, affectedSymbols, tx);
        }
      }

      // Update journalEntries header
      await tx
        .update(journalEntries)
        .set({
          entryDate: newEntryDate,
          description: newDescription,
          note: newNote,
          category: newCategory,
          symbol: newSymbol,
          side: newSide,
          quantity: newQuantity,
          unitPrice: newUnitPrice,
          grossAmount: newGrossAmount,
          fees: newFees,
          netAmount: newNetAmount,
          currency: newCurrency,
          amount: newAmount,
          fxRateEffective: newFxRateEffective,
          updatedAt: now,
        })
        .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, entryId)))
        .execute();

      // Replace lines if updated
      if (shouldReplaceLines) {
        await tx
          .delete(journalEntryLines)
          .where(and(eq(journalEntryLines.userId, userId), eq(journalEntryLines.journalEntryId, entryId)))
          .execute();

        for (const line of updatedPostingLines) {
          await tx
            .insert(journalEntryLines)
            .values({
              id: randomUUID(),
              journalEntryId: entryId,
              userId,
              accountId: line.accountId,
              currency: line.currency,
              debitAmount: line.debitAmount,
              creditAmount: line.creditAmount,
              amountThb: line.amountThb,
              fxRateEffective: line.fxRateEffective,
              fxRateStatement: line.fxRateStatement,
              fxRateProvider: line.fxRateProvider,
              memo: line.memo,
            })
            .execute();
        }
      }

      // Record audit log
      const newValues = {
        entryDate: newEntryDate,
        description: newDescription,
        note: newNote,
        category: newCategory,
        symbol: newSymbol,
        side: newSide,
        quantity: newQuantity,
        unitPrice: newUnitPrice,
        grossAmount: newGrossAmount,
        fees: newFees,
        netAmount: newNetAmount,
        currency: newCurrency,
        amount: newAmount,
        fxRateEffective: newFxRateEffective,
        lines: shouldReplaceLines ? updatedPostingLines : oldValues.lines,
      };

      await insertAuditLogStrict(
        {
          userId,
          action: AuditAction.CAPITAL_TRANSACTION_UPDATE,
          entityType: "JOURNAL_ENTRY",
          entityId: entryId,
          details: {
            reason: reason || "User edited journal entry",
            sourceType: header.sourceType,
            entryNo: header.entryNo,
            oldValues,
            newValues,
          },
        },
        tx
      );

      // Fetch and return the updated persisted journal entry
      const accountRows = await getActiveAccounts(userId, tx);
      const accountMap = toAccountMap(accountRows);
      const [updatedHeader] = await tx
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, entryId)))
        .execute();
      const currentLines = await tx
        .select()
        .from(journalEntryLines)
        .where(and(eq(journalEntryLines.userId, userId), eq(journalEntryLines.journalEntryId, entryId)))
        .orderBy(asc(journalEntryLines.id))
        .execute();

      const grouped = new Map<string, { entry: any; lines: any[] }>();
      grouped.set(updatedHeader.id, { entry: updatedHeader, lines: currentLines });
      const [persisted] = toPersistedEntry(grouped, accountMap);

      return { ok: true, entry: persisted };
    });
  } catch (error) {
    console.error("editJournalEntry error:", safeErrorLog(error));
    return { ok: false, status: 500, errors: ["Internal server error while editing journal entry"] };
  }
}

export interface StructuredManualJournalInput {
  transactionType:
    | "BUY"
    | "SELL"
    | "DEPOSIT"
    | "WITHDRAWAL"
    | "FX"
    | "DIVIDEND"
    | "INTEREST"
    | "FEE"
    | "TAX"
    | "VAT"
    | "GAIN_LOSS"
    | "CUSTOM";
  entryDate: string;
  description: string;
  currency?: string;
  amount?: string;
  amountThb?: string;
  fxRateEffective?: string;
  symbol?: string;
  side?: string;
  quantity?: string;
  unitPrice?: string;
  grossAmount?: string;
  fees?: string;
  netAmount?: string;
  whtAmount?: string;
  fromCurrency?: string;
  fromAmount?: string;
  toCurrency?: string;
  toAmount?: string;
  exchangeRate?: string;
  cashAccountCode?: string;
  lines?: JournalLineInput[];
  note?: string;
}

/**
 * Create a structured manual journal entry with automatic GAAP double-entry posting lines.
 */
export async function createStructuredManualJournal(
  userId: string,
  input: StructuredManualJournalInput,
  conn: Conn = db
): Promise<CreateEntryResult> {
  const ccy = (input.currency || "THB").toUpperCase();
  const fx = input.fxRateEffective || (ccy === "THB" ? "1" : "35");
  let postingLines: JournalLineInput[] = [];
  let category: string = "asset";
  let side: string | null = null;
  let type: string | null = null;

  switch (input.transactionType) {
    case "BUY": {
      category = "asset";
      side = "BUY";
      type = "CASH_OUT";
      const gross = input.grossAmount || (input.quantity && input.unitPrice ? new Decimal(input.quantity).times(input.unitPrice).toFixed(2) : input.amount || "0");
      const fee = input.fees || "0";
      const net = input.netAmount || (new Decimal(gross).plus(fee).toFixed(2));
      const cashCode = input.cashAccountCode || (ccy === "THB" ? "1010" : "1020");

      // BUY acquisition cost must equal netAmount (grossAmount + fees), matching Statement BUY policy
      // (capitalize fee into 1110 Investment, do not separate into 5010).
      postingLines.push({
        accountId: "1110",
        currency: ccy,
        debit: net,
        fxRateEffective: fx,
        memo: input.symbol ? `${input.symbol} ${input.quantity ?? ""} @ ${input.unitPrice ?? ""}`.trim() : "ซื้อหุ้น",
      });
      postingLines.push({
        accountId: cashCode,
        currency: ccy,
        credit: net,
        fxRateEffective: fx,
      });
      break;
    }

    case "SELL": {
      category = "asset";
      side = "SELL";
      const gross = input.grossAmount || (input.quantity && input.unitPrice ? new Decimal(input.quantity).times(input.unitPrice).toFixed(2) : input.amount || "0");
      const fee = input.fees || "0";
      const net = input.netAmount || (new Decimal(gross).minus(fee).toFixed(2));
      const cashCode = input.cashAccountCode || (ccy === "THB" ? "1010" : "1020");

      postingLines.push({
        accountId: cashCode,
        currency: ccy,
        debit: net,
        fxRateEffective: fx,
      });
      if (new Decimal(fee).gt(0)) {
        postingLines.push({
          accountId: "5010",
          currency: ccy,
          debit: fee,
          fxRateEffective: fx,
          memo: "ค่าธรรมเนียมการขาย",
        });
      }
      postingLines.push({
        accountId: "1110",
        currency: ccy,
        credit: gross,
        fxRateEffective: fx,
        memo: input.symbol ? `${input.symbol} ${input.quantity ?? ""} @ ${input.unitPrice ?? ""}`.trim() : "ขายหุ้น",
      });
      break;
    }

    case "DEPOSIT": {
      category = "equity";
      type = "CASH_IN";
      const amt = input.amount || input.netAmount || "0";
      const cashCode = input.cashAccountCode || (ccy === "THB" ? "1010" : "1020");
      const equityCode = ccy === "THB" ? "3020" : "3010";

      postingLines.push({
        accountId: cashCode,
        currency: ccy,
        debit: amt,
        fxRateEffective: fx,
      });
      postingLines.push({
        accountId: equityCode,
        currency: ccy,
        credit: amt,
        fxRateEffective: fx,
      });
      break;
    }

    case "WITHDRAWAL": {
      category = "equity";
      type = "CASH_OUT";
      const amt = input.amount || input.netAmount || "0";
      const cashCode = input.cashAccountCode || (ccy === "THB" ? "1010" : "1020");
      const equityCode = ccy === "THB" ? "3020" : "3010";

      postingLines.push({
        accountId: equityCode,
        currency: ccy,
        debit: amt,
        fxRateEffective: fx,
      });
      postingLines.push({
        accountId: cashCode,
        currency: ccy,
        credit: amt,
        fxRateEffective: fx,
      });
      break;
    }

    case "DIVIDEND": {
      category = "income";
      const gross = input.grossAmount || input.amount || "0";
      const wht = input.whtAmount || "0";
      const net = input.netAmount || (new Decimal(gross).minus(wht).toFixed(2));
      const cashCode = input.cashAccountCode || (ccy === "THB" ? "1010" : "1020");

      postingLines.push({
        accountId: cashCode,
        currency: ccy,
        debit: net,
        fxRateEffective: fx,
      });
      if (new Decimal(wht).gt(0)) {
        postingLines.push({
          accountId: "5110",
          currency: ccy,
          debit: wht,
          fxRateEffective: fx,
          memo: "ภาษีหัก ณ ที่จ่าย",
        });
      }
      postingLines.push({
        accountId: "4010",
        currency: ccy,
        credit: gross,
        fxRateEffective: fx,
        memo: input.symbol ? `เงินปันผล ${input.symbol}` : "เงินปันผล",
      });
      break;
    }

    case "INTEREST": {
      category = "income";
      const gross = input.grossAmount || input.amount || "0";
      const wht = input.whtAmount || "0";
      const net = input.netAmount || (new Decimal(gross).minus(wht).toFixed(2));
      const cashCode = input.cashAccountCode || (ccy === "THB" ? "1010" : "1020");

      postingLines.push({
        accountId: cashCode,
        currency: ccy,
        debit: net,
        fxRateEffective: fx,
      });
      if (new Decimal(wht).gt(0)) {
        postingLines.push({
          accountId: "5110",
          currency: ccy,
          debit: wht,
          fxRateEffective: fx,
          memo: "ภาษีหัก ณ ที่จ่าย",
        });
      }
      postingLines.push({
        accountId: "4030",
        currency: ccy,
        credit: gross,
        fxRateEffective: fx,
        memo: "ดอกเบี้ยรับ",
      });
      break;
    }

    case "FEE": {
      category = "expense";
      const amt = input.amount || input.fees || "0";
      const cashCode = input.cashAccountCode || (ccy === "THB" ? "1010" : "1020");

      postingLines.push({
        accountId: "5010",
        currency: ccy,
        debit: amt,
        fxRateEffective: fx,
        memo: "ค่าธรรมเนียม",
      });
      postingLines.push({
        accountId: cashCode,
        currency: ccy,
        credit: amt,
        fxRateEffective: fx,
      });
      break;
    }

    case "TAX": {
      category = "expense";
      const amt = input.amount || input.whtAmount || "0";
      const cashCode = input.cashAccountCode || (ccy === "THB" ? "1010" : "1020");

      postingLines.push({
        accountId: "5110",
        currency: ccy,
        debit: amt,
        fxRateEffective: fx,
        memo: "ภาษีหัก ณ ที่จ่าย",
      });
      postingLines.push({
        accountId: cashCode,
        currency: ccy,
        credit: amt,
        fxRateEffective: fx,
      });
      break;
    }

    case "VAT": {
      category = "expense";
      const amt = input.amount || input.fees || "0";
      const cashCode = input.cashAccountCode || (ccy === "THB" ? "1010" : "1020");

      postingLines.push({
        accountId: "5130",
        currency: ccy,
        debit: amt,
        fxRateEffective: fx,
        memo: "ภาษีมูลค่าเพิ่ม (VAT)",
      });
      postingLines.push({
        accountId: cashCode,
        currency: ccy,
        credit: amt,
        fxRateEffective: fx,
      });
      break;
    }

    case "GAIN_LOSS": {
      const amt = input.amount || "0";
      const isGain = input.side === "BUY" || input.side === "GAIN" || new Decimal(amt).gte(0);
      const absAmt = new Decimal(amt).abs().toFixed(2);
      const cashCode = input.cashAccountCode || (ccy === "THB" ? "1010" : "1020");

      if (isGain) {
        category = "income";
        postingLines.push({
          accountId: cashCode,
          currency: ccy,
          debit: absAmt,
          fxRateEffective: fx,
        });
        postingLines.push({
          accountId: "4020",
          currency: ccy,
          credit: absAmt,
          fxRateEffective: fx,
          memo: input.symbol ? `กำไรจากการลงทุน ${input.symbol}` : "กำไรจากการลงทุน",
        });
      } else {
        category = "expense";
        postingLines.push({
          accountId: "5120",
          currency: ccy,
          debit: absAmt,
          fxRateEffective: fx,
          memo: input.symbol ? `ขาดทุนจากการลงทุน ${input.symbol}` : "ขาดทุนจากการลงทุน",
        });
        postingLines.push({
          accountId: cashCode,
          currency: ccy,
          credit: absAmt,
          fxRateEffective: fx,
        });
      }
      break;
    }

    case "FX": {
      category = "asset";
      const fromCcy = (input.fromCurrency || "THB").toUpperCase();
      const toCcy = (input.toCurrency || "USD").toUpperCase();
      const fromAmt = input.fromAmount || input.amount || "0";
      const toAmt = input.toAmount || input.amount || "0";
      const rate = input.exchangeRate || fx;

      const fromAccount = fromCcy === "THB" ? "1010" : "1020";
      const toAccount = toCcy === "THB" ? "1010" : "1020";

      const toEff = toCcy === "THB" ? "1" : rate;
      const fromEff = fromCcy === "THB" ? "1" : rate;

      postingLines.push({
        accountId: toAccount,
        currency: toCcy,
        debit: toAmt,
        fxRateEffective: toEff,
        memo: `แลกเปลี่ยนเข้า ${toCcy}`,
      });
      postingLines.push({
        accountId: fromAccount,
        currency: fromCcy,
        credit: fromAmt,
        fxRateEffective: fromEff,
        memo: `แลกเปลี่ยนออก ${fromCcy}`,
      });

      // FX variance leg if THB bases differ
      const receivedThb = moneyInThb(toAmt, toEff);
      const sentThb = moneyInThb(fromAmt, fromEff);
      const diff = new Decimal(receivedThb).minus(new Decimal(sentThb));
      if (!diff.isZero()) {
        postingLines.push({
          accountId: "5020",
          currency: "THB",
          ...(diff.greaterThan(0)
            ? { credit: roundMoney(diff.abs().toString()) }
            : { debit: roundMoney(diff.abs().toString()) }),
          fxRateEffective: "1",
          memo: FX_VARIANCE_MEMO,
        });
      }
      break;
    }

    case "CUSTOM":
    default: {
      if (!input.lines || input.lines.length < 2) {
        return { ok: false, errors: ["Custom transaction requires at least 2 lines"] };
      }
      postingLines = input.lines;
      break;
    }
  }

  const executeCreation = async (tx: TxClient): Promise<CreateEntryResult> => {
    let capitalTransactionId: string | undefined;
    const normalizedSymbol = input.symbol ? input.symbol.trim().toUpperCase() : null;

    if (input.transactionType === "BUY") {
      capitalTransactionId = randomUUID();
      const gross = input.grossAmount || (input.quantity && input.unitPrice ? new Decimal(input.quantity).times(input.unitPrice).toFixed(2) : input.amount || "0");
      const fee = input.fees || "0";
      const net = input.netAmount || (new Decimal(gross).plus(fee).toFixed(2));

      await tx.insert(capitalTransactions).values({
        transactionId: capitalTransactionId,
        userId,
        amountForeign: net,
        currency: ccy,
        transactionDate: input.entryDate,
        fxRateEffective: fx,
        fxRateStatement: ccy === "THB" ? "1" : fx,
        amountThb: new Decimal(net).times(fx).toFixed(2),
        type: "CASH_OUT",
        sourceType: "MANUAL",
        category: "asset",
        section: normalizedSymbol ? `ซื้อหุ้น:${normalizedSymbol}` : "ซื้อหุ้น",
        symbol: normalizedSymbol,
        side: "BUY",
        quantity: input.quantity ? String(input.quantity) : null,
        unitPrice: input.unitPrice ? String(input.unitPrice) : null,
        grossAmount: gross,
        fees: fee,
        netAmount: net,
        isMonthlyFeeAggregate: false,
      }).execute();
    }

    const result = await createJournalEntry(
      userId,
      {
        entryDate: input.entryDate,
        description: input.description,
        sourceType: "MANUAL",
        sourceTransactionId: capitalTransactionId,
        detail: {
          ...emptyTradeDetail(),
          category,
          symbol: normalizedSymbol ?? input.symbol ?? null,
          side,
          quantity: input.quantity ?? null,
          unitPrice: input.unitPrice ?? null,
          grossAmount: input.grossAmount ?? null,
          fees: input.fees ?? null,
          netAmount: input.netAmount ?? null,
          currency: ccy,
          amount: input.amount ?? null,
          fxRateEffective: fx,
          isFxConversion: input.transactionType === "FX",
          exchangeFromCurrency: input.fromCurrency ?? null,
          exchangeFromAmount: input.fromAmount ?? null,
          exchangeRate: input.exchangeRate ?? null,
        },
        lines: postingLines,
      },
      tx
    );

    if (!result.ok) {
      throw new Error(result.errors?.join("; ") || "Failed to persist journal entry");
    }

    if (input.note?.trim()) {
      await tx
        .update(journalEntries)
        .set({ note: input.note.trim() })
        .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, result.entryId)))
        .execute();
    }

    if (input.transactionType === "BUY" && normalizedSymbol) {
      await reconcileStatementState(userId, new Set([normalizedSymbol]), tx);
    }

    return result;
  };

  try {
    return await (conn === db
      ? db.transaction(async (tx) => executeCreation(tx))
      : executeCreation(conn as TxClient));
  } catch (error: any) {
    return { ok: false, errors: [error?.message || "Failed to persist journal entry"] };
  }
}
