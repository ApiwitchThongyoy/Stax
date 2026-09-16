import { assertOwnedReferences } from "./resource-ownership";
import { safeErrorLog } from "./safe-error-log";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "./drizzle-db";
import { capitalTransactions, corporateActions, costBasisState } from "../db/schema";
import { applyCorporateAction, type CorporateActionInput } from "./corporate-action";
import {
  applyAverageCostTrade,
  type CostBasisMap,
  type CostBasisPosition,
} from "./cost-basis-engine";
import {
  parseStatementRows,
  type ExtractedTransaction,
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
  category: string;
  section: string;
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
  exchangeFromCurrency: string | null;
  exchangeFromAmount: string | null;
  exchangeRate: string | null;
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
  // INTENTIONAL 2-stage rounding (kept, not a bug): the stored gain is rounded
  // to 2dp first and gainThb is derived from that ROUNDED gain, so the pair is
  // always consistent (gainThb === round2(round2(gain) × fx)). See
  // realizedUpdateFor below for the canonical statement of this invariant.
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

  // Symbol/ticker. Trade rows carry `t.symbol` directly (preserved verbatim);
  // dividend income rows embed the ticker in the section label
  // ("เงินปันผล:goog") instead, so we derive it there as an uppercase key so
  // the posting engine can tag per-stock dividend income consistently.
  const symbol =
    typeof t.symbol === "string" && t.symbol !== ""
      ? t.symbol
      : null;
  const derivedSymbol =
    symbol ??
    (t.category === "income" && typeof t.section === "string"
      ? (t.section.match(/เงินปันผล\s*[:：]\s*([A-Za-z0-9._-]+)/i)?.[1]?.toUpperCase() ?? null)
      : null);

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
      category: t.category,
      section: t.section,
      symbol: derivedSymbol,
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
      exchangeFromCurrency:
        typeof t.exchangeFromCurrency === "string" && t.exchangeFromCurrency !== "" ? t.exchangeFromCurrency : null,
      exchangeFromAmount:
        typeof t.exchangeFromAmount === "number" && Number.isFinite(t.exchangeFromAmount)
          ? decimalString(Math.abs(t.exchangeFromAmount))
          : null,
      exchangeRate:
        typeof t.exchangeRate === "number" && Number.isFinite(t.exchangeRate)
          ? decimalString(t.exchangeRate)
          : null,
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
 * recomputed from it (Decimal). fx_rate_statement is never modified. The gain
 * THB is recomputed from the STORED (already 2dp-rounded) gain — the same
 * intentional 2-stage rounding as the fresh-import path. Pure and
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
      cumQuantity: costBasisState.cumQuantity,
      cumCost: costBasisState.cumCost,
    })
    .from(costBasisState)
    .where(eq(costBasisState.userId, userId))
    .execute();

  const map: CostBasisMap = {};
  for (const r of rows) {
    const qty = parseFloat(r.quantity);
    const avg = parseFloat(r.avgCost);
    if (!Number.isFinite(qty) || !Number.isFinite(avg)) continue;
    const cumQty = parseFloat(r.cumQuantity);
    const cumCost = parseFloat(r.cumCost);
    // Legacy rows (pre-Webull migration) carry cum fields of 0 — hydrate them as
    // "everything bought at the stored average" so the cumulative divisor is faithful.
    map[r.symbol] = {
      quantity: qty,
      avgCost: avg,
      cumQuantity: Number.isFinite(cumQty) && cumQty > 0 ? cumQty : qty,
      cumCost: Number.isFinite(cumCost) && cumCost > 0 ? cumCost : qty * avg,
    };
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
          cumQuantity: decimalString(entry.cumQuantity),
          cumCost: decimalString(entry.cumCost),
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
  /**
   * Optional deterministic tie-break for same-date events. The persist path
   * supplies it (ORDER BY transaction_date, transaction_id) so the replay
   * matches the backfill engine's ordering exactly.
   */
  transactionId?: string;
}

/**
 * Corporate-action row as it participates in a cost-basis replay. Same shape as
 * a persisted corporate_actions row's relevant columns; carries enough to run
 * `applyCorporateAction` (pure, DB-free) mid-replay.
 */
export interface CostBasisActionRow extends CorporateActionInput {
  id: string;
}

