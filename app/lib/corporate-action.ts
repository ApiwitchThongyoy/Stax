// Corporate action core (รายการปรับปรุงหุ้น).
//
// Pure + DB-free, in the same spirit as general-ledger.ts: all money math is
// Decimal, no database or network access, so it can be unit-tested in
// isolation. These functions adjust a running-average cost basis (the same
// `CostBasisMap` shape the statement parser maintains) for:
//
//   SPLIT / REVERSE_SPLIT — quantity × (ratioOld:ratioNew), per-share average
//     cost ÷ the same factor. Total cost is preserved exactly, regardless of
//     any `cashInLieu` fractional-share payout (which is recorded
//     informationally and left out of the basis math).
//   RENAME — the position moves to the new symbol key; if the destination
//     already holds shares the two are merged deterministically (live quantity,
//     lifetime cum fields and total cost pooled, avgCost = cumCost / cumQuantity)
//     so a rename can never silently destroy pre-existing cost basis.
//   SPIN_OFF — a NEW position is created (or merged into an existing one).
//     Two modes (never mixed):
//     (a) Legacy (no FMV pair): the received shares are valued at `priceOut`
//         and the parent's basis is untouched. Kept for rows recorded before
//         the FMV columns existed — those rows are surfaced with a derived
//         needsReview flag instead of a guessed backfill.
//     (b) FMV allocation (`parentFmvPerShare` + `childFmvPerShare`, both
//         required together, both positive): the parent's cumCost is split
//         pro-rata by total FMV (parent FMV x held shares : child FMV x shares
//         received); the child receives the allocated cost, the parent keeps
//         the rest. Total cost across parent + child is preserved exactly.
//
// Mirrors the "งานจารเชาว์" hledger helper's cmd_corporate_action: a corporate
// action never fabricates cash P&L; it only keeps the share/avg-cost state
// faithful so later SELL rows compute realized gain/loss correctly.
import { Decimal } from "decimal.js";
import type { CostBasisMap, CostBasisPosition } from "./cost-basis-engine";

Decimal.set({ precision: 40 });

export type CorporateActionType =
  | "SPLIT"
  | "REVERSE_SPLIT"
  | "SPIN_OFF"
  | "RENAME";

export interface CorporateActionInput {
  symbol: string;
  actionType: CorporateActionType;
  /** ISO date (yyyy-mm-dd) — used only for ordering in a series. */
  transactionDate: string;
  ratioOld?: string | null;
  ratioNew?: string | null;
  newSymbol?: string | null;
  sharesOut?: string | null;
  priceOut?: string | null;
  /** SPIN_OFF FMV pair (per-share, trade currency). Both-or-neither. */
  parentFmvPerShare?: string | null;
  childFmvPerShare?: string | null;
  cashInLieu?: string | null;
  description?: string | null;
}

/** Max decimal places kept in the derived map (matches saved DB precision). */
const BASIS_SCALE = 8;

