// Moving Average-Cost cost-basis engine (pure, DB-free).
//
// Matches Webull / standard Moving Average Cost mode for positions:
//   average cost = live open cost basis / live open quantity
// where:
//   - On BUY:
//       newLiveCostBasis = previousLiveCostBasis + acquisitionCost
//       newLiveQuantity = previousLiveQuantity + buyQuantity
//       newAverageCost = newLiveCostBasis / newLiveQuantity
//   - On partial SELL:
//       costBasisSold = currentAverageCost * soldQuantity
//       newLiveCostBasis = previousLiveCostBasis - costBasisSold
//       newLiveQuantity = previousLiveQuantity - soldQuantity
//     The remaining average cost stays unchanged immediately after SELL.
//   - On subsequent BUY:
//     Average cost is calculated from the REMAINING live cost basis and
//     remaining live quantity, never contaminated by sold historical shares.
//   - Once fully liquidated (quantity = 0), position is cleanly reset to 0
//     so the next BUY starts a fresh baseline.
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
  /** Direct commission if available separately. */
  commission?: number | null;
  /** Direct VAT if available separately. */
  vat?: number | null;
}

import { Decimal } from "decimal.js";

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The authoritative TOTAL acquisition cost of a BUY — capitalized into cost basis.
 * Gross purchase amount + commission/fee component (excluding VAT).
 * Example: TSLY Gross 110.40 + Fee 0.11 = 110.51.
 */
export function buyAcquisitionCost(input: BuyAcquisitionCostInput): number | null {
  const gross = finiteOrNull(input.grossAmount);
  const fees = finiteOrNull(input.fees);
  const commInput = finiteOrNull(input.commission);
  const vatInput = finiteOrNull(input.vat);
  const net = finiteOrNull(input.netAmount);
  const qty = finiteOrNull(input.quantity);
  const price = finiteOrNull(input.unitPrice);

  const vat = vatInput !== null && vatInput > 0 ? new Decimal(vatInput) : new Decimal(0);
  const comm = commInput !== null && commInput > 0 ? new Decimal(commInput) : null;

  // 1. If explicit commission is provided: gross + commission
  if (gross !== null && gross > 0 && comm !== null) {
    return new Decimal(gross).plus(comm).toNumber();
  }

  // 2. If net amount is provided: net - vat (capitalizes commission, excludes VAT)
  if (net !== null && net > 0) {
    return new Decimal(net).minus(vat).toNumber();
  }

  // 3. If gross is provided with fees:
  if (gross !== null && gross > 0) {
    if (fees !== null) {
      return new Decimal(gross).plus(new Decimal(fees).minus(vat)).toNumber();
    }
    return gross;
  }

  // 4. Fallback to qty * price
  if (qty !== null && qty > 0 && price !== null && price > 0) {
    return new Decimal(qty).mul(new Decimal(price)).toNumber();
  }
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
          ? new Decimal(qty).mul(new Decimal(price)).toNumber()
          : NaN;
    if (!Number.isFinite(acq) || acq <= 0) return { sellBasis: null };
    const prev = map[key];
    if (!prev || prev.quantity <= 0 || prev.cumQuantity <= 0) {
      // Fresh (or fully liquidated) position: this BUY establishes the baseline.
      const unit = new Decimal(acq).div(new Decimal(qty)).toNumber();
      map[key] = {
        quantity: qty,
        avgCost: unit,
        cumQuantity: qty,
        cumCost: acq,
      };
      return { sellBasis: null };
    }

    // Webull Average Cost:
    // On BUY:
    // cumCost += acquisitionCost
    // cumQuantity += buyQuantity
    // liveQuantity += buyQuantity
    // avgCost = cumCost / cumQuantity
    const cumQuantity = new Decimal(prev.cumQuantity).plus(new Decimal(qty)).toNumber();
    const cumCost = new Decimal(prev.cumCost).plus(new Decimal(acq)).toNumber();
    const newLiveQuantity = new Decimal(prev.quantity).plus(new Decimal(qty)).toNumber();
    const newAvgCost = new Decimal(cumCost).div(new Decimal(cumQuantity)).toNumber();

    map[key] = {
      quantity: newLiveQuantity,
      avgCost: newAvgCost,
      cumQuantity,
      cumCost,
    };
    return { sellBasis: null };
  }

  // SELL
  let pos = map[key];
  if ((!pos || pos.quantity <= 0) && seed && seed.quantity > 0) {
    pos = {
      quantity: seed.quantity,
      avgCost: seed.avgCost,
      cumQuantity: seed.quantity,
      cumCost: new Decimal(seed.quantity).mul(new Decimal(seed.avgCost)).toNumber(),
    };
    map[key] = pos;
  }

  const availQty = pos ? pos.quantity : 0;
  const basis = pos ? pos.avgCost : undefined;

  // Oversell: soldQty > availableQty rejects/skips without creating fake negative holdings
  if (
    !pos ||
    basis === undefined ||
    !Number.isFinite(basis) ||
    availQty <= 0 ||
    qty > availQty + 1e-6
  ) {
    return { sellBasis: null };
  }

  const remainingQty = new Decimal(availQty).minus(new Decimal(qty));
  if (remainingQty.lte(1e-6)) {
    // Full liquidation: reset qty & basis cleanly to 0 (no floating point residue)
    delete map[key];
  } else {
    // Partial SELL: remaining avg cost stays unchanged immediately after SELL,
    // only live quantity is reduced. Lifetime accumulators cumQuantity and cumCost are NOT reduced by SELL.
    map[key] = {
      quantity: remainingQty.toNumber(),
      avgCost: basis,
      cumQuantity: pos.cumQuantity,
      cumCost: pos.cumCost,
    };
  }

  return { sellBasis: basis };
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