export function recomputeCostBasisMap(
  rows: CostBasisReplayRow[] | (CostBasisReplayRow & { kind?: "trade" })[],
  actions: CostBasisActionRow[] = []
): CostBasisMap {
  const map: CostBasisMap = {};
  type Event =
    | { kind: "trade"; row: CostBasisReplayRow }
    | { kind: "action"; action: CostBasisActionRow };
  const events: Event[] = [
    ...rows.map((r) => ({ kind: "trade" as const, row: r })),
    ...actions.map((a) => ({ kind: "action" as const, action: a })),
  ];
  events.sort((a, b) => {
    const da = a.kind === "trade" ? a.row.transactionDate : a.action.transactionDate;
    const db = b.kind === "trade" ? b.row.transactionDate : b.action.transactionDate;
    const d = da.localeCompare(db);
    if (d !== 0) return d;
    // Same date: trades apply before same-date actions; both sides tie-break on
    // their stable keys so the replay is deterministic for ANY input order.
    if (a.kind === "trade" && b.kind === "trade") {
      return (a.row.transactionId ?? "").localeCompare(b.row.transactionId ?? "");
    }
    if (a.kind === "action" && b.kind === "action") {
      return a.action.id.localeCompare(b.action.id);
    }
    return a.kind === "trade" ? -1 : 1;
  });
  for (const ev of events) {
    if (ev.kind === "action") {
      applyCorporateAction(map, ev.action);
      continue;
    }
    const r = ev.row;
    if (!r.symbol) continue;
    const qty = r.quantity != null ? parseFloat(r.quantity) : NaN;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const price = r.unitPrice != null ? parseFloat(r.unitPrice) : NaN;
    if (r.side === "BUY" || r.side === "SELL") {
      // Webull Average Cost replay — identical math to the parser (BUY
      // accumulates price×qty, SELL only reduces the live quantity; a fully
      // drained position is dropped so the next statement re-seeds).
      applyAverageCostTrade(map, r.symbol, r.side, qty, price);
    }
  }
  return map;
}

