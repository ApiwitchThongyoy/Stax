import {
  formatMoney,
  type Transaction,
} from "./Financeutils";

/**
 * Shape of a single row returned by GET /api/v1/capital-ledgers.
 *
 * The server returns the raw Capital_Transactions row, including all trade
 * detail columns (populated only for statement TRADE RECORDS rows). All money
 * fields are strings; `realizedGainLossThb` is the authoritative tax input,
 * present ONLY on computable SELL rows.
 */
export interface CapitalLedgerRow {
  transactionId: string;
  userId: string;
  amountForeign: string;
  currency: string;
  transactionDate: string;
  fxRateBot: string | null;
  fxRateStatement?: string | null;
  fxRateEffective?: string | null;
  amountThb: string;
  type: "CASH_IN" | "CASH_OUT";
  sourceType: string;
  sourceDocumentId?: string | null;
  /** Computable SELL realized gain/loss in THB (present only when authoritative). */
  realizedGainLossThb?: string | null;
  // ---- Import classification (statement TRADE RECORDS rows) ----
  category?: string | null;
  section?: string | null;
  // ---- Trade detail (statement TRADE RECORDS rows) ----
  symbol?: string | null;
  side?: "BUY" | "SELL" | null;
  quantity?: string | null;
  unitPrice?: string | null;
  grossAmount?: string | null;
  fees?: string | null;
  proceeds?: string | null;
  costBasis?: string | null;
  realizedGainLoss?: string | null;
  exchange?: string | null;
}

/**
 * Shape of a single document returned by GET /api/v1/documents.
 */
export interface ServerDocumentMeta {
  id: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
  /** Number of Capital_Transactions rows imported from this statement. */
  transactionCount: number;
}

/**
 * Import diagnostics for one stored statement, derived server-side from the
 * committed Capital_Transactions rows (never recomputed in React).
 */
export interface DocumentTransactionStats {
  total: number;
  buyCount: number;
  sellCount: number;
  cashCount: number;
  computableSellCount: number;
  fxRates: string[];
}

/**
 * Shape of GET /api/v1/documents/:id/transactions — the ledger rows that a
 * stored statement produced, ordered oldest-first, plus server-authoritative
 * counts.
 */
