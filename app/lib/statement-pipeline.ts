import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "./drizzle-db";
import { capitalTransactions, costBasisState } from "../db/schema";
import {
  parseStatementRows,
  type ExtractedTransaction,
  type CostBasisMap,
} from "./pdfStatementParser";

Decimal.set({ precision: 40 });

export const VALID_TRANSACTION_TYPES = ["CASH_IN", "CASH_OUT"] as const;
export const VALID_SOURCE_TYPES = ["MANUAL", "AI_PARSED"] as const;

export type ParsedCapitalType = (typeof VALID_TRANSACTION_TYPES)[number];

export interface ValidatedCapitalRow {
  transactionId: string;
  userId: string;
  amountForeign: string;
  currency: string;
  transactionDate: string;
  fxRateBot: string | null;
  amountThb: string;
  type: ParsedCapitalType;
  sourceType: "AI_PARSED";
  sourceDocumentId: string;
  symbol: string | null;
  side: "BUY" | "SELL" | null;
  quantity: string | null;
  unitPrice: string | null;
  grossAmount: string | null;
  fees: string | null;
  proceeds: string | null;
  costBasis: string | null;
  realizedGainLoss: string | null;
  realizedGainLossThb: string | null;
  fxRateStatement: string | null;
  fxRateEffective: string | null;
  netAmount: string | null;
  exchange: string | null;
}

export interface BuiltStatementTransactions {
  rows: ValidatedCapitalRow[];
  extractedCount: number;
  rejections: string[];
  updatedCostBasis: CostBasisMap;
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const num = parseFloat(rate.replace(/,/g, ""));
  if (Number.isNaN(num) || num <= 0) return null;
  return num;
}

/**
 * Format a JS number into a plain decimal string without exponent notation and
 * without trailing zeros, capped at 8 decimal places. Used for numeric DB fields
 * that originate from the parser's (client-compatible) arithmetic.
 */
function decimalString(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(8).replace(/\.?0+$/, "") || "0";
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

  // FX semantics (see schema notes):
  //  - fx_rate_statement = the rate PROVIDED BY THE SOURCE STATEMENT header.
  //  - fx_rate_effective  = the rate actually used for THB conversion.
  //  - fx_rate_bot        = legacy column (kept for data compatibility; manual
  //    ledger entries may store user-entered rates). The importer NEVER writes
  //    statement FX or provider rates into it.
  const parsedRate = parseRate(t.rate);
  const fxRateStatement = currency === "THB" ? 1 : parsedRate;
  const fxRateEffective = currency === "THB" ? 1 : (parsedRate ?? 1);
  const amountForeign = Math.abs(t.amount);
  const amountThb = amountForeign * fxRateEffective;

  // Determine cash direction deterministically. The parser reports "expense"
  // rows (WHT, broker fees, VAT) with a positive amount even though it is money
  // leaving the account, so direction is category-aware, not sign-only.
  const isMoneyOut = t.category === "expense" || t.amount < 0;
  const type = isMoneyOut ? "CASH_OUT" : "CASH_IN";

  // Deterministic realized gain/loss (Decimal arithmetic). Only a SELL row with
  // a computable cost basis carries a value; anything else stays null (honest
  // "not computable"). THB conversion uses the effective FX rate.
  let realizedGainLossThb: string | null = null;
  if (
    t.side === "SELL" &&
    t.realizedGainLoss !== undefined &&
    Number.isFinite(t.realizedGainLoss)
  ) {
    const gain = new Decimal(decimalString(t.realizedGainLoss));
    const eff = new Decimal(String(fxRateEffective));
    realizedGainLossThb = gain.mul(eff).toFixed(2);
  }

  return {
    ok: true,
    row: {
      transactionId: randomUUID(),
      userId,
      amountForeign: amountForeign.toFixed(2),
      currency,
      transactionDate,
      fxRateBot: null,
      amountThb: amountThb.toFixed(2),
      type,
      sourceType: "AI_PARSED",
      sourceDocumentId,
      symbol: typeof t.symbol === "string" && t.symbol !== "" ? t.symbol : null,
      side: t.side ?? null,
      quantity: t.quantity !== undefined ? decimalString(t.quantity) : null,
      unitPrice: t.unitPrice !== undefined ? decimalString(t.unitPrice) : null,
      grossAmount: t.grossAmount !== undefined ? decimalString(t.grossAmount) : null,
      fees: t.fees !== undefined && t.fees !== 0 ? decimalString(t.fees) : null,
      proceeds:
        t.proceeds !== undefined && Number.isFinite(t.proceeds)
          ? decimalString(t.proceeds)
          : null,
      costBasis:
        t.costBasis !== undefined && Number.isFinite(t.costBasis)
          ? decimalString(t.costBasis)
          : null,
      realizedGainLoss:
        t.realizedGainLoss !== undefined && Number.isFinite(t.realizedGainLoss)
          ? decimalString(t.realizedGainLoss)
          : null,
      realizedGainLossThb,
      fxRateStatement:
        fxRateStatement !== null ? String(fxRateStatement) : null,
      fxRateEffective: String(fxRateEffective),
      netAmount:
        t.netAmount !== undefined && Number.isFinite(t.netAmount)
          ? decimalString(t.netAmount)
          : null,
      exchange:
        typeof t.exchange === "string" && t.exchange !== "" ? t.exchange : null,
    },
  };
}

