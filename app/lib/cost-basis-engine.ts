// Webull Average-Cost cost-basis engine (pure, DB-free).
//
// Matches Webull's documented "Average Cost" mode for positions:
//   average cost = accumulated open-position amount / accumulated open-position quantity
// where:
//   - every BUY accumulates into the numerator (price×qty, commissions/fees EXCLUDED)
//     and the denominator (qty), so the per-share average is a lifetime weighted
//     average of everything bought.
//   - a SELL does NOT touch the accumulator — the divisor and the average stay the
//     same; only the live open `quantity` is reduced.
//   - once the position is fully liquidated the entry is dropped (Webull resets
//     both average and dilated cost to 0), so the next BUY starts a fresh average.
//
// Implementation notes:
//   - Plain-number math mirrors the historical parser behaviour (an 8-decimal
//     rounding boundary at persist time, `decimalString` → numeric DB columns),
//     so replays agree with what `parseStatementRows` produces.
//   - This engine never rounds THB: the 2-stage gain→THB rounding
//     (round2(gain), then round2(roundedGain × fx)) lives in statement-pipeline
//     (`realizedUpdateFor`) only.
//   - `seed` lets a caller establish the "held before records" baseline from a
//     statement's own PORTFOLIO SUMMARY (or a pre-existing ledger history) when
//     shares were held before records existed.
//     Only the `quantity` and `avgCost` fields are consulted.
//
// This is the single source of truth used by ALL three consumers so they can
// never disagree: pdfStatementParser (fresh imports), recomputeCostBasisMap
// (delete-rebuild reconciliation) and computeGainLossBackfill /
// recomputeAllGainLoss (one-shot recomputes).
export interface CostBasisPosition {
  quantity: number; // live open position
  avgCost: number; // per-share average cost (cumCost / cumQuantity), trade currency
  cumQuantity: number; // Webull divisor — total qty accumulated by BUYs, never reduced by SELL
  cumCost: number; // Webull numerator — price×qty for every BUY (fees excluded)
}
export type CostBasisMap = Record<string, CostBasisPosition>;

/** Minimal seed shape (e.g. a PORTFOLIO SUMMARY entry or a legacy DB row). */
export interface CostBasisSeed {
  quantity: number;
  avgCost: number;
}

export interface ApplyAverageCostTradeResult {
  /** Per-share avg cost usable for the realized-gain computation of THIS sell. */
  sellBasis: number | null;
}

/**
 * Apply one trade to a Webull average-cost map (mutates `map`; the caller owns
 * it). Returns the per-share basis available for a SELL (`null` = honest
 * non-computable). A BUY never yields a basis.
 */
export function applyAverageCostTrade(
  map: CostBasisMap,
  symbol: string,
  side: "BUY" | "SELL",
  qty: number,
  price: number,
  seed?: CostBasisSeed
): ApplyAverageCostTradeResult {
  const key = symbol.trim().toUpperCase();
  if (!Number.isFinite(qty) || qty <= 0) return { sellBasis: null };

  if (side === "BUY") {
    if (!Number.isFinite(price) || price <= 0) return { sellBasis: null };
    const prev = map[key];
    if (!prev || prev.cumQuantity <= 0) {
      // Fresh (or fully liquidated) position: this BUY establishes the baseline.
      map[key] = {
        quantity: qty,
        avgCost: price,
        cumQuantity: qty,
        cumCost: qty * price,
      };
      return { sellBasis: null };
    }
    const cumQuantity = prev.cumQuantity + qty;
    const cumCost = prev.cumCost + qty * price;
    map[key] = {
      quantity: prev.quantity + qty,
      avgCost: cumQuantity > 0 ? cumCost / cumQuantity : price,
      cumQuantity,
      cumCost,
    };
    return { sellBasis: null };
  }

  // SELL — reduce the live quantity; the accumulator and average are untouched.
  let pos = map[key];
  let availQty = pos ? pos.quantity : 0;
  let basis: number | undefined = pos && pos.cumQuantity > 0 ? pos.avgCost : undefined;
  if (basis === undefined && seed && seed.quantity > 0) {
    pos = {
      quantity: seed.quantity,
      avgCost: seed.avgCost,
      cumQuantity: seed.quantity,
      cumCost: seed.quantity * seed.avgCost,
    };
    map[key] = pos;
    availQty = pos.quantity;
    basis = pos.avgCost;
  }
  if (pos) {
    const remaining = Math.max(pos.quantity - qty, 0);
    if (remaining <= 0) {
      // Full liquidation: drop the entry so the next BUY restarts at 0 (Webull).
      delete map[key];
    } else {
      map[key] = { ...pos, quantity: remaining };
    }
  }
  const computable =
    basis !== undefined &&
    Number.isFinite(basis) &&
    availQty > 0 &&
    availQty >= qty;
  return { sellBasis: computable ? (basis as number) : null };
}

/** Full-liquidation / never-maintained entry check for map cleanup. */
export function isEmptyPosition(pos: CostBasisPosition | undefined): boolean {
  return (
    !pos ||
    pos.quantity <= 0 ||
    !Number.isFinite(pos.quantity) ||
    !Number.isFinite(pos.avgCost)
  );
}