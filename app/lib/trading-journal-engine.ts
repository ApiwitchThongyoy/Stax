// Trading-journal pure engine (DB-free).
//
// The trading journal ("สมุดบันทึกการซื้อขาย") carries ONLY stock trades:
// BUY / SELL / DIVIDEND, read from the journal entries. Rows of any other
// kind (interest, capital-gain summary lines, fees/VAT, equity deposits,
// currency-exchange transfers) are filtered out by isTradeJournalRow and
// never reach this engine.
//
// Replays the in-scope chronological list through the Webull average-cost
// engine (cost-basis-engine.ts) and attaches the per-row "avgCostAtTime":
// the position's average cost BEFORE the trade landed — what the
// portfolio's own basis was at that moment. BUY rows establish the
// average; SELL rows report the (unchanged) average they were settled
// against; dividend rows carry null.
//
// All arithmetic mirrors the parser's plain-number math so the replayed
// averages agree with what the statement pipeline writes to cost_basis_state.
// Server-authoritative: the route computes these once, React renders verbatim.
import {
  applyAverageCostTrade,
  buyAcquisitionCost,
  type CostBasisMap,
} from "./cost-basis-engine";
import { applyCorporateAction, type CorporateActionInput } from "./corporate-action";
import type { CapitalJournalRecord } from "./journal-ledger-read";

/** The only 3 kinds the trading journal carries; OTHER is a never-in-scope catch-all. */
export type JournalSide = "BUY" | "SELL" | "DIVIDEND" | "OTHER";

export interface TradingJournalEntry {
  transactionId: string;
  date: string; // ISO date
  side: JournalSide;
  symbol: string | null;
  price: string | null; // unit_price (trades only)
  dividendPerShare: null; // dividends carry no per-share field in stored rows
  quantity: string | null; // share qty (trades)
  amount: string | null; // gross_amount (trades) / amount (dividends)
  fees: string | null; // |fees|
  netAmount: string | null; // net_amount (trades) / amount (dividends)
  avgCostAtTime: number | null; // replayed historical average, trade currency
  currency: string | null; // trade/dividend currency
  amountThb: string | null;
  fxRate: string | null; // fx_rate_effective preferred, statement fallback
  /** Investor's own note on this entry (verbatim, endpoint-written). */
  note: string | null;
}

/** Classify one journal record into a trading-journal side (BUY/SELL/DIVIDEND/OTHER). */
export function classifyJournalSide(
  side: string | null,
  category: string | null,
  section: string | null
): JournalSide {
  if (side === "BUY") return "BUY";
  if (side === "SELL") return "SELL";
  if (
    category === "income" &&
    typeof section === "string" &&
    section.startsWith("เงินปันผล")
  ) {
    return "DIVIDEND";
  }
  // Interest, capital-gain summary lines, fees, deposits, FX transfers:
  // never a trading-journal kind.
  return "OTHER";
}

/** Extract the ticker from a dividend section label ("เงินปันผล:goog" → "GOOG"). */
export function dividendSymbolFor(
  symbol: string | null,
  section: string | null
): string | null {
  if (symbol && symbol.trim() !== "") return symbol;
  if (typeof section === "string" && section.startsWith("เงินปันผล:")) {
    const t = section.slice("เงินปันผล:".length).trim();
    if (t && t !== "ไม่ทราบสัญลักษณ์") return t.toUpperCase();
  }
  return null;
}