export interface DocumentTransactionsResponse {
  documentId: string;
  documentName: string;
  transactions: CapitalLedgerRow[];
  stats: DocumentTransactionStats;
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

async function okJson<T>(
  res: Response
): Promise<{ ok: boolean; status: number; data?: T; message?: string }> {
  let body: { success?: boolean; data?: T; message?: string };
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return {
    ok: res.ok && body.success === true && body.data !== undefined,
    status: res.status,
    data: body.data,
    message: body.message,
  };
}

/**
 * Fetch the authenticated user's Capital_Transactions from the server.
 * The server is authoritative for the ledger.
 */
export async function fetchCapitalLedger(
  accessToken: string
): Promise<CapitalLedgerRow[]> {
  const res = await fetch("/api/v1/capital-ledgers", {
    headers: authHeaders(accessToken),
  });
  const out = await okJson<CapitalLedgerRow[]>(res);
  if (!out.ok || !Array.isArray(out.data)) {
    throw new Error("Failed to load capital ledger from the server");
  }
  return out.data;
}

/**
 * Fetch the authenticated user's Statement documents (metadata only).
 * The server is authoritative for the archive list.
 */
export async function fetchUserDocuments(
  accessToken: string
): Promise<ServerDocumentMeta[]> {
  const res = await fetch("/api/v1/documents", {
    headers: authHeaders(accessToken),
  });
  const out = await okJson<ServerDocumentMeta[]>(res);
  if (!out.ok || !Array.isArray(out.data)) {
    throw new Error("Failed to load documents from the server");
  }
  return out.data.map((d) => ({ ...d, transactionCount: d.transactionCount ?? 0 }));
}

/**
 * Fetch the ledger rows that one stored Statement produced, plus
 * server-authoritative import stats. The server verifies ownership and returns
 * a safe 404 for a missing/cross-user document id.
 */
export async function fetchDocumentTransactions(
  accessToken: string,
  documentId: string
): Promise<DocumentTransactionsResponse> {
  const res = await fetch(`/api/v1/documents/${documentId}/transactions`, {
    headers: authHeaders(accessToken),
  });
  const out = await okJson<DocumentTransactionsResponse>(res);
  if (!out.ok || !out.data) {
    throw new Error(out.message || "Failed to load the document's transactions");
  }
  return out.data;
}

/**
 * Fetch a single Capital_Transactions record (the authoritative transaction
 * behind a ledger line). `GET /api/v1/capital-ledgers/:id` is owner-scoped and
 * returns a safe 404 for a missing/cross-user id (e.g. the source row was
 * deleted after the journal entry was posted).
 */
export async function fetchUserTransaction(
  accessToken: string,
  transactionId: string
): Promise<CapitalLedgerRow> {
  const res = await fetch(`/api/v1/capital-ledgers/${transactionId}`, {
    headers: authHeaders(accessToken),
  });
  const out = await okJson<CapitalLedgerRow>(res);
  if (!out.ok || !out.data) {
    throw new Error(out.message || "Failed to load the transaction record");
  }
  return out.data;
}

/**
 * Delete one of the authenticated user's Statements on the server.
 *
 * The server is authoritative: it removes the document row AND the transactions
 * that originate from that exact document (user-scoped, atomic). Returns the
 * deleted document id on success, or throws with a stable message on failure.
 */
export async function deleteUserDocument(
  accessToken: string,
  documentId: string
): Promise<string> {
  const res = await fetch(`/api/v1/documents/${documentId}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  const out = await okJson<{ id?: string }>(res);
  if (!out.ok || !out.data?.id) {
    throw new Error(out.message || "Failed to delete the statement");
  }
  return out.data.id;
}

// Self-contained fetch used when the response body is NOT JSON (a PDF Blob).
async function okBlob(
  res: Response
): Promise<{ ok: boolean; status: number; blob?: Blob; message?: string }> {
  if (!res.ok) {
    let message = "Failed to download the statement";
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      /* non-JSON error body */
    }
    return { ok: false, status: res.status, message };
  }
  return { ok: true, status: res.status, blob: await res.blob() };
}

/**
 * Download one of the authenticated user's Statements as a PDF Blob from the
 * server (the source of truth for file bytes).
 *
 * `documentId` must be the server document UUID; `originalName` is only used as
 * the download filename in the browser (never sent as the source of truth). The
 * server enforces ownership, so a document that is not the caller's fails here.
 * Returns { blob, filename } where filename is the safe server-provided original
 * name fallback, or throws with a stable message on failure.
 */
export async function downloadUserDocument(
  accessToken: string,
  documentId: string,
  originalName: string
): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`/api/v1/documents/${documentId}/download`, {
    headers: authHeaders(accessToken),
  });
  const out = await okBlob(res);
  if (!out.ok || !out.blob) {
    throw new Error(out.message || "Failed to download the statement");
  }
  const fallback = originalName || "statement.pdf";
  return { blob: out.blob, filename: fallback };
}

/**
 * Map a server Capital_Transactions row into the frontend Transaction shape
 * used by the Dashboard, FX page and Calendar.
 * The server schema stores raw cash (CASH_IN/CASH_OUT); P&L is carried in the
 * dedicated realized_gain_loss columns (populated only for computable SELL rows),
 * so `pnlAmount` mirrors that authoritative value when present and is `null`
 * when there is no computable realized gain/loss (never re-invented, never a
 * fake 0). `pnlAmount` is in THB (realizedGainLossThb); `rate` is the effective
 * FX rate so the existing `amount * rate` business formulas keep working.
 * Trade detail columns are surfaced verbatim (server-authoritative) so the UI
 * can display them without recomputing anything. Identity is the authoritative
 * transactionId.
 */
export function capitalRowToTransaction(row: CapitalLedgerRow): Transaction {
  const amountForeign = Number(row.amountForeign);
  const isIn = row.type === "CASH_IN";
  const signedAmount = isIn ? amountForeign : -amountForeign;
  const pnlAmount =
    row.realizedGainLossThb && row.realizedGainLossThb.trim() !== ""
      ? Number(row.realizedGainLossThb)
      : null;
  return {
    id: row.transactionId,
    date: row.transactionDate.slice(0, 10),
    description: isIn ? "CASH IN" : "CASH OUT",
    subLabel: row.currency,
    income: isIn ? formatMoney(amountForeign, row.currency) : null,
    expense: !isIn ? formatMoney(amountForeign, row.currency) : null,
    rate: (row.fxRateEffective ?? row.fxRateBot) ?? "",
    category: "equity",
    pnlAmount,
    amount: signedAmount,
    currency: row.currency,
    sourceDocumentId: row.sourceDocumentId ?? null,
    symbol: row.symbol ?? null,
    side: row.side ?? null,
    quantity: row.quantity ?? null,
    unitPrice: row.unitPrice ?? null,
    grossAmount: row.grossAmount ?? null,
    fees: row.fees ?? null,
    proceeds: row.proceeds ?? null,
    costBasis: row.costBasis ?? null,
    realizedGainLoss: row.realizedGainLoss ?? null,
    fxRateStatement: row.fxRateStatement ?? null,
    fxRateEffective: row.fxRateEffective ?? null,
    exchange: row.exchange ?? null,
  };
}

/**
 * Map many server rows into the frontend Transaction shape.
 */
export function capitalLedgerToTransactions(
  rows: CapitalLedgerRow[]
): Transaction[] {
  return rows.map(capitalRowToTransaction);
}

export interface ExchangeRateEntry {
  available: boolean;
  date: string;
  currency?: string;
  rate?: number;
  source?: string;
  reason?: string;
}

/**
 * Fetch a historical exchange rate for a specific date/currency from the server.
 * The server is authoritative: on weekend/holiday/provider-failure it returns
 * { available: false } — never a fabricated rate.
 */
export async function fetchExchangeRate(
  accessToken: string,
  currency: string,
  date?: string
): Promise<ExchangeRateEntry> {
  const params = new URLSearchParams({ currency });
  if (date) params.set("date", date);
  const res = await fetch(`/api/v1/exchange-rates?${params.toString()}`, {
    headers: authHeaders(accessToken),
  });
  const out = await okJson<ExchangeRateEntry>(res);
  if (!out.ok || !out.data) {
    throw new Error("Failed to load exchange rate from the server");
  }
  return out.data;
}

// ---------------------------------------------------------------------------
// General ledger (double-entry) client: Chart of Accounts, Journal, Ledger and
// the three financial reports. All numbers are server-authoritative strings —
// the UI never recomputes balances or FX conversions.
// ---------------------------------------------------------------------------

export type GeneralLedgerAccountType =
  | "ASSET"
  | "LIABILITY"
  | "EQUITY"
  | "INCOME"
  | "EXPENSE";

/** Row returned by GET /api/v1/accounts (Drizzle accounts table). */
export interface GeneralLedgerAccount {
  id: string;
  userId: string;
  code: string;
  name: string;
  type: GeneralLedgerAccountType;
  currency: string;
  parentId: string | null;
  openingBalance: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Single journal-entry line returned by GET /api/v1/journal. */
export interface GeneralLedgerJournalLine {
  id: string;
  journalEntryId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  currency: string;
  side: "DEBIT" | "CREDIT";
  amount: string;
  amountThb: string;
  fxRateEffective: string;
  fxRateStatement: string | null;
  fxRateProvider: string | null;
  memo: string | null;
}

/**
 * Journal trade detail (journal-as-SSOT). Carries the exact Capital_Transactions
 * fields so the Journal page can render EVERY imported row server-authoritatively
 * — including rows that were recorded as SKIPPED journal entries (no lines).
 */
export interface GeneralLedgerJournalTradeDetail {
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
  // R4: monthly-fee-aggregate provenance, tri-state (true = parser monthly
  // aggregate -> SKIPPED, false = confirmed standalone, null = legacy/unknown
  // pre-0027 provenance, never fabricated).
  isMonthlyFeeAggregate?: boolean | null;
}

/** Journal entry (with its lines + trade detail) returned by GET /api/v1/journal. */
export interface GeneralLedgerJournalEntry {
  id: string;
  entryNo: number;
  entryDate: string;
  description: string;
  sourceType: string;
  sourceDocumentId: string | null;
  sourceTransactionId: string | null;
  status: string;
  createdAt: string;
  postingState: "POSTED" | "SKIPPED";
  skipReason: string | null;
  detail: GeneralLedgerJournalTradeDetail;
  lines: GeneralLedgerJournalLine[];
}

/** Trial balance result returned by GET /api/v1/reports/trial-balance. */
export type GeneralLedgerTrialBalanceRow = import("./general-ledger").TrialBalanceRow;

export type GeneralLedgerTrialBalanceCurrencyTotal = import("./general-ledger").TrialBalanceCurrencyTotal;

export type GeneralLedgerTrialBalance = import("./general-ledger").TrialBalanceResult;

/** Income statement result returned by GET /api/v1/reports/income-statement. */
export type GeneralLedgerIncomeStatementLine = import("./general-ledger").IncomeStatementLine;

export type GeneralLedgerIncomeStatementCurrencyTotal = import("./general-ledger").IncomeStatementCurrencyTotal;

/** Per-stock dividend breakdown (grouped by the line's memo/ticker label). */
export interface GeneralLedgerSymbolSummary {
  symbol: string;
  currency: string;
  count: number;
  /** Net amount in the line's own currency (credit − debit). */
  amount: string;
  /** Net amount in THB. */
  amountThb: string;
}

export type GeneralLedgerIncomeStatement = import("./general-ledger").IncomeStatementResult & { dividendsBySymbol: GeneralLedgerSymbolSummary[] };

/** Balance sheet row returned by GET /api/v1/reports/balance-sheet. */
export type GeneralLedgerBalanceSheetRow = import("./general-ledger").BalanceSheetRow;

export type GeneralLedgerBalanceSheetCurrencyTotal = import("./general-ledger").BalanceSheetCurrencyTotal;

export type GeneralLedgerBalanceSheet = import("./general-ledger").BalanceSheetResult;

/** Monthly-closing result returned by GET /api/v1/reports/monthly-closing. */
export type GeneralLedgerMonthlyClosingAccountRow = import("./general-ledger").MonthlyClosingAccountRow;

export type GeneralLedgerMonthlyClosingMonth = import("./general-ledger").MonthlyClosingMonthResult;

export type GeneralLedgerMonthlyClosingContinuityIssue = import("./general-ledger").MonthlyClosingContinuityIssue;

export type GeneralLedgerMonthlyClosing = import("./general-ledger").MonthlyClosingResult;

/** Per-account ledger result returned by GET /api/v1/ledger/accounts/:id. */
export interface GeneralLedgerLineView {
  lineId: string;
  journalEntryId: string;
  entryNo: number;
  entryDate: string;
  description: string;
  sourceType: string;
  /** documents.id when this line came from a statement posting (else null). */
  sourceDocumentId: string | null;
  /** Capital_Transactions.transaction_id that generated this line (else null). */
  sourceTransactionId: string | null;
  side: "DEBIT" | "CREDIT";
  amount: string;
  amountThb: string;
  currency: string;
  memo: string | null;
  runningBalance: string;
}

export interface GeneralLedgerAccountLedger {
  movement: string;
  closing: string;
  normalSide: "DEBIT" | "CREDIT";
  opening: string;
  lines: GeneralLedgerLineView[];
  /** Per-stock (memo) breakdown of this account's period lines. */
  symbolSummary: GeneralLedgerSymbolSummary[];
}

/** Ledger summary group returned by GET /api/v1/ledger/summary. */
export type GeneralLedgerSummaryGroup = import("./ledger-service").LedgerSummaryGroup;

export type GeneralLedgerSummaryByType = import("./ledger-service").LedgerSummaryByType;

export type GeneralLedgerTotalsByCurrency = GeneralLedgerSummary["totalsByCurrency"][number];

export type GeneralLedgerTotalsThb = GeneralLedgerSummary["totalsThb"];

/** Result of GET /api/v1/ledger/summary (overview numbers, all server-computed). */
export type GeneralLedgerSummary = import("./ledger-service").LedgerSummary;

/** Batch account-category summary row: GET /api/v1/ledger/accounts/summary. */
export type GeneralLedgerAccountCategoryRow = import("./general-ledger").AccountLedgerSummaryRow;

export type GeneralLedgerAccountCategoryCurrencyTotal = import("./general-ledger").AccountLedgerSummaryCurrencyTotal;

/** Result shape of the batch category summary endpoint. */
export interface GeneralLedgerAccountCategorySummary {
  accounts: GeneralLedgerAccount[];
  type: GeneralLedgerAccountType;
  from: string | null;
  to: string | null;
  summary: {
    rows: GeneralLedgerAccountCategoryRow[];
    totalsByCurrency: GeneralLedgerAccountCategoryCurrencyTotal[];
  };
}

/** Single holding returned by GET /api/v1/cost-basis. */
export interface CostBasisHolding {
  symbol: string;
  quantity: string;
  avgCost: string;
  updatedAt: string;
}

/**
 * Display-only helper for the total cost of an open holding:
 * quantity × average cost per unit. Both inputs come straight from the
 * server-authoritative cost_basis_state; this multiplies two strings for
 * display only — it is never used for P&L/tax computation.
 */
export function holdingTotalCost(h: CostBasisHolding): string {
  const qty = Number(h.quantity);
  const avg = Number(h.avgCost);
  if (!Number.isFinite(qty) || !Number.isFinite(avg)) return "0";
  return (qty * avg).toString();
}

/**
 * Display-only currency label for a holding's trade currency, best-effort
 * guessed from its symbol. `cost_basis_state` does NOT persist a currency
 * column, so this is a heuristic (e.g. US-listed tickers -> USD) shown next to
 * the numbers for readability — never used in any computed value.
 */
export function holdingCurrency(symbol: string): string {
  return "USD";
}

/** Symbol prefix formatted for a currency label (USD for US-listed). */
export function holdingCurrencyCode(symbol: string): string {
  return holdingCurrency(symbol);
}

/**
 * Owner-sign presentation helper (display-only): re-signs a DEBIT-POSITIVE
 * account balance so that ASSET and LIABILITY read positively while EQUITY,
 * INCOME and EXPENSE read negatively (e.g. a positive credit balance in a
 * liability account displays as a negative owner amount). Input values come
 * DEBIT-positive from the server (getAccountLedger opening/movement/closing);
 * this never recomputes P&L/tax — it only flips the sign for presentation.
 * null/blank input stays null so callers can render "-".
 */
export function ownerSignedFromDebitPositive(
  type: GeneralLedgerAccountType,
  value: string | null | undefined
): string | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const negate = type === "EQUITY" || type === "INCOME" || type === "EXPENSE";
  return (negate ? -n : n).toString();
}

/**
 * Owner-sign presentation helper (display-only): re-signs a NORMAL-SIDE account
 * balance so that ASSET, EQUITY and INCOME read positively while LIABILITY and
 * EXPENSE read negatively. Input values arrive NORMAL-SIDE from the server
 * (summarizeAccountLedgers account rows and category totals); this only flips
 * the sign for presentation, never for computation. null/blank stays null.
 */
export function ownerSignedFromNormalSide(
  type: GeneralLedgerAccountType,
  value: string | null | undefined
): string | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const negate = type === "LIABILITY" || type === "EXPENSE";
  return (negate ? -n : n).toString();
}

export interface GeneralLedgerAccountLedger {
  opening: string;
  lines: GeneralLedgerLineView[];
  /** Per-stock (memo) breakdown of this account's period lines. */
  symbolSummary: GeneralLedgerSymbolSummary[];
}

/** Fetch the authenticated user's chart of accounts. */
export async function fetchAccounts(
  accessToken: string
): Promise<GeneralLedgerAccount[]> {
  const res = await fetch("/api/v1/accounts", {
    headers: authHeaders(accessToken),
  });
  const out = await okJson<GeneralLedgerAccount[]>(res);
  if (!out.ok || !Array.isArray(out.data)) {
    throw new Error(out.message || "Failed to load chart of accounts");
  }
  return out.data;
}

function periodParams(from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export interface JournalEntryFilters {
  sourceType?: "MANUAL" | "STATEMENT";
  postingState?: "POSTED" | "SKIPPED";
}

function journalParams(from?: string, to?: string, filters?: JournalEntryFilters): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (filters?.sourceType) params.set("sourceType", filters.sourceType);
  if (filters?.postingState) params.set("postingState", filters.postingState);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Fetch journal entries (the journal-as-SSOT record: every imported row has its
 * own POSTED or SKIPPED entry; SKIPPED entries carry full trade detail and no
 * lines). Optionally filtered by ISO date range, sourceType, and postingState.
 */
export async function fetchJournal(
  accessToken: string,
  from?: string,
  to?: string,
  filters?: JournalEntryFilters
): Promise<GeneralLedgerJournalEntry[]> {
  const res = await fetch(`/api/v1/journal${journalParams(from, to, filters)}`, {
    headers: authHeaders(accessToken),
  });
  const out = await okJson<GeneralLedgerJournalEntry[]>(res);
  if (!out.ok || !Array.isArray(out.data)) {
    throw new Error(out.message || "Failed to load journal entries");
  }
  return out.data;
}

/** Body line for POST /api/v1/journal (accountId may be id OR account code). */
export interface ManualJournalLineInput {
  accountId: string;
  currency: string;
  debit?: string;
  credit?: string;
  fxRateEffective?: string;
  memo?: string | null;
}

export interface ManualJournalInput {
  entryDate: string;
  description: string;
  lines: ManualJournalLineInput[];
}

export type CreateJournalOutcome =
  | { ok: true; entryId: string; entryNo: number }
  | { ok: false; message: string; errors: string[] };

/** Create a manual journal entry; 422 validation errors are surfaced verbatim. */
export async function createJournalEntry(
  accessToken: string,
  input: ManualJournalInput
): Promise<CreateJournalOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/v1/journal", {
      method: "POST",
      headers: {
        ...authHeaders(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, message: "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง", errors: [] };
  }

  let body: {
    success?: boolean;
    message?: string;
    errors?: string[];
    data?: { entryId?: string; entryNo?: number };
  };
  try {
    body = await res.json();
  } catch {
    body = {};
  }

  if (res.ok && body.success === true && body.data?.entryId) {
    return {
      ok: true,
      entryId: body.data.entryId,
      entryNo: body.data.entryNo ?? 0,
    };
  }
  if (res.status === 401) {
    return { ok: false, message: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่", errors: [] };
  }
  return {
    ok: false,
    message: body.message ?? "บันทึกรายการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
    errors: Array.isArray(body.errors) ? body.errors : [],
  };
}

/** Reverse a POSTED journal entry on the server (marks original REVERSED). */
export async function reverseJournalEntry(
  accessToken: string,
  entryId: string
): Promise<{ reversalEntryNo: number }> {
  const res = await fetch(`/api/v1/journal/${entryId}/reverse`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  const out = await okJson<{ reversalEntryNo?: number }>(res);
  if (!out.ok || out.data?.reversalEntryNo == null) {
    throw new Error(out.message || "ไม่สามารถกลับรายการได้");
  }
  return { reversalEntryNo: out.data.reversalEntryNo };
}

/** Fetch one account's ledger with a signed running balance. */
export async function fetchAccountLedger(
  accessToken: string,
  accountId: string,
  from?: string,
  to?: string
): Promise<GeneralLedgerAccountLedger> {
  const res = await fetch(
    `/api/v1/ledger/accounts/${accountId}${periodParams(from, to)}`,
    { headers: authHeaders(accessToken) }
  );
  const out = await okJson<GeneralLedgerAccountLedger>(res);
  if (!out.ok || !out.data) {
    throw new Error(out.message || "Failed to load account ledger");
  }
  return out.data;
}

/**
 * Fetch the batch summary for EVERY account of one account class in ONE request
 * (no per-account N+1). opening = balance before `from`, movement/closing and
 * lineCount come from POSTED lines in [from, to]; totals stay grouped by native
 * currency. All server-computed — the UI never recomputes balances.
 */
export async function fetchAccountCategorySummary(
  accessToken: string,
  type: GeneralLedgerAccountType,
  from?: string,
  to?: string
): Promise<GeneralLedgerAccountCategorySummary> {
  const params = new URLSearchParams({ type });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const res = await fetch(`/api/v1/ledger/accounts/summary?${params.toString()}`, {
    headers: authHeaders(accessToken),
  });
  const out = await okJson<GeneralLedgerAccountCategorySummary>(res);
  if (!out.ok || !out.data) {
    throw new Error(out.message || "Failed to load account summary");
  }
  return out.data;
}

/** Fetch the trial balance for a date range. */
export async function fetchTrialBalance(
  accessToken: string,
  from?: string,
  to?: string
): Promise<GeneralLedgerTrialBalance> {
  const res = await fetch(
    `/api/v1/reports/trial-balance${periodParams(from, to)}`,
    { headers: authHeaders(accessToken) }
  );
  const out = await okJson<GeneralLedgerTrialBalance>(res);
  if (!out.ok || !out.data) {
    throw new Error(out.message || "Failed to load trial balance");
  }
  return out.data;
}

/** Fetch the income statement for a date range. */
export async function fetchIncomeStatement(
  accessToken: string,
  from?: string,
  to?: string
): Promise<GeneralLedgerIncomeStatement> {
  const res = await fetch(
    `/api/v1/reports/income-statement${periodParams(from, to)}`,
    { headers: authHeaders(accessToken) }
  );
  const out = await okJson<GeneralLedgerIncomeStatement>(res);
  if (!out.ok || !out.data) {
    throw new Error(out.message || "Failed to load income statement");
  }
  return out.data;
}

/** Fetch the balance sheet as of a date. */
export async function fetchBalanceSheet(
  accessToken: string,
  to?: string
): Promise<GeneralLedgerBalanceSheet> {
  const res = await fetch(
    `/api/v1/reports/balance-sheet${periodParams(undefined, to)}`,
    { headers: authHeaders(accessToken) }
  );
  const out = await okJson<GeneralLedgerBalanceSheet>(res);
  if (!out.ok || !out.data) {
    throw new Error(out.message || "Failed to load balance sheet");
  }
  return out.data;
}

/** Fetch the monthly-closing report (per-month account balances). */
export async function fetchMonthlyClosing(
  accessToken: string,
  from?: string,
  to?: string
): Promise<GeneralLedgerMonthlyClosing> {
  const res = await fetch(
    `/api/v1/reports/monthly-closing${periodParams(from, to)}`,
    { headers: authHeaders(accessToken) }
  );
  const out = await okJson<GeneralLedgerMonthlyClosing>(res);
  if (!out.ok || !out.data) {
    throw new Error(out.message || "Failed to load monthly closing");
  }
  return out.data;
}

/** Fetch the overview numbers (cash/assets/equity per currency + totals). */
export async function fetchLedgerSummary(
  accessToken: string
): Promise<GeneralLedgerSummary> {
  const res = await fetch("/api/v1/ledger/summary", {
    headers: authHeaders(accessToken),
  });
  const out = await okJson<GeneralLedgerSummary>(res);
  if (!out.ok || !out.data) {
    throw new Error(out.message || "Failed to load ledger summary");
  }
  return out.data;
}

/** Fetch the authenticated user's stock holdings (cost-basis state). */
export async function fetchCostBasis(
  accessToken: string
): Promise<CostBasisHolding[]> {
  const res = await fetch("/api/v1/cost-basis", {
    headers: authHeaders(accessToken),
  });
  const out = await okJson<CostBasisHolding[]>(res);
  if (!out.ok || !Array.isArray(out.data)) {
    throw new Error(out.message || "Failed to load holdings");
  }
  return out.data;
}

/** Current holding of one symbol (from cost_basis_state), per-stock view. */
export interface PortfolioHoldingDetail {
  quantity: string;
  avgCost: string;
  cumQuantity: string;
  cumCost: string;
  updatedAt: string;
  /** quantity × avgCost — display-only, server-computed. */
  totalCost: string;
  /** quantity × latest close — display-only, never a tax/ledger input. */
  marketValue: string | null;
  /** (close − avgCost) × quantity — display-only, never a tax/ledger input. */
  unrealizedPnl: string | null;
}

/** Latest stored daily close for the symbol (global reference market data). */
export interface PortfolioQuoteDetail {
  priceDate: string;
  close: string;
  currency: string;
  source: string | null;
}

/** Server-authoritative per-stock totals (never recomputed in React). */
export interface PortfolioTotalsDetail {
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  cashCount: number;
  computableSellCount: number;
  nonComputableSellCount: number;
  /** Sum of realized gain/loss (THB) across computable SELLs; null = nothing computable. */
  totalRealizedThb: string | null;
}

/**
 * Shape of GET /api/v1/portfolio/:symbol — every ledger row for ONE ticker plus
 * the per-stock holding, latest price and authoritative realized totals. The
 * server is authoritative: P&L is never recomputed on the client.
 */
export interface PortfolioDetail {
  symbol: string;
  trades: CapitalLedgerRow[];
  holding: PortfolioHoldingDetail | null;
  quote: PortfolioQuoteDetail | null;
  totals: PortfolioTotalsDetail;
}

/**
 * Fetch the case-by-case detail of one stock (all its trades + holding + price +
 * realized totals). Owner-scoped; a safe 404 is returned when the caller has no
 * trades and no holding for that symbol.
 */
export async function fetchPortfolioDetail(
  accessToken: string,
  symbol: string
): Promise<PortfolioDetail> {
  const res = await fetch(
    `/api/v1/portfolio/${encodeURIComponent(symbol.trim().toUpperCase())}`,
    {
      headers: authHeaders(accessToken),
    }
  );
  const out = await okJson<PortfolioDetail>(res);
  if (!out.ok || !out.data) {
    throw new Error(out.message || "Failed to load the stock detail");
  }
  return out.data;
}

/** One month of cash flow (equity money movements only). */
export interface CashSummaryMonth {
  /** ISO year-month "YYYY-MM" derived from transaction_date. */
  month: string;
  /** Sum of CASH_IN amount_thb for that month. */
  cashInThb: string;
  /** Sum of CASH_OUT amount_thb for that month. */
  cashOutThb: string;
  /** cashInThb - cashOutThb for that month. */
  netThb: string;
}

/** A single equity money movement (deposit/withdrawal) inside the requested scope. */
export interface CashSummaryDetailRow {
  transactionId: string;
  /** ISO date "YYYY-MM-DD". */
  transactionDate: string;
  type: "CASH_IN" | "CASH_OUT";
  sourceType: "AI_PARSED" | "MANUAL";
  category: string | null;
  currency: string;
  /** Foreign amount (positive magnitude, as stored). */
  amountForeign: string;
  /** THB amount actually counted in the summary. */
  amountThb: string;
}

/** Full cash in/out summary (server-authoritative, equity-only). */
export interface CashSummary {
  /** Which scope produced this result. */
  view: "all" | "month" | "asOf";
  /**
   * Per-transaction detail rows inside the requested scope. Present ONLY when
   * the caller asked for a drill-down (withDetail) — never on the overview.
   */
  rows?: CashSummaryDetailRow[];
  months: CashSummaryMonth[];
  totalCashInThb: string;
  totalCashOutThb: string;
  totalNetThb: string;
  /**
   * Currency-exchange records (STATEMENT CURRENCY EXCHANGE lines). Separate
   * from the equity money-movement totals: an exchange merely moves cash
   * between currencies, it is never a deposit/withdrawal.
   */
  exchanges: CashSummaryExchangeRow[];
  /** Sum of the received side per currency across all exchange rows. */
  exchangeTotals: CashSummaryExchangeTotal[];
  /** Direction comparison (into-THB vs out-of-THB), summed in THB. */
  exchangeDirectionTotals: CashExchangeDirectionTotals;
}

/** A single currency-exchange record (CURRENCY EXCHANGE RECORDS from a statement). */
export interface CashSummaryExchangeRow {
  transactionId: string;
  /** ISO date "YYYY-MM-DD". */
  transactionDate: string;
  /** The currency given away (from side of the exchange). Null for legacy rows. */
  fromCurrency: string | null;
  /** The amount given away, in fromCurrency. Null for legacy rows. */
  fromAmount: string | null;
  /** The currency received (to side — the row's stored currency). */
  toCurrency: string | null;
  /** The amount received, in toCurrency. */
  toAmount: string | null;
  /** The rate the bank printed for the conversion. Null for legacy rows. */
  rate: string | null;
  /** THB amount actually recorded for the received side. */
  amountThb: string | null;
}

/** Per-currency totals of the received side across all exchange rows. */
export interface CashSummaryExchangeTotal {
  currency: string;
  /** Sum of toAmount for this currency. */
  totalForeign: string;
  /** Sum of amountThb for this currency. */
  totalThb: string;
}

/**
 * Direction comparison: did we bring more money BACK into THB than we
 * exchanged OUT of THB? Both sides are summed in THB (`amountThb`).
 * `netThb` = into − out (positive = more back than out).
 */
export interface CashExchangeDirectionTotals {
  intoThbTotal: string;
  intoThbCount: number;
  outOfThbTotal: string;
  outOfThbCount: number;
  netThb: string;
  moreInThanOut: boolean;
}

export interface CashSummaryQuery {
  /** Restrict to a single ISO year-month "YYYY-MM". */
  month?: string;
  /** Restrict to transactions on/before an ISO date "YYYY-MM-DD". */
  asOf?: string;
  /** Include per-transaction detail rows (drill-down). */
  withDetail?: boolean;
}

/** Fetch the authenticated user's equity cash in/out summary (THB, scoped). */
export async function fetchCashSummary(
  accessToken: string,
  query: CashSummaryQuery = {}
): Promise<CashSummary> {
  const params = new URLSearchParams();
  if (query.month) params.set("month", query.month);
  if (query.asOf) params.set("asOf", query.asOf);
  if (query.withDetail) params.set("withDetail", "1");
  const qs = params.toString();
  const res = await fetch(`/api/v1/cash-summary${qs ? `?${qs}` : ""}`, {
    headers: authHeaders(accessToken),
  });
  const out = await okJson<CashSummary>(res);
  if (!out.ok || !out.data) {
    throw new Error(out.message || "Failed to load cash summary");
  }
  return out.data;
}

/**
 * Latest daily close of a tracked symbol, as returned by
 * GET /api/v1/stock-prices. Purely informational — current price / market
 * value / unrealized P&L for the Dashboard holdings card. Never a tax or
 * ledger input.
 */
export interface StockPriceQuote {
  symbol: string;
  priceDate: string;
  close: number;
  currency: string;
  priceUpdatedAt: string;
  source: string;
}

/**
 * Fetch the latest close for a set of symbols (server resolves cache-first and
 * lazily refreshes stale prices). Symbols without any price are omitted — the
 * Dashboard renders "-" for them.
 */
export async function fetchStockQuotes(
  accessToken: string,
  symbols: string[]
): Promise<StockPriceQuote[]> {
  if (symbols.length === 0) return [];
  const symbolParam = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))].join(",");
  const res = await fetch(`/api/v1/stock-prices?symbols=${encodeURIComponent(symbolParam)}`, {
    headers: authHeaders(accessToken),
  });
  const out = await okJson<StockPriceQuote[]>(res);
  if (!out.ok || !Array.isArray(out.data)) {
    throw new Error(out.message || "Failed to load stock prices");
  }
  return out.data;
}

/** Look up a quote by symbol, or undefined when the symbol has no price yet. */
export function quoteForSymbol(
  quotes: StockPriceQuote[] | null | undefined,
  symbol: string
): StockPriceQuote | undefined {
  if (!Array.isArray(quotes)) return undefined;
  return quotes.find((q) => q.symbol === symbol);
}

/**
 * Display-only helpers for the holdings card (market value / unrealized P&L).
 * Straight qty × price arithmetic on server-persisted numbers, never used for
 * tax or ledger computation.
 */
export function holdingMarketValue(
  h: CostBasisHolding,
  quote: StockPriceQuote | undefined
): string | null {
  if (!quote) return null;
  const qty = Number(h.quantity);
  if (!Number.isFinite(qty) || !Number.isFinite(quote.close)) return null;
  return (qty * quote.close).toString();
}

export function holdingUnrealizedPnl(
  h: CostBasisHolding,
  quote: StockPriceQuote | undefined
): string | null {
  if (!quote) return null;
  const qty = Number(h.quantity);
  const avg = Number(h.avgCost);
  if (!Number.isFinite(qty) || !Number.isFinite(avg) || !Number.isFinite(quote.close)) {
    return null;
  }
  return ((quote.close - avg) * qty).toString();
}

// ---------------------------------------------------------------------------
// Corporate actions (split / reverse-split / spin-off / rename)
// ---------------------------------------------------------------------------

export type CorporateActionType =
  | "SPLIT"
  | "REVERSE_SPLIT"
  | "SPIN_OFF"
  | "RENAME";

/** Row returned by GET /api/v1/corporate-actions. */
export interface CorporateAction {
  id: string;
  userId: string;
  symbol: string;
  actionType: CorporateActionType;
  transactionDate: string;
  ratioOld: string | null;
  ratioNew: string | null;
  newSymbol: string | null;
  sharesOut: string | null;
  priceOut: string | null;
  /** SPIN_OFF FMV pair (null on legacy rows — see needsReview). */
  parentFmvPerShare: string | null;
  childFmvPerShare: string | null;
  cashInLieu: string | null;
  description: string | null;
  /** Derived: legacy spin-off without an FMV pair (old valuation kept). */
  needsReview: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CorporateActionInput {
  symbol: string;
  actionType: CorporateActionType;
  transactionDate: string;
  ratioOld?: string | null;
  ratioNew?: string | null;
  newSymbol?: string | null;
  sharesOut?: string | null;
  priceOut?: string | null;
  parentFmvPerShare?: string | null;
  childFmvPerShare?: string | null;
  cashInLieu?: string | null;
  description?: string | null;
}

/** Fetch the authenticated user's corporate actions (chronological). */
export async function fetchCorporateActions(
  accessToken: string
): Promise<CorporateAction[]> {
  const res = await fetch("/api/v1/corporate-actions", {
    headers: authHeaders(accessToken),
  });
  const out = await okJson<CorporateAction[]>(res);
  if (!out.ok || !Array.isArray(out.data)) {
    throw new Error(out.message || "Failed to load corporate actions");
  }
  return out.data;
}

export interface CreateCorporateActionOutcome {
  ok: boolean;
  id?: string;
  message?: string;
  errors?: string[];
}

/** Create a corporate action; 422 validation errors are surfaced verbatim. */
export async function createCorporateAction(
  accessToken: string,
  input: CorporateActionInput
): Promise<CreateCorporateActionOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/v1/corporate-actions", {
      method: "POST",
      headers: {
        ...authHeaders(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
  } catch {
    return {
      ok: false,
      message: "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง",
      errors: [],
    };
  }

  let body: {
    success?: boolean;
    message?: string;
    errors?: string[];
    data?: { id?: string };
  };
  try {
    body = await res.json();
  } catch {
    body = {};
  }

  if (res.status === 401) {
    return { ok: false, message: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่", errors: [] };
  }
  if (res.ok && body.success === true && body.data?.id) {
    return { ok: true, id: body.data.id };
  }
  return {
    ok: false,
    message: body.message ?? "บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
    errors: Array.isArray(body.errors) ? body.errors : [],
  };
}

/** Delete one of the user's corporate actions. */
export async function deleteCorporateAction(
  accessToken: string,
  id: string
): Promise<void> {
  const res = await fetch(`/api/v1/corporate-actions/${id}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!res.ok) {
    throw new Error("ไม่สามารถลบรายการได้ กรุณาลองใหม่อีกครั้ง");
  }
}

// ---------------------------------------------------------------------------
// Trading journal (สมุดบันทึกการซื้อขายหุ้นประจำวัน)
// ---------------------------------------------------------------------------

/** Side classification rendered by the trading journal table (stock trades only). */
export type TradingJournalSide = "BUY" | "SELL" | "DIVIDEND";

/** One chronological journal row with its replayed average cost. */
export interface TradingJournalEntry {
  transactionId: string;
  date: string;
  side: TradingJournalSide;
  symbol: string | null;
  price: string | null;
  dividendPerShare: null;
  quantity: string | null;
  amount: string | null;
  fees: string | null;
  netAmount: string | null;
  avgCostAtTime: number | null;
  currency: string | null;
  amountThb: string | null;
  fxRate: string | null;
  /** Investor's own note on this entry (verbatim, endpoint-written). */
  note: string | null;
}

/** Per-symbol portfolio summary attached to the journal response. */
export interface TradingJournalHolding {
  symbol: string;
  quantity: string | null;
  avgCost: string | null;
  cumQuantity: string | null;
  cumCost: string | null;
  updatedAt: string | null;
  quotePrice: string | null;
  quoteDate: string | null;
  quoteCurrency: string | null;
  totalCost: string | null;
  marketValue: string | null;
  unrealizedPnl: string | null;
  realizedPnlThb: string | null;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  dividendCount: number;
}

export interface TradingJournalTotals {
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  dividendCount: number;
  totalFees: string;
  totalBuyAmount: string;
  totalSellAmount: string;
  totalRealizedThb: string | null;
  pnlSummary: TradingJournalPnlSummary;
  behavior: TradingJournalBehaviorStats;
}

/** Period P&L summary, server-computed from the filtered journal entries. */
export interface TradingJournalPnlSummary {
  /** Computable SELL gains (THB); null when no computable SELL in scope. */
  realizedGainThb: string | null;
  /** DIVIDEND income (THB); null when none in scope. */
  dividendThb: string | null;
  /** As-of unrealized across the in-scope holdings (THB). */
  unrealizedThb: string | null;
  /** realized + dividend + unrealized (THB); null when nothing is computable. */
  combinedThb: string | null;
  computableSellCount: number;
  /** Counted but never valued — excluded from every THB total above. */
  nonComputableSellCount: number;
}

/** One computable SELL referenced by the behavior statistics. */
export interface TradingJournalBehaviorTrade {
  symbol: string;
  date: string;
  realizedGainLossThb: string;
}

/**
 * Portfolio-level investing-behavior statistics, server-computed from
 * computable SELLs only (non-computable SELLs are never valued).
 */
export interface TradingJournalBehaviorStats {
  computableSellCount: number;
  winningSellCount: number;
  losingSellCount: number;
  /** wins / computable (0..1); null when nothing is computable. */
  winRate: number | null;
  /** total gains / total |losses|; null when there is no loss. */
  profitFactor: number | null;
  bestTrade: TradingJournalBehaviorTrade | null;
  worstTrade: TradingJournalBehaviorTrade | null;
  /** Quantity-weighted average holding period in days; null when unknown. */
  avgHoldingDays: number | null;
}

export interface TradingJournalResponse {
  entries: TradingJournalEntry[];
  holdings: TradingJournalHolding[];
  totals: TradingJournalTotals;
}

export interface TradingJournalFilters {
  from?: string;
  to?: string;
  symbol?: string;
  side?: TradingJournalSide;
}

/**
 * Fetch the user's trading journal (stock trades + dividends with replayed
 * average cost, plus per-stock holdings). All numbers are server-computed;
 * the page renders them verbatim.
 */
export async function fetchTradingJournal(
  accessToken: string,
  filters?: TradingJournalFilters
): Promise<TradingJournalResponse> {
  const params = new URLSearchParams();
  if (filters?.from) params.set("from", filters.from);
  if (filters?.to) params.set("to", filters.to);
  if (filters?.symbol) params.set("symbol", filters.symbol.trim().toUpperCase());
  if (filters?.side) params.set("side", filters.side);
  const qs = params.toString();
  const res = await fetch(`/api/v1/trading-journal${qs ? `?${qs}` : ""}`, {
    headers: authHeaders(accessToken),
  });
  const out = await okJson<TradingJournalResponse>(res);
  if (!out.ok || !out.data) {
    throw new Error(out.message || "Failed to load trading journal");
  }
  return out.data;
}

/**
 * Set (or clear with null/blank) the investor's own note on one journal row.
 * The note is free text and never affects any computed number.
 */
export async function updateJournalNote(
  accessToken: string,
  transactionId: string,
  note: string | null
): Promise<string | null> {
  const res = await fetch(
    `/api/v1/trading-journal/${encodeURIComponent(transactionId)}/note`,
    {
      method: "PUT",
      headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    }
  );
  const out = await okJson<{ note: string | null }>(res);
  if (!out.ok || !out.data) {
    throw new Error(out.message || "Failed to save the note");
  }
  return out.data.note ?? null;
}