/**
 * Parse statement text (already extracted from the PDF) into Capital_Transactions rows.
 * Reuses the existing deterministic broker parser (pdfStatementParser.parseStatementRows).
 * Only rows that pass validation are returned; invalid ones are collected as rejections.
 *
 * `costBasis` seeds the deterministic running-average cost basis (server-side
 * state across imports). The returned `updatedCostBasis` must be persisted.
 */
export function buildStatementTransactions(
  text: string,
  userId: string,
  sourceDocumentId: string,
  costBasis: CostBasisMap = {}
): BuiltStatementTransactions {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const { transactions, updatedCostBasis } = parseStatementRows(lines, costBasis);

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

  return {
    rows: savedRows,
    extractedCount: transactions.length,
    rejections,
    updatedCostBasis,
  };
}

/**
 * External historical FX fallback strategy used when a row has NO statement rate.
 * Implementations must be cache-first and graceful: returning null (not throwing)
 * means "no rate available — keep the current base fallback".
 */
export interface FxFallback {
  resolve(
    rateDate: string,
    currency: string
  ): Promise<{ rate: number; source: string } | null>;
}

/**
 * Apply the external historical FX fallback to built rows, with this priority:
 *   A. Statement-provided FX (fx_rate_statement) — always wins, never overridden.
 *   B. Historical FX provider fallback — only for non-THB rows WITHOUT a rate.
 *   C. THB = 1 / existing base fallback — untouched when no external rate exists.
 *
 * When an external rate is applied it becomes fx_rate_effective, and the derived
 * THB amounts (amountThb + realizedGainLossThb on computable SELL rows) are
 * recomputed from it (Decimal). fx_rate_statement is never modified. Pure and
 * injectable (the fallback is supplied by the caller), so it is DB-free and
 * unit-testable without any network provider.
 */
export async function applyFxRateFallback(
  rows: ValidatedCapitalRow[],
  fallback: FxFallback
): Promise<ValidatedCapitalRow[]> {
  const out: ValidatedCapitalRow[] = [...rows];
  for (let i = 0; i < out.length; i++) {
    const row = out[i];
    if (row.fxRateStatement != null || row.currency === "THB") continue;

    let resolved;
    try {
      resolved = await fallback.resolve(row.transactionDate, row.currency);
    } catch {
      resolved = null;
    }
    if (
      !resolved ||
      !Number.isFinite(resolved.rate) ||
      resolved.rate <= 0
    ) {
      continue;
    }

    const eff = new Decimal(String(resolved.rate));
    const nextThb = new Decimal(row.amountForeign).mul(eff);
    let nextGainThb: string | null = null;
    if (row.realizedGainLoss != null && row.realizedGainLoss.trim() !== "") {
      nextGainThb = new Decimal(row.realizedGainLoss).mul(eff).toFixed(2);
    }

    out[i] = {
      ...row,
      amountThb: nextThb.toFixed(2),
      fxRateEffective: String(resolved.rate),
      realizedGainLossThb: nextGainThb,
    };
  }
  return out;
}

/**
 * Load the user's persisted running-average cost basis (mirrors the client-side
 * CostBasisMap, but authoritative on the server). Symbols with no history are
 * absent — the parser then seeds from the current statement's PORTFOLIO SUMMARY.
 */
export async function loadCostBasisState(userId: string): Promise<CostBasisMap> {
  const rows = await db
    .select({
      symbol: costBasisState.symbol,
      quantity: costBasisState.quantity,
      avgCost: costBasisState.avgCost,
    })
    .from(costBasisState)
    .where(eq(costBasisState.userId, userId))
    .execute();

  const map: CostBasisMap = {};
  for (const r of rows) {
    const qty = parseFloat(r.quantity);
    const avg = parseFloat(r.avgCost);
    if (Number.isFinite(qty) && Number.isFinite(avg)) {
      map[r.symbol] = { quantity: qty, avgCost: avg };
    }
  }
  return map;
}

/**
 * Persist the user's running-average cost basis (replace-all semantics, matching
 * the parser's full recompute of the working map per import).
 */
export async function saveCostBasisState(
  userId: string,
  map: CostBasisMap
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(costBasisState)
      .where(eq(costBasisState.userId, userId))
      .execute();
    for (const [symbol, entry] of Object.entries(map)) {
      if (entry.quantity <= 0) continue;
      await tx
        .insert(costBasisState)
        .values({
          id: randomUUID(),
          userId,
          symbol,
          quantity: decimalString(entry.quantity),
          avgCost: decimalString(entry.avgCost),
          updatedAt: new Date().toISOString(),
        })
        .execute();
    }
  });
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
          symbol: row.symbol,
          side: row.side,
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
          exchange: row.exchange,
        })
        .execute();
      insertedIds.push(row.transactionId);
    }
  });

  return { insertedCount: insertedIds.length, transactionIds: insertedIds };
}

