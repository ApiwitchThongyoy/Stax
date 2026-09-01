import {
  formatMoney,
  type Transaction,
} from "./Financeutils";

/**
 * Shape of a single row returned by GET /api/v1/capital-ledgers.
 */
export interface CapitalLedgerRow {
  transactionId: string;
  userId: string;
  amountForeign: string;
  currency: string;
  transactionDate: string;
  fxRateBot: string;
  amountThb: string;
  type: "CASH_IN" | "CASH_OUT";
  sourceType: string;
  sourceDocumentId?: string | null;
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
 * The server schema stores raw cash (CASH_IN/CASH_OUT) with no P&L column, so
 * pnlAmount is 0 (we never invent gain/loss). `amount` is the foreign amount
 * and `rate` the FX rate so the existing `amount * rate` business formulas keep
 * working unchanged. Identity is the authoritative transactionId.
 */
export function capitalRowToTransaction(row: CapitalLedgerRow): Transaction {
  const amountForeign = Number(row.amountForeign);
  const isIn = row.type === "CASH_IN";
  const signedAmount = isIn ? amountForeign : -amountForeign;
  return {
    id: row.transactionId,
    date: row.transactionDate.slice(0, 10),
    description: isIn ? "CASH IN" : "CASH OUT",
    subLabel: row.currency,
    income: isIn ? formatMoney(amountForeign, row.currency) : null,
    expense: !isIn ? formatMoney(amountForeign, row.currency) : null,
    rate: row.fxRateBot,
    category: "equity",
    pnlAmount: 0,
    amount: signedAmount,
    currency: row.currency,
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
