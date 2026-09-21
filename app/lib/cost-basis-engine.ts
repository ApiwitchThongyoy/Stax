// Webull Average-Cost cost-basis engine (pure, DB-free).
//
// Matches Webull's documented "Average Cost" mode for positions:
//   average cost = accumulated open-position amount / accumulated open-position quantity
// where:
//   - every BUY accumulates the AUTHORITATIVE acquisition cost (the broker's
//     Net Amount, i.e. gross + commissions/VAT — fees INCLUDED) into the
//     numerator and the denominator (qty), so the per-share average is a
//     lifetime weighted average of everything bought. Callers that only have a
//     unit price fall back to price×qty (see buyAcquisitionCost).
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
  cumCost: number; // Webull numerator — acquisition cost of every BUY (fees INCLUDED)
}

/** Inputs available for deriving a BUY's authoritative total acquisition cost. */
export interface BuyAcquisitionCostInput {
  quantity?: number | null;
  unitPrice?: number | null;
  /** Broker Net Amount (authoritative; already includes commissions/VAT). */
  netAmount?: number | null;
  /** Broker Gross Amount (price×qty as printed; excludes commissions/VAT). */
  grossAmount?: number | null;
  /** Signed commissions+VAT (negative = rebate). */
  fees?: number | null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The authoritative TOTAL acquisition cost of a BUY — commissions/VAT INCLUDED.
 *
 * Preference order (first trustworthy value wins):
 *   1. the broker's Net Amount (the cash actually paid out),
 *   2. Gross Amount + signed fees (the statement's own Net Amount definition),
 *   3. quantity × unitPrice (legacy fallback when only a price is known).
 * Returns null when none can be derived (honest non-computable).
 *
 * This is the single definition every consumer must use (parser, replay,
 * backfill/recompute, trading journal) so the recorded cost basis and the
 * posted investment account can never disagree.
 */
export function buyAcquisitionCost(input: BuyAcquisitionCostInput): number | null {
  const net = finiteOrNull(input.netAmount);
  if (net !== null && net > 0) return net;
  const gross = finiteOrNull(input.grossAmount);
  if (gross !== null && gross > 0) {
    const total = gross + (finiteOrNull(input.fees) ?? 0);
    if (total > 0) return total;
  }
  const qty = finiteOrNull(input.quantity);
  const price = finiteOrNull(input.unitPrice);
  if (qty !== null && qty > 0 && price !== null && price > 0) return qty * price;
  return null;
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
  seed?: CostBasisSeed,
  /**
   * Authoritative TOTAL acquisition cost of this BUY (commissions INCLUDED).
   * When omitted/non-positive the legacy fallback `qty × price` is used, so
   * callers that only know a price keep working unchanged.
   */
  acquisitionCost?: number | null
): ApplyAverageCostTradeResult {
  const key = symbol.trim().toUpperCase();
  if (!Number.isFinite(qty) || qty <= 0) return { sellBasis: null };

  if (side === "BUY") {
    const priceOk = Number.isFinite(price) && price > 0;
    const acq =
      acquisitionCost != null && Number.isFinite(acquisitionCost) && acquisitionCost > 0
        ? acquisitionCost
        : priceOk
          ? qty * price
          : NaN;
    if (!Number.isFinite(acq) || acq <= 0) return { sellBasis: null };
    const unit = acq / qty;
    const prev = map[key];
    if (!prev || prev.cumQuantity <= 0) {
      // Fresh (or fully liquidated) position: this BUY establishes the baseline.
      map[key] = {
        quantity: qty,
        avgCost: unit,
        cumQuantity: qty,
        cumCost: acq,
      };
      return { sellBasis: null };
    }
    const cumQuantity = prev.cumQuantity + qty;
    const cumCost = prev.cumCost + acq;
    map[key] = {
      quantity: prev.quantity + qty,
      avgCost: cumQuantity > 0 ? cumCost / cumQuantity : unit,
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