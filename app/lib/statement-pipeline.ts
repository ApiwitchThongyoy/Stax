import { randomUUID } from "node:crypto";
import { db } from "./drizzle-db";
import { capitalTransactions } from "../db/schema";
import { parseStatementRows, type ExtractedTransaction } from "./pdfStatementParser";

export const VALID_TRANSACTION_TYPES = ["CASH_IN", "CASH_OUT"] as const;
export const VALID_SOURCE_TYPES = ["MANUAL", "AI_PARSED"] as const;

export type ParsedCapitalType = (typeof VALID_TRANSACTION_TYPES)[number];

export interface ValidatedCapitalRow {
  transactionId: string;
  userId: string;
  amountForeign: string;
  currency: string;
  transactionDate: string;
  fxRateBot: string;
  amountThb: string;
  type: ParsedCapitalType;
  sourceType: "AI_PARSED";
  sourceDocumentId: string;
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const num = parseFloat(rate.replace(/,/g, ""));
  if (Number.isNaN(num) || num <= 0) return null;
  return num;
}

function toIsoDate(ddmmyyyy: string): string | null {
  const m = ddmmyyyy.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const day = Number(d);
  const month = Number(mo);
  const year = Number(y);
  if (day < 1 || day > 31 || month < 1 || month > 12 || year < 1900 || year > 2100) {
    return null;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Map a client-parsed (ExtractedTransaction) row into a validated Capital_Transactions row.
 * Returns a row if valid, or a rejection reason object if the record is malformed.
 * Never invents data — only maps fields the parser actually produced.
 */
export function mapToCapitalRow(
  t: ExtractedTransaction,
  userId: string,
  sourceDocumentId: string
): { ok: true; row: ValidatedCapitalRow } | { ok: false; reason: string } {
  const transactionDate = toIsoDate(t.date);
  if (!transactionDate) {
    return { ok: false, reason: `invalid date ${JSON.stringify(t.date)}` };
  }

  const currency = (t.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(currency)) {
    return { ok: false, reason: `invalid currency ${JSON.stringify(t.currency)}` };
  }

  if (typeof t.amount !== "number" || !Number.isFinite(t.amount) || t.amount === 0) {
    return { ok: false, reason: "invalid amount (must be a non-zero finite number)" };
  }

  // THB is the base currency (rate 1); for other currencies use the statement's
  // "XXX/THB = N" header rate when present, else fall back to 1 like the UI does.
  const parsedRate = parseRate(t.rate);
  const fxRate = currency === "THB" ? 1 : parsedRate ?? 1;
  const amountForeign = Math.abs(t.amount);
  const amountThb = amountForeign * fxRate;

  // Determine cash direction deterministically. The parser reports "expense"
  // rows (WHT, broker fees, VAT) with a positive amount even though it is money
  // leaving the account, so direction is category-aware, not sign-only.
  const isMoneyOut = t.category === "expense" || t.amount < 0;
  const type = isMoneyOut ? "CASH_OUT" : "CASH_IN";
  return {
    ok: true,
    row: {
      transactionId: randomUUID(),
      userId,
      amountForeign: amountForeign.toFixed(2),
      currency,
      transactionDate,
      fxRateBot: fxRate.toFixed(4),
      amountThb: amountThb.toFixed(2),
      type,
      sourceType: "AI_PARSED",
      sourceDocumentId,
    },
  };
}

/**
 * Parse statement text (already extracted from the PDF) into Capital_Transactions rows.
 * Reuses the existing deterministic broker parser (pdfStatementParser.parseStatementRows).
 * Only rows that pass validation are returned; invalid ones are collected as rejections.
 */
export function buildStatementTransactions(
  text: string,
  userId: string,
  sourceDocumentId: string
): { rows: ValidatedCapitalRow[]; extractedCount: number; rejections: string[] } {
  const rows = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const { transactions } = parseStatementRows(rows);

  const savedRows: ValidatedCapitalRow[] = [];
  const rejections: string[] = [];

  for (const t of transactions) {
    const mapped = mapToCapitalRow(t, userId, sourceDocumentId);
    if (mapped.ok) {
      savedRows.push(mapped.row);
    } else {
      rejections.push(mapped.reason);
    }
  }

  return { rows: savedRows, extractedCount: transactions.length, rejections };
}

/**
 * Insert validated Capital_Transactions rows atomically using a DB transaction.
 * Returns the number of rows actually inserted, and the list of transactionIds.
 */
export async function insertStatementTransactions(
  userId: string,
  rows: ValidatedCapitalRow[]
): Promise<{ insertedCount: number; transactionIds: string[] }> {
  if (rows.length === 0) {
    return { insertedCount: 0, transactionIds: [] };
  }

  const insertedIds: string[] = [];
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
        })
        .execute();
      insertedIds.push(row.transactionId);
    }
  });

  return { insertedCount: insertedIds.length, transactionIds: insertedIds };
}

/**
 * Check whether the given document has already had its transactions saved for this user.
 * Used as duplicate protection for re-uploads/retries of the same source document.
 */
export async function hasSavedDocumentRows(
  userId: string,
  sourceDocumentId: string
): Promise<boolean> {
  const { eq, and } = await import("drizzle-orm");
  const rows = await db
    .select({ transactionId: capitalTransactions.transactionId })
    .from(capitalTransactions)
    .where(
      and(
        eq(capitalTransactions.userId, userId),
        eq(capitalTransactions.sourceDocumentId, sourceDocumentId)
      )
    )
    .limit(1)
    .execute();
  return rows.length > 0;
}
