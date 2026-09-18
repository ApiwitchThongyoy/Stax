import Decimal from "decimal.js";

/** Financial persistence boundary: explicit decimal half-up rounding. */
export function roundMoney(value: Decimal.Value): string {
  return new Decimal(value).toFixed(2, Decimal.ROUND_HALF_UP);
}

/** Convert the exact native cents that are persisted, never the raw amount. */
export function moneyInThb(amount: Decimal.Value, fx: Decimal.Value): string {
  return roundMoney(new Decimal(roundMoney(amount)).mul(fx));
}

/** Basis comes from the unchanged average-cost engine; net already includes fees. */
export function realizedAmounts(net: Decimal.Value, basis: Decimal.Value, fx: Decimal.Value | null) {
  const proceeds = roundMoney(net);
  const costBasis = roundMoney(basis);
  // Gain must reconcile to the exact proceeds and basis that are persisted.
  const realizedGainLoss = roundMoney(new Decimal(proceeds).minus(costBasis));
  return {
    costBasis,
    proceeds,
    realizedGainLoss,
    realizedGainLossThb: fx == null ? null : moneyInThb(realizedGainLoss, fx),
  };
}