/**
 * Exact parser-equivalent running-average cost basis replay.
 *
 * Mirrors pdfStatementParser's chronological cost-basis pass with the SAME math:
 *   - BUY:  avg = (prevQty*prevAvg + qty*price) / (prevQty + qty)
 *   - SELL: remaining = prevQty - qty (avg unchanged); a fully drained or
 *           never-established symbol is dropped so the next statement re-seeds
 *           it from its own PORTFOLIO SUMMARY.
 * Rows with no maintainable basis (e.g. a SELL with no remaining BUY) leave the
 * symbol absent — the honest "non-computable" state. Used to reconcile the
 * derived cache after deletions so cost_basis_state never drifts from the
 * authoritative ledger. Deterministic: ordered by transactionDate, so re-running
 * always yields the same map.
 */
export interface CostBasisReplayRow {
  symbol: string | null;
  transactionDate: string;
  side: string | null;
  quantity: string | null;
  unitPrice: string | null;
}

export function recomputeCostBasisMap(rows: CostBasisReplayRow[]): CostBasisMap {
  const map: CostBasisMap = {};
  const ordered = [...rows].sort((a, b) =>
    a.transactionDate.localeCompare(b.transactionDate)
  );
  for (const r of ordered) {
    if (!r.symbol) continue;
    const qty = r.quantity != null ? parseFloat(r.quantity) : NaN;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (r.side === "BUY") {
      const price = r.unitPrice != null ? parseFloat(r.unitPrice) : NaN;
      if (!Number.isFinite(price) || price <= 0) continue;
      const prev = map[r.symbol];
      const prevQty = prev?.quantity ?? 0;
      const prevAvg = prev?.avgCost ?? price;
      const newQty = prevQty + qty;
      map[r.symbol] = {
        quantity: newQty,
        avgCost:
          newQty > 0 ? prevAvg + (qty * (price - prevAvg)) / newQty : price,
      };
    } else if (r.side === "SELL") {
      const prev = map[r.symbol];
      if (!prev) continue;
      const remaining = prev.quantity - qty;
      if (remaining <= 0) delete map[r.symbol];
      else map[r.symbol] = { quantity: remaining, avgCost: prev.avgCost };
    }
  }
  return map;
}

/**
 * Rebuild this user's cost_basis_state cache from ALL remaining authoritative
 * Capital_Transactions rows. Best-effort consistency after any deletion that
 * removes ledger rows: the parser is untouched; this only reconciles the derived
 * cache with what actually remains so re-imports never double-count a
 * half-deleted statement.
 */
export async function rebuildCostBasisStateFromLedger(
  userId: string
): Promise<void> {
  const rows = await db
    .select({
      symbol: capitalTransactions.symbol,
      transactionDate: capitalTransactions.transactionDate,
      side: capitalTransactions.side,
      quantity: capitalTransactions.quantity,
      unitPrice: capitalTransactions.unitPrice,
    })
    .from(capitalTransactions)
    .where(eq(capitalTransactions.userId, userId))
    .execute();
  await saveCostBasisState(userId, recomputeCostBasisMap(rows));
}

/**
 * Deterministic, transport-safe import diagnostics for a built statement:
 * BUY/SELL/CASH counts, computable SELL rows, and which statement-provided FX
 * rates were actually applied. Pure and DB-free so it can be unit-tested.
 */
export type RowStatsInput = Pick<
  ValidatedCapitalRow,
  "side" | "fxRateStatement" | "realizedGainLossThb"
>;

export interface ImportRowStats {
  buyCount: number;
  sellCount: number;
  cashCount: number;
  computableSellCount: number;
  statementFxCount: number;
  fxRates: string[];
}

export function summarizeRows(rows: RowStatsInput[]): ImportRowStats {
  const fxRates = new Set<string>();
  let buyCount = 0;
  let sellCount = 0;
  let computableSellCount = 0;
  let statementFxCount = 0;
  for (const r of rows) {
    if (r.fxRateStatement) {
      statementFxCount++;
      fxRates.add(r.fxRateStatement);
    }
    if (r.side === "BUY") {
      buyCount++;
    } else if (r.side === "SELL") {
      sellCount++;
      if (r.realizedGainLossThb != null) computableSellCount++;
    }
  }
  return {
    buyCount,
    sellCount,
    cashCount: rows.length - buyCount - sellCount,
    computableSellCount,
    statementFxCount,
    fxRates: [...fxRates].sort(),
  };
}

/**
 * Check whether the given document has already had its transactions saved for this user.
 * Used as duplicate protection for re-uploads/retries of the same source document.
 */
export async function hasSavedDocumentRows(
  userId: string,
  sourceDocumentId: string
): Promise<boolean> {
  const { and } = await import("drizzle-orm");
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