/**
 * Rebuild this user's cost_basis_state cache from ALL remaining authoritative
 * Capital_Transactions rows PLUS their corporate actions (split/spin-off/etc.).
 * Best-effort consistency after any deletion that removes ledger rows or a
 * corporate action: the parser is untouched; this only reconciles the derived
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
    .orderBy(capitalTransactions.transactionDate, capitalTransactions.transactionId)
    .execute();

  const actions: CostBasisActionRow[] = [];
  // corporate_actions is optional for the math (the parser never applied
  // actions and the pure engine defaults them to none); it may not exist on
  // every deployment yet (0014 migration not always applied), so a missing
  // table must never block a cost-basis rebuild — fall back to trades only.
  // (A deployment missing only the 0023 FMV columns falls back the same way;
  // its spin-offs replay with the legacy valuation until 0023 is applied.)
  try {
    const actionRows = await db
      .select({
        id: corporateActions.id,
        symbol: corporateActions.symbol,
        actionType: corporateActions.actionType,
        transactionDate: corporateActions.transactionDate,
        ratioOld: corporateActions.ratioOld,
        ratioNew: corporateActions.ratioNew,
        newSymbol: corporateActions.newSymbol,
        sharesOut: corporateActions.sharesOut,
        priceOut: corporateActions.priceOut,
        parentFmvPerShare: corporateActions.parentFmvPerShare,
        childFmvPerShare: corporateActions.childFmvPerShare,
      })
      .from(corporateActions)
      .where(eq(corporateActions.userId, userId))
      .orderBy(corporateActions.transactionDate, corporateActions.symbol)
      .execute();
    for (const a of actionRows) {
      actions.push({
        id: a.id,
        symbol: a.symbol,
        actionType: a.actionType as CostBasisActionRow["actionType"],
        transactionDate: a.transactionDate,
        ratioOld: a.ratioOld,
        ratioNew: a.ratioNew,
        newSymbol: a.newSymbol,
        sharesOut: a.sharesOut,
        priceOut: a.priceOut,
        parentFmvPerShare: a.parentFmvPerShare,
        childFmvPerShare: a.childFmvPerShare,
      });
    }
  } catch (error) {
    const inner = error && typeof error === "object" && "cause" in error && error.cause instanceof Error
      ? error.cause.message
      : "";
    const msg = `${error instanceof Error ? error.message : String(error)} ${inner}`;
    if (!/does not exist/i.test(msg)) throw error;
  }

  await saveCostBasisState(userId, recomputeCostBasisMap(rows, actions));
}

// ---------------------------------------------------------------------------
// Gain/loss backfill (migration 0016) — heal frozen SELL rows.
//
// A SELL imported BEFORE its supporting BUY (because the statements were
// uploaded out of chronological order) is left with a NULL realized gain/loss:
// the parser only ever sees the cost basis available AT THAT MOMENT. Later BUYs
// land in the ledger but the frozen rows are never recomputed. This pass replays
// the FULL authoritative ledger chronologically with the SAME average-cost math
// as the parser and fills ONLY the holes: AI_PARSED SELL rows whose
// realizedGainLossThb is still NULL and which now have sufficient basis. It
// never touches MANUAL rows, never overwrites an existing value, and never
// fabricates an FX rate (it uses the stored fx_rate_effective, THB = 1).
// ---------------------------------------------------------------------------

export interface GainLossBackfillRow {
  transactionId: string;
  sourceType: string | null;
  transactionDate: string;
  symbol: string | null;
  side: string | null;
  quantity: string | null;
  unitPrice: string | null;
  grossAmount: string | null;
  fees: string | null;
  netAmount: string | null;
  currency: string | null;
  fxRateEffective: string | null;
  // NULL / empty => frozen, eligible for backfill.
  realizedGainLossThb: string | null;
}

export interface RealizedGainBackfillUpdate {
  costBasis: string;
  proceeds: string;
  realizedGainLoss: string;
  realizedGainLossThb: string;
}

export interface RealizedGainBackfillOutput {
  transactionId: string;
  update: RealizedGainBackfillUpdate;
}

export interface GainLossBackfillStats {
  filled: number;
  skippedAlready: number;
  skippedManual: number;
  stillNonComputable: number;
}

/**
 * Pure backfill decision engine (DB-free, Decimal arithmetic).
 *
 *  - Replays every legacy + corporate-action event chronologically (same math
 *    as `recomputeCostBasisMap`/the parser: BUY averages, SELL deducts; actions
 *    via `applyCorporateAction`), so a SELL's available qty/avg reflects the
 *    FULL ledger, not the partial state seen at its original import.
 *  - Emits an update ONLY for: side === "SELL", sourceType === "AI_PARSED",
 *    realizedGainLossThb currently NULL/empty, sufficient remaining basis, and
 *    a usable net + FX (net = stored net_amount, else gross_amount - fees;
 *    THB rows use 1, otherwise the stored fx_rate_effective — never invented).
 *  - Never emits for MANUAL rows or already-computed rows. Deterministic:
 *    ordered by transactionDate (stable sort keeps rows before same-date
 *    actions, mirroring `recomputeCostBasisMap`).
 */