function toNum(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

type JournalReplayEvent =
  | { kind: "trade"; row: CapitalJournalRecord }
  | { kind: "action"; action: CorporateActionInput };

/**
 * Merge journal rows and corporate actions into one chronological replay
 * stream. Uses the SAME ordering rule as statement-pipeline.recomputeCostBasisMap
 * so the replayed averages agree with the full-ledger recompute: dates
 * ascending; same-date TRADES apply BEFORE same-date actions (a same-day split
 * never rewrites the snapshot a trade reports); stable within each kind.
 */
function mergeJournalReplayEvents(
  rows: CapitalJournalRecord[],
  actions: CorporateActionInput[]
): JournalReplayEvent[] {
  const events: JournalReplayEvent[] = [
    ...rows.map((r) => ({ kind: "trade" as const, row: r })),
    ...actions.map((a) => ({ kind: "action" as const, action: a })),
  ];
  events.sort((a, b) => {
    const da = a.kind === "trade" ? a.row.entryDate : a.action.transactionDate;
    const db = b.kind === "trade" ? b.row.entryDate : b.action.transactionDate;
    const d = da.localeCompare(db);
    if (d !== 0) return d;
    if (a.kind !== b.kind) return a.kind === "trade" ? -1 : 1;
    return 0;
  });
  return events;
}

/**
 * Apply a corporate action to the replay map, SKIPPING structurally invalid
 * rows instead of crashing the whole replay. A malformed legacy or
 * hand-inserted row (e.g. a SPLIT without ratioNew) cannot be faithfully
 * replayed, so the affected symbol's averages simply fall back to
 * trades-only semantics for that action — the same graceful degradation a
 * missing corporate_actions table already gives. Write paths still reject
 * invalid actions via applyCorporateAction itself.
 */
function applyActionOrSkip(
  map: CostBasisMap,
  action: CorporateActionInput
): CostBasisMap {
  try {
    return applyCorporateAction(map, action);
  } catch {
    return map;
  }
}

/**
 * Build trading-journal entries from journal records.
 *
 * Expects rows oldest-first (the route sorts by entryDate/entryNo) and
 * already limited to BUY/SELL/DIVIDEND by isTradeJournalRow. Replays
 * BUY/SELL chronologically through the average-cost engine; dividend rows
 * pass through with avgCostAtTime null. Only asset BUY/SELL rows move the
 * engine — nothing else touches the basis.
 *
 * Corporate actions (split / reverse split / rename / spin-off) interleave
 * into the same chronological replay (trades before same-date actions), so
 * the reported avgCostAtTime agrees with what the statement pipeline writes
 * to cost_basis_state after those actions.
 */
export function buildTradingJournalEntries(
  rows: CapitalJournalRecord[],
  actions: CorporateActionInput[] = []
): TradingJournalEntry[] {
  let map: CostBasisMap = {};
  const out: TradingJournalEntry[] = [];

  for (const ev of mergeJournalReplayEvents(rows, actions)) {
    if (ev.kind === "action") {
      map = applyActionOrSkip(map, ev.action);
      continue;
    }
    const r = ev.row;
    const journalSide = classifyJournalSide(r.side, r.category, r.section);
    const symbol =
      journalSide === "DIVIDEND"
        ? dividendSymbolFor(r.symbol, r.section)
        : r.symbol;
    let avgCostAtTime: number | null = null;

    if ((journalSide === "BUY" || journalSide === "SELL") && symbol) {
      const qty = toNum(r.quantity);
      // Snapshot BEFORE the trade lands: BUY rows report the current average
      // (null when this BUY establishes the position), SELL rows report the
      // unchanged average the sale settles against.
      const pos = map[symbol.trim().toUpperCase()];
      avgCostAtTime = pos && pos.cumQuantity > 0 ? pos.avgCost : null;
      const price = toNum(r.unitPrice);
      if (qty !== null && qty > 0) {
        if (journalSide === "BUY") {
          const acquisitionCost = buyAcquisitionCost({
            quantity: qty,
            unitPrice: price,
            netAmount: toNum(r.netAmount),
            grossAmount: toNum(r.grossAmount),
            fees: toNum(r.fees),
          });
          if (acquisitionCost !== null) {
            applyAverageCostTrade(map, symbol, "BUY", qty, price ?? 0, undefined, acquisitionCost);
          }
        } else if (journalSide === "SELL") {
          applyAverageCostTrade(map, symbol, "SELL", qty, price ?? 0);
        }
      }
    }

    const feesAbs = toNum(r.fees);
    const gross = r.grossAmount ?? r.amount;
    out.push({
      transactionId: r.sourceTransactionId ?? "",
      date: r.entryDate,
      side: journalSide,
      symbol,
      price: r.unitPrice,
      dividendPerShare: null,
      quantity: r.quantity,
      amount: gross,
      fees:
        feesAbs !== null
          ? String(Math.abs(feesAbs))
          : r.fees,
      netAmount: r.netAmount ?? r.amount,
      avgCostAtTime,
      currency: r.currency,
      amountThb: r.amountThb,
      fxRate: r.fxRateEffective ?? r.fxRateStatement,
      note: r.note ?? null,
    });
  }

  return out;
}

/**
 * Subset of journal rows the journal page cares about: stock trades only
 * (BUY/SELL) plus dividend income rows. Interest, capital-gain summary
 * lines, fees/VAT, deposits, FX transfers and GL-manual lines never enter.
 */
export function isTradeJournalRow(
  side: string | null,
  category: string | null,
  section: string | null
): boolean {
  if (side === "BUY" || side === "SELL") return true;
  if (category === "income") {
    return (
      typeof section === "string" && section.startsWith("เงินปันผล")
    );
  }
  return false;
}

/** One computable SELL referenced by the behavior statistics. */
export interface BehaviorTradeRef {
  symbol: string;
  date: string; // ISO date of the SELL
  realizedGainLossThb: string; // stored value, verbatim
}

/** Portfolio-level investing-behavior statistics (pure, DB-free). */
export interface BehaviorStats {
  computableSellCount: number;
  winningSellCount: number;
  losingSellCount: number;
  /** wins / computable (0..1); null when nothing is computable. */
  winRate: number | null;
  /** Σgains / Σ|losses|; null when there is no loss to divide by. */
  profitFactor: number | null;
  bestTrade: BehaviorTradeRef | null;
  worstTrade: BehaviorTradeRef | null;
  /** Quantity-weighted average holding period in days; null when unknown. */
  avgHoldingDays: number | null;
}

function isoToEpochDay(iso: string): number | null {
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? t / 86400000 : null;
}

/**
 * Apply a corporate action to the quantity-weighted vintage map, mirroring
 * cost-basis-engine semantics with the SAME date as the holding period:
 *   SPLIT / REVERSE_SPLIT — scale the key's live qty by the ratio.
 *   RENAME — move the key; a destination key with its own vintage merges by
 *     pooled qty (holding-day weight-averaged, never destroyed).
 *   SPIN_OFF — a child key starts its holding period on the action date.
 * Purely structural (this map only tracks { qty, day }); cash/FMV never matter.
 */
function applyActionToVintage(
  vintage: Map<string, { qty: number; day: number }>,
  action: CorporateActionInput
): void {
  const symbol = action.symbol.trim().toUpperCase();
  if (action.actionType === "SPLIT" || action.actionType === "REVERSE_SPLIT") {
    const ratioOld = parseFloat(action.ratioOld ?? "1");
    const ratioNew = parseFloat(action.ratioNew ?? "");
    if (
      !Number.isFinite(ratioOld) ||
      !Number.isFinite(ratioNew) ||
      ratioOld <= 0 ||
      ratioNew <= 0
    ) {
      return;
    }
    const cur = vintage.get(symbol);
    if (cur) vintage.set(symbol, { qty: cur.qty * (ratioNew / ratioOld), day: cur.day });
    return;
  }
  if (action.actionType === "RENAME") {
    const newSymbol = (action.newSymbol ?? "").trim().toUpperCase();
    if (!newSymbol || newSymbol === symbol) return;
    const cur = vintage.get(symbol);
    if (!cur) return;
    const existing = vintage.get(newSymbol);
    if (!existing) {
      vintage.set(newSymbol, cur);
      vintage.delete(symbol);
      return;
    }
    const qty = cur.qty + existing.qty;
    vintage.set(newSymbol, {
      qty,
      day: qty > 0 ? (cur.qty * cur.day + existing.qty * existing.day) / qty : existing.day,
    });
    vintage.delete(symbol);
    return;
  }
  if (action.actionType === "SPIN_OFF") {
    const shares = parseFloat(action.sharesOut ?? "");
    const day = isoToEpochDay(action.transactionDate);
    if (!Number.isFinite(shares) || shares <= 0 || day === null) return;
    const rawChild = action.newSymbol ?? `${symbol}-SP`;
    const child = (rawChild.trim() === "" ? `${symbol}-SP` : rawChild).toUpperCase();
    const cur = vintage.get(child);
    if (!cur) vintage.set(child, { qty: shares, day });
    else {
      const qty = cur.qty + shares;
      vintage.set(child, { qty, day: (cur.qty * cur.day + shares * day) / qty });
    }
  }
}

/**
 * Build portfolio-level behavior statistics from journal records.
 *
 * Expects rows oldest-first. Only computable SELLs (a stored
 * realizedGainLossThb) contribute — non-computable SELLs are never valued.
 * The holding period of each SELL is measured against the position's
 * "vintage": the quantity-weighted average purchase date, replayed with the
 * same math as the average-cost engine (BUYs weight in, SELLs reduce the
 * live quantity but never move the vintage). Dividends and non-trade rows
 * never touch the vintage. Corporate actions interleave into the same
 * chronological replay so split/rename/spin-off positions measure holding
 * periods on the same adjusted quantities as the cost-basis cache.
 */
export function buildBehaviorStats(
  rows: CapitalJournalRecord[],
  actions: CorporateActionInput[] = []
): BehaviorStats {
  const vintage = new Map<string, { qty: number; day: number }>();
  let computable = 0;
  let wins = 0;
  let losses = 0;
  let gainSum = 0;
  let lossAbsSum = 0;
  let best: BehaviorTradeRef | null = null;
  let worst: BehaviorTradeRef | null = null;
  let bestGain = -Infinity;
  let worstGain = Infinity;
  let holdDaySum = 0;
  let holdCount = 0;

  for (const ev of mergeJournalReplayEvents(rows, actions)) {
    if (ev.kind === "action") {
      applyActionToVintage(vintage, ev.action);
      continue;
    }
    const r = ev.row;
    if (r.side === "BUY" && r.symbol) {
      const qty = toNum(r.quantity);
      const day = isoToEpochDay(r.entryDate);
      if (qty === null || qty <= 0 || day === null) continue;
      const key = r.symbol.trim().toUpperCase();
      const prev = vintage.get(key);
      if (!prev || prev.qty <= 0) {
        vintage.set(key, { qty, day });
      } else {
        vintage.set(key, {
          qty: prev.qty + qty,
          day: (prev.qty * prev.day + qty * day) / (prev.qty + qty),
        });
      }
      continue;
    }
    if (r.side === "SELL" && r.symbol) {
      const g = toNum(r.realizedGainLossThb);
      if (g === null) continue;
      computable++;
      const key = r.symbol.trim().toUpperCase();
      if (g > 0) {
        wins++;
        gainSum += g;
      } else if (g < 0) {
        losses++;
        lossAbsSum += Math.abs(g);
      }
      if (g > bestGain) {
        bestGain = g;
        best = {
          symbol: key,
          date: r.entryDate.slice(0, 10),
          realizedGainLossThb: (r.realizedGainLossThb as string).trim(),
        };
      }
      if (g < worstGain) {
        worstGain = g;
        worst = {
          symbol: key,
          date: r.entryDate.slice(0, 10),
          realizedGainLossThb: (r.realizedGainLossThb as string).trim(),
        };
      }
      const qty = toNum(r.quantity);
      const v = vintage.get(key);
      const sellDay = isoToEpochDay(r.entryDate);
      if (
        qty !== null &&
        qty > 0 &&
        v &&
        v.qty >= qty &&
        sellDay !== null &&
        v.day <= sellDay
      ) {
        holdDaySum += sellDay - v.day;
        holdCount++;
        const remaining = v.qty - qty;
        if (remaining <= 0) vintage.delete(key);
        else vintage.set(key, { qty: remaining, day: v.day });
      }
    }
  }

  return {
    computableSellCount: computable,
    winningSellCount: wins,
    losingSellCount: losses,
    winRate: computable > 0 ? wins / computable : null,
    profitFactor: lossAbsSum > 0 ? gainSum / lossAbsSum : null,
    bestTrade: best,
    worstTrade: worst,
    avgHoldingDays: holdCount > 0 ? holdDaySum / holdCount : null,
  };
}