function dec(value: string | number | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  try {
    const s = String(value).trim();
    if (s === "") return null;
    const d = new Decimal(s);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function toNumber(d: Decimal): number {
  return d.toDecimalPlaces(BASIS_SCALE).toNumber();
}

function positionOf(map: CostBasisMap, symbol: string): CostBasisPosition | null {
  const p = map[symbol];
  if (!p) return null;
  if ([p.quantity, p.avgCost, p.cumQuantity, p.cumCost].some((v) => !Number.isFinite(v))) {
    return null;
  }
  return p;
}

/**
 * Apply a single corporate action to a running-average cost basis map.
 * Pure: the input map is never mutated; a new map is returned.
 *
 * @throws on structurally invalid input (missing required fields for the
 *   action type). A split/spin-off for a symbol with no position is a no-op.
 */
export function applyCorporateAction(
  map: CostBasisMap,
  action: CorporateActionInput
): CostBasisMap {
  const symbol = action.symbol.trim().toUpperCase();
  const out: CostBasisMap = { ...map };

  if (action.actionType === "RENAME") {
    if (!action.newSymbol || action.newSymbol.trim() === "") {
      throw new Error("RENAME requires newSymbol");
    }
    const newSymbol = action.newSymbol.trim().toUpperCase();
    if (newSymbol === symbol) return out;
    const pos = positionOf(out, symbol);
    const existing = positionOf(out, newSymbol);
    delete out[symbol];
    if (!pos) return out;
    if (!existing) {
      out[newSymbol] = pos;
      return out;
    }
    // Deterministic merge, never a silent overwrite: renaming onto a symbol
    // with its own cost basis must preserve BOTH positions' basis. Pool the
    // live quantity, the lifetime cum fields and the total cost; the combined
    // average is cumCost / cumQuantity (exactly the sum of its parts).
    const quantity = new Decimal(pos.quantity).plus(new Decimal(existing.quantity));
    const cumQuantity = new Decimal(pos.cumQuantity).plus(new Decimal(existing.cumQuantity));
    const cumCost = new Decimal(pos.cumCost).plus(new Decimal(existing.cumCost));
    const avgCost = cumQuantity.gt(0)
      ? cumCost.div(cumQuantity)
      : new Decimal(existing.avgCost);
    out[newSymbol] = {
      quantity: toNumber(quantity),
      avgCost: toNumber(avgCost),
      cumQuantity: toNumber(cumQuantity),
      cumCost: toNumber(cumCost),
    };
    return out;
  }

  if (action.actionType === "SPIN_OFF") {
    const shares = dec(action.sharesOut);
    const price = dec(action.priceOut);
    if (shares === null || price === null) {
      throw new Error("SPIN_OFF requires sharesOut and priceOut");
    }
    if (shares.lte(0) || price.lte(0)) {
      throw new Error("SPIN_OFF sharesOut and priceOut must be positive");
    }
    const parentFmv = dec(action.parentFmvPerShare);
    const childFmv = dec(action.childFmvPerShare);
    if ((parentFmv === null) !== (childFmv === null)) {
      throw new Error("SPIN_OFF FMV must be both-or-neither (parentFmvPerShare + childFmvPerShare)");
    }
    if (parentFmv !== null && childFmv !== null && (parentFmv.lte(0) || childFmv.lte(0))) {
      throw new Error("SPIN_OFF FMV per-share values must be positive");
    }
    const newSymbol =
      action.newSymbol && action.newSymbol.trim() !== ""
        ? action.newSymbol.trim().toUpperCase()
        : `${symbol}-SP`;
    // FMV allocation: split the parent's cumCost pro-rata by total FMV.
    // Total cost across parent + child is preserved exactly; the parent's
    // live quantity is unchanged (only its unit cost drops).
    if (parentFmv !== null && childFmv !== null) {
      const parent = positionOf(out, symbol);
      if (parent && parent.quantity > 0) {
        const parentQty = new Decimal(parent.quantity);
        const parentCumQty = new Decimal(parent.cumQuantity);
        const parentCumCost = new Decimal(parent.cumCost);
        const parentTotal = parentFmv.mul(parentQty);
        const childTotal = childFmv.mul(shares);
        const grandTotal = parentTotal.plus(childTotal);
        if (grandTotal.gt(0)) {
          const toChild = parentCumCost.mul(childTotal).div(grandTotal);
          const parentCumCostNew = parentCumCost.minus(toChild);
          const parentAvgNew = parentCumQty.gt(0)
            ? parentCumCostNew.div(parentCumQty)
            : new Decimal(parent.avgCost);
          out[symbol] = {
            quantity: parent.quantity,
            avgCost: toNumber(parentAvgNew),
            cumQuantity: parent.cumQuantity,
            cumCost: toNumber(parentCumCostNew),
          };
          const prev = positionOf(out, newSymbol);
          const prevQty = prev ? new Decimal(prev.quantity) : new Decimal(0);
          const prevCumQty = prev ? new Decimal(prev.cumQuantity) : new Decimal(0);
          const prevCumCost = prev ? new Decimal(prev.cumCost) : new Decimal(0);
          const newQty = prevQty.plus(shares);
          const newCumQty = prevCumQty.plus(shares);
          const newCumCost = prevCumCost.plus(toChild);
          const newAvg = newCumQty.gt(0) ? newCumCost.div(newCumQty) : childFmv;
          out[newSymbol] = {
            quantity: toNumber(newQty),
            avgCost: toNumber(newAvg),
            cumQuantity: toNumber(newCumQty),
            cumCost: toNumber(newCumCost),
          };
          return out;
        }
      }
      // No held parent position: fall through to the legacy valuation below
      // (child at priceOut, nothing to split).
    }
    const prev = positionOf(out, newSymbol);
    const prevQty = prev ? new Decimal(prev.quantity) : new Decimal(0);
    const prevCumQty = prev ? new Decimal(prev.cumQuantity) : new Decimal(0);
    const prevCumCost = prev ? new Decimal(prev.cumCost) : new Decimal(0);
    const newQty = prevQty.plus(shares);
    const newCumQty = prevCumQty.plus(shares);
    const newCumCost = prevCumCost.plus(shares.mul(price));
    const newAvg = newCumQty.gt(0) ? newCumCost.div(newCumQty) : price;
    out[newSymbol] = {
      quantity: toNumber(newQty),
      avgCost: toNumber(newAvg),
      cumQuantity: toNumber(newCumQty),
      cumCost: toNumber(newCumCost),
    };
    return out;
  }

  // SPLIT / REVERSE_SPLIT — ratio expressed old:new. Default ratioOld = 1.
  if (action.actionType !== "SPLIT" && action.actionType !== "REVERSE_SPLIT") {
    throw new Error(`unknown actionType ${String(action.actionType)}`);
  }
  const ratioOld = dec(action.ratioOld ?? "1");
  const ratioNew = dec(action.ratioNew);
  if (ratioOld === null || ratioNew === null) {
    throw new Error("SPLIT/REVERSE_SPLIT requires ratioNew");
  }
  if (ratioOld.lte(0) || ratioNew.lte(0)) {
    throw new Error("SPLIT/REVERSE_SPLIT ratios must be positive");
  }
  const pos = positionOf(out, symbol);
  if (!pos || pos.quantity <= 0) return out;
  const qty = new Decimal(pos.quantity);
  const avg = new Decimal(pos.avgCost);
  const cumQty = new Decimal(pos.cumQuantity);
  const cumCost = new Decimal(pos.cumCost);
  const newQty = qty.mul(ratioNew).div(ratioOld);
  const newAvg = avg.mul(ratioOld).div(ratioNew);
  // The Webull accumulator tracks the same instrument: the per-share basis is
  // scaled by the inverse ratio, so total cost is preserved. Cum quantity scales
  // like the position; cum cost stays constant.
  const newCumQty = cumQty.mul(ratioNew).div(ratioOld);
  out[symbol] = {
    quantity: toNumber(newQty),
    avgCost: toNumber(newAvg),
    cumQuantity: toNumber(newCumQty),
    cumCost: toNumber(cumCost),
  };
  return out;
}

/**
 * Apply a series of corporate actions chronologically (by transactionDate,
 * stable for equal dates). Pure — the input map is not mutated.
 * Structurally invalid actions throw; a series built from the DB is validated
 * before saving, so this form is for trusted/ordered input.
 */
export function applyCorporateActionSeries(
  map: CostBasisMap,
  actions: CorporateActionInput[]
): CostBasisMap {
  const sorted = [...actions].sort((a, b) =>
    a.transactionDate.localeCompare(b.transactionDate)
  );
  let out = { ...map };
  for (const action of sorted) {
    out = applyCorporateAction(out, action);
  }
  return out;
}

/** Human-readable one-line summary of an action (Thailand stock-market style). */
export function describeCorporateAction(action: CorporateActionInput): string {
  const symbol = action.symbol.trim().toUpperCase();
  switch (action.actionType) {
    case "SPLIT":
      return `Split ${symbol} ${action.ratioOld ?? 1}:${action.ratioNew ?? ""}`;
    case "REVERSE_SPLIT":
      return `Reverse split ${symbol} ${action.ratioOld ?? 1}:${action.ratioNew ?? ""}`;
    case "RENAME":
      return `Symbol rename ${symbol} -> ${(action.newSymbol ?? "").toUpperCase()}`;
    case "SPIN_OFF":
      return action.parentFmvPerShare != null && action.childFmvPerShare != null
        ? `Spin-off ${(action.newSymbol ?? `${symbol}-SP`).toUpperCase()} from ${symbol} (FMV ${action.parentFmvPerShare}/${action.childFmvPerShare})`
        : `Spin-off ${(action.newSymbol ?? `${symbol}-SP`).toUpperCase()} from ${symbol}`;
    default:
      return `Corporate action ${symbol}`;
  }
}