export function computeGainLossBackfill(
  rows: GainLossBackfillRow[],
  actions: CostBasisActionRow[] = []
): { updates: RealizedGainBackfillOutput[]; stats: GainLossBackfillStats } {
  const map: CostBasisMap = {};
  const stats: GainLossBackfillStats = {
    filled: 0,
    skippedAlready: 0,
    skippedManual: 0,
    stillNonComputable: 0,
  };

  type Event =
    | { kind: "trade"; row: GainLossBackfillRow }
    | { kind: "action"; action: CostBasisActionRow };
  const events: Event[] = [
    ...rows.map((r) => ({ kind: "trade" as const, row: r })),
    ...actions.map((a) => ({ kind: "action" as const, action: a })),
  ];
  events.sort((a, b) => {
    const da = a.kind === "trade" ? a.row.transactionDate : a.action.transactionDate;
    const db = b.kind === "trade" ? b.row.transactionDate : b.action.transactionDate;
    const d = da.localeCompare(db);
    if (d !== 0) return d;
    // Same date: trades apply before same-date actions; both sides tie-break on
    // their stable keys so the replay is deterministic for ANY input order.
    if (a.kind === "trade" && b.kind === "trade") {
      return a.row.transactionId.localeCompare(b.row.transactionId);
    }
    if (a.kind === "action" && b.kind === "action") {
      return a.action.id.localeCompare(b.action.id);
    }
    return a.kind === "trade" ? -1 : 1;
  });

  const updates: RealizedGainBackfillOutput[] = [];

  for (const ev of events) {
    if (ev.kind === "action") {
      applyCorporateAction(map, ev.action);
      continue;
    }
    const r = ev.row;
    if (!r.symbol || (r.side !== "BUY" && r.side !== "SELL")) {
      // Non-trade rows / missing symbol never touch the running basis.
      if (r.side === "SELL" && r.realizedGainLossThb == null) stats.stillNonComputable++;
      continue;
    }
    const qty = r.quantity != null ? parseFloat(r.quantity) : NaN;
    const qtyOk = Number.isFinite(qty) && qty > 0;

    if (r.side === "BUY") {
      if (!qtyOk) continue;
      const price = r.unitPrice != null ? parseFloat(r.unitPrice) : NaN;
      if (!Number.isFinite(price) || price <= 0) continue;
      applyAverageCostTrade(map, r.symbol, "BUY", qty, price);
      continue;
    }

    // SELL — Webull Average Cost: reduce the live quantity regardless (parser
    // parity); the lifetime divisor/average are untouched by a SELL.
    const sellPrice = r.unitPrice != null ? parseFloat(r.unitPrice) : NaN;
    const { sellBasis } = applyAverageCostTrade(
      map,
      r.symbol,
      "SELL",
      qtyOk ? qty : NaN,
      Number.isFinite(sellPrice) ? sellPrice : NaN
    );

    const alreadyComputed =
      r.realizedGainLossThb != null && r.realizedGainLossThb.trim() !== "";
    if (r.sourceType !== "AI_PARSED") {
      stats.skippedManual++;
      continue;
    }
    if (alreadyComputed) {
      stats.skippedAlready++;
      continue;
    }
    if (!qtyOk || sellBasis === null) {
      stats.stillNonComputable++;
      continue;
    }
    const avgCost = sellBasis;

    const update = realizedUpdateFor(avgCost, qty, r);
    if (!update) {
      stats.stillNonComputable++;
      continue;
    }

    updates.push({ transactionId: r.transactionId, update });
    stats.filled++;
  }

  return { updates, stats };
}

/**
 * Shared decision math for a computable SELL: authoritative net (stored
 * net_amount wins, else gross - fees), FX (THB → 1, else ONLY the stored
 * fx_rate_effective — never invented) and the parser-parity THB conversion
 * (gainThb derived from the ROUNDED gain). Returns null when no trustworthy
 * net or FX is available (honest non-computable).
 *
 * CANONICAL 2-STAGE ROUNDING (intentional, do not "simplify" to one stage):
 *   realizedGainLoss   = round2(net − costBasis)
 *   realizedGainLossThb = round2(realizedGainLoss × fx)
 * so the stored pair always satisfies
 *   realizedGainLossThb === round2(round2(gain) × fx).
 * Example: gain 10.005 → stored 10.01 → ×35.42 = 354.55 (single-stage from the
 * raw gain would give 354.38). THB is legal tender (2dp) and the rounded gain
 * is what every downstream reader (GL postings, journal detail, export)
 * displays, so the pair is kept mutually consistent by construction.
 */
function realizedUpdateFor(
  avgCost: number,
  qty: number,
  r: Pick<
    GainLossBackfillRow,
    "netAmount" | "grossAmount" | "fees" | "currency" | "fxRateEffective"
  >
): RealizedGainBackfillUpdate | null {
  // Authoritative net cash: stored net_amount wins; else reconstruct from the
  // stored gross - fees (the statement's own Net Amount definition).
  let net: Decimal;
  if (r.netAmount != null && r.netAmount.trim() !== "") {
    try {
      net = new Decimal(r.netAmount.trim());
    } catch {
      net = new Decimal(NaN);
    }
  } else if (r.grossAmount != null && r.fees != null) {
    try {
      net = new Decimal(r.grossAmount.trim()).minus(new Decimal(r.fees.trim()));
    } catch {
      net = new Decimal(NaN);
    }
  } else {
    net = new Decimal(NaN);
  }
  if (!net.isFinite()) return null;

  // FX: THB rows pin to 1; otherwise ONLY the stored effective rate may be
  // used (never an invented/provider rate).
  let eff: Decimal;
  if (r.currency === "THB") {
    eff = new Decimal(1);
  } else if (r.fxRateEffective != null && r.fxRateEffective.trim() !== "") {
    try {
      eff = new Decimal(r.fxRateEffective.trim());
    } catch {
      eff = new Decimal(NaN);
    }
  } else {
    eff = new Decimal(NaN);
  }
  if (!eff.isFinite() || eff.lte(0)) return null;

  const costBasis = new Decimal(String(avgCost)).mul(qty);
  // Mirror the parser's THB conversion (parseTrade conclusion path): the THB
  // gain is derived from the ROUNDED gain, so the stored pair is always
  // consistent (realizedGainLossThb === round2(round2(gain) × fx)).
  const roundedGain = net.minus(costBasis).toFixed(2);
  const gainThb = new Decimal(roundedGain).mul(eff).toFixed(2);

  return {
    costBasis: new Decimal(String(avgCost)).mul(qty).toFixed(2),
    proceeds: net.toFixed(2),
    realizedGainLoss: roundedGain,
    realizedGainLossThb: gainThb,
  };
}

