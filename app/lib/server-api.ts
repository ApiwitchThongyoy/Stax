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
 *
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

export interface AiInsight {
  summary: string;
  patterns: string[];
  dataQualityNotes: string[];
  taxReadinessNotes: string[];
}

export interface AiAnalysisResponse {
  available: boolean;
  code: string | null;
  result?: AiInsight;
  aggregates?: {
    transactionCount: number;
    currencies: string[];
    minDate: string;
    maxDate: string;
    cashInTotalThb: string;
    cashOutTotalThb: string;
  };
  errors?: string[];
}

/**
 * Per-transaction row returned by POST /api/v1/tax/calculate (server-authoritative).
 *
 * `status` distinguishes computable SELL rows from rows that carry no stored
 * realized gain/loss. `classification` refines the UI label:
 *   - realized-gain  : computable SELL with a known running-average cost basis
 *   - non-computable : SELL row whose cost basis is genuinely unavailable
 *   - buy-basis      : BUY row (used to build cost basis, not a gain)
 *   - not-applicable : deposits/withdrawals/fees/FX conversions (no trade detail)
 */
export interface TaxReconRow {
  transactionId: string;
  transactionDate?: string | null;
  currency?: string | null;
  transactionAmountThb: string;
  realizedGainLossThb: string | null;
  taxableAmountThb: string | null;
  isTaxable: boolean | null;
  status: "computable" | "not-computable";
  classification:
    | "realized-gain"
    | "non-computable"
    | "buy-basis"
    | "not-applicable";
  reason: string;
  symbol?: string | null;
  side?: "BUY" | "SELL" | null;
  quantity?: string | null;
  unitPrice?: string | null;
  grossAmount?: string | null;
  fees?: string | null;
  proceeds?: string | null;
  costBasis?: string | null;
  realizedGainLoss?: string | null;
  fxRateStatement?: string | null;
  fxRateEffective?: string | null;
  exchange?: string | null;
}

export interface TaxReconSummary {
  computable: boolean;
  computedCount: number;
  nonComputableCount: number;
  reason: string;
  transactions: TaxReconRow[];
  totalTaxableAmountThb: string | null;
}

/**
 * Call the Tax Core Engine for the authenticated user's transactions.
 * The server computes the tax base (ฐานภาษี) from stored realized gain/loss;
 * rows without an authoritative gain/loss are reported not-applicable /
 * non-computable and never fabricated into a number.
 */
export async function fetchTaxRecon(
  accessToken: string,
  transactionIds: string[]
): Promise<TaxReconSummary> {
  const res = await fetch("/api/v1/tax/calculate", {
    method: "POST",
    headers: {
      ...authHeaders(accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ transactionIds }),
  });
  const out = await okJson<TaxReconSummary>(res);
  if (!out.ok || !out.data) {
    throw new Error(out.message || "Failed to load tax reconstruction");
  }
  return out.data;
}

/**
 * Fetch neutral AI insights about the authenticated user's imported activity.
 * Server returns { available: false } when Gemini is unavailable.
 */
export async function fetchAiAnalysis(
  accessToken: string,
  documentIds?: string[]
): Promise<AiAnalysisResponse> {
  const res = await fetch("/api/v1/analysis", {
    method: "POST",
    headers: {
      ...authHeaders(accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(documentIds && documentIds.length > 0 ? { documentIds } : {}),
  });
  const out = await okJson<AiAnalysisResponse>(res);
  if (!out.ok || !out.data) {
    throw new Error("Failed to load AI analysis from the server");
  }
  return out.data;
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

/**
 * Download the authenticated user's capital transactions as a file
 * (CSV or XLSX) from the server. Returns a Blob plus the server-provided
 * filename for the download.
 */
export async function exportUserTransactions(
  accessToken: string,
  format: "csv" | "xlsx",
  opts?: { dateFrom?: string; dateTo?: string }
): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch("/api/v1/export", {
    method: "POST",
    headers: {
      ...authHeaders(accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      format,
      dateFrom: opts?.dateFrom,
      dateTo: opts?.dateTo,
    }),
  });

  if (!res.ok) {
    throw new Error("Failed to export transactions");
  }

  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? `capital_transactions.${format === "xlsx" ? "xlsx" : "csv"}`;

  return { blob: await res.blob(), filename };
}