export interface FullGainLossRecomputeStats {
  recomputed: number;
  skippedManual: number;
  stillNonComputable: number;
}

/**
 * Pure FULL recompute engine — the one-shot "switch the whole ledger to Webull
 * Average Cost" counterpart of `computeGainLossBackfill`.
 *
 * Replays every row + corporate action chronologically under Webull Average
 * Cost and emits an update for EVERY AI_PARSED SELL row with a computable basis
 * (i.e. it OVERWRITES already-computed values — the old average-cost method's
 * numbers are replaced, not preserved). MANUAL rows are never written. All
 * other honesty guards are identical to the backfill: no invented FX, no
 * fabricated net, non-computable stays a hole.
 */
export function recomputeAllGainLoss(
  rows: GainLossBackfillRow[],
  actions: CostBasisActionRow[] = []
): { updates: RealizedGainBackfillOutput[]; stats: FullGainLossRecomputeStats } {
  const map: CostBasisMap = {};
  const stats: FullGainLossRecomputeStats = {
    recomputed: 0,
    skippedManual: 0,
    stillNonComputable: 0,
  };

  type Event =
    | { kind: "trade"; row: GainLossBackfillRow }
    | { kind: "action"; action: CostBasisActionRow };
  const events: Event[] = [
    ...rows.map((r) => ({ kind: "trade" as const, row: r })),
    ...actions.map((a) => ({ kind: "action" as const, action: a })),
  ];
  events.sort((a, b) => {
    const da = a.kind === "trade" ? a.row.transactionDate : a.action.transactionDate;
    const db = b.kind === "trade" ? b.row.transactionDate : b.action.transactionDate;
    const d = da.localeCompare(db);
    if (d !== 0) return d;
    if (a.kind === "trade" && b.kind === "trade") {
      return a.row.transactionId.localeCompare(b.row.transactionId);
    }
    if (a.kind === "action" && b.kind === "action") {
      return a.action.id.localeCompare(b.action.id);
    }
    return a.kind === "trade" ? -1 : 1;
  });

  const updates: RealizedGainBackfillOutput[] = [];

  for (const ev of events) {
    if (ev.kind === "action") {
      applyCorporateAction(map, ev.action);
      continue;
    }
    const r = ev.row;
    if (!r.symbol || (r.side !== "BUY" && r.side !== "SELL")) {
      continue;
    }
    const qty = r.quantity != null ? parseFloat(r.quantity) : NaN;
    const qtyOk = Number.isFinite(qty) && qty > 0;

    if (r.side === "BUY") {
      if (!qtyOk) continue;
      const price = r.unitPrice != null ? parseFloat(r.unitPrice) : NaN;
      if (!Number.isFinite(price) || price <= 0) continue;
      applyAverageCostTrade(map, r.symbol, "BUY", qty, price);
      continue;
    }

    // SELL — reduce the live quantity always; only the average matters below.
    const sellPrice = r.unitPrice != null ? parseFloat(r.unitPrice) : NaN;
    const { sellBasis } = applyAverageCostTrade(
      map,
      r.symbol,
      "SELL",
      qtyOk ? qty : NaN,
      Number.isFinite(sellPrice) ? sellPrice : NaN
    );

    if (r.sourceType !== "AI_PARSED") {
      stats.skippedManual++;
      continue;
    }
    if (!qtyOk || sellBasis === null) {
      stats.stillNonComputable++;
      continue;
    }
    const update = realizedUpdateFor(sellBasis, qty, r);
    if (!update) {
      stats.stillNonComputable++;
      continue;
    }
    updates.push({ transactionId: r.transactionId, update });
    stats.recomputed++;
  }

  return { updates, stats };
}

/**
 * Back-fill frozen AI_PARSED SELL rows for one user from the authoritative
 * ledger + corporate actions. Wraps the pure `computeGainLossBackfill` with the
 * DB round-trip: loads the user's rows, runs the decision engine, and applies
 * any computed updates in one transaction. Best-effort by design — callers
 * (import / delete handlers) treat a failure as non-fatal.
 */
export async function backfillComputedGainLoss(
  userId: string
): Promise<GainLossBackfillStats> {
  const rows = await db
    .select({
      transactionId: capitalTransactions.transactionId,
      sourceType: capitalTransactions.sourceType,
      transactionDate: capitalTransactions.transactionDate,
      symbol: capitalTransactions.symbol,
      side: capitalTransactions.side,
      quantity: capitalTransactions.quantity,
      unitPrice: capitalTransactions.unitPrice,
      grossAmount: capitalTransactions.grossAmount,
      fees: capitalTransactions.fees,
      netAmount: capitalTransactions.netAmount,
      currency: capitalTransactions.currency,
      fxRateEffective: capitalTransactions.fxRateEffective,
      realizedGainLossThb: capitalTransactions.realizedGainLossThb,
    })
    .from(capitalTransactions)
    .where(eq(capitalTransactions.userId, userId))
    .orderBy(capitalTransactions.transactionDate, capitalTransactions.transactionId)
    .execute();

  const actions: CostBasisActionRow[] = [];
  // corporate_actions is optional for the math (the parser itself never applied
  // actions, and the pure engine defaults them to none). It may not exist on
  // every deployment yet (0014 migration not always applied), so a missing
  // table must never block a backfill — fall back to trade-history-only replay.
  // (A deployment missing only the 0023 FMV columns falls back the same way.)
  try {
    const actionRows = await db
      .select({
        id: corporateActions.id,
        symbol: corporateActions.symbol,
        actionType: corporateActions.actionType,
        transactionDate: corporateActions.transactionDate,
        ratioOld: corporateActions.ratioOld,
        ratioNew: corporateActions.ratioNew,
        newSymbol: corporateActions.newSymbol,
        sharesOut: corporateActions.sharesOut,
        priceOut: corporateActions.priceOut,
        parentFmvPerShare: corporateActions.parentFmvPerShare,
        childFmvPerShare: corporateActions.childFmvPerShare,
      })
      .from(corporateActions)
      .where(eq(corporateActions.userId, userId))
      .orderBy(corporateActions.transactionDate, corporateActions.symbol)
      .execute();
    for (const a of actionRows) {
      actions.push({
        id: a.id,
        symbol: a.symbol,
        actionType: a.actionType as CostBasisActionRow["actionType"],
        transactionDate: a.transactionDate,
        ratioOld: a.ratioOld,
        ratioNew: a.ratioNew,
        newSymbol: a.newSymbol,
        sharesOut: a.sharesOut,
        priceOut: a.priceOut,
        parentFmvPerShare: a.parentFmvPerShare,
        childFmvPerShare: a.childFmvPerShare,
      });
    }
  } catch (error) {
    const inner = error && typeof error === "object" && "cause" in error && error.cause instanceof Error
      ? error.cause.message
      : "";
    const msg = `${error instanceof Error ? error.message : String(error)} ${inner}`;
    if (/does not exist/i.test(msg)) {
      // corporate_actions not migrated on this deployment — continue without it.
    } else {
      // A real server error must not silently drop actions either: log and
      // continue (best-effort backfill; trade-history replay is still valid).
      console.warn("backfillComputedGainLoss: corporate actions lookup failed", safeErrorLog(error));
    }
  }

  const { updates, stats } = computeGainLossBackfill(rows, actions);
  if (updates.length > 0) {
    await db.transaction(async (tx) => {
      for (const u of updates) {
        await tx
          .update(capitalTransactions)
          .set({
            costBasis: u.update.costBasis,
            proceeds: u.update.proceeds,
            realizedGainLoss: u.update.realizedGainLoss,
            realizedGainLossThb: u.update.realizedGainLossThb,
          })
          .where(
            and(
              eq(capitalTransactions.transactionId, u.transactionId),
              eq(capitalTransactions.userId, userId)
            )
          )
          .execute();
      }
    });
  }

  return stats;
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