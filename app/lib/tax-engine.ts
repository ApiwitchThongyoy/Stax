// W1-2 — Deterministic Decimal tax core engine.
//
// This engine computes tax from per-transaction realized gain/loss using
// decimal arithmetic ONLY (decimal.js). It never uses JavaScript Number
// floating point for money.
//
// CRITICAL RULE:
// A loss from one transaction MUST NOT offset profit from another transaction.
// taxableAmount of each transaction = max(realizedGainLoss, 0), computed
// explicitly per transaction — never by aggregating profits+losses then
// flooring the sum.
//
// This module is framework-independent and easy to unit test.
import { Decimal } from "decimal.js";

// decimal.js precision: enough for high-precision monetary values (default is
// 20 significant digits; we raise it to comfortably handle large amounts).
Decimal.set({ precision: 40 });

export interface TaxEngineInput {
  transactionId: string;
  // Realized gain/loss for this transaction in THB as a decimal string.
  // Positive = gain (taxable), negative = loss (not offset against others).
  realizedGainLossThb: string;
}

export interface TaxEngineOutput {
  transactionId: string;
  realizedGainLossThb: string;
  taxableAmountThb: string;
  isTaxable: boolean;
  reason: string;
}

export interface TaxEngineSummary {
  transactions: TaxEngineOutput[];
  totalTaxableAmountThb: string;
}

function invalid(transactionId: string): TaxEngineOutput {
  return {
    transactionId,
    realizedGainLossThb: "0.00",
    taxableAmountThb: "0.00",
    isTaxable: false,
    reason: "invalid/non-finite gain-loss input; treated as 0",
  };
}

/**
 * Deterministically convert one transaction's realized gain/loss into its
 * taxable amount.
 *
 * The floor at zero is applied PER TRANSACTION so that a loss never offsets
 * another transaction's profit.
 */
export function calculateTransactionTaxable(
  input: TaxEngineInput
): TaxEngineOutput {
  let gain: Decimal;
  try {
    if (input.realizedGainLossThb === null || input.realizedGainLossThb === undefined) {
      return invalid(input.transactionId);
    }
    gain = new Decimal(input.realizedGainLossThb.trim());
    if (!gain.isFinite()) return invalid(input.transactionId);
  } catch {
    return invalid(input.transactionId);
  }

  // Per-transaction floor: loss -> 0, gain -> kept as-is.
  const taxable = Decimal.max(gain, new Decimal(0));
  const isTaxable = gain.greaterThan(0);

  return {
    transactionId: input.transactionId,
    realizedGainLossThb: gain.toFixed(2),
    taxableAmountThb: taxable.toFixed(2),
    isTaxable,
    reason: isTaxable ? "profit is taxable" : "loss is not taxable (no offset)",
  };
}

/**
 * Run the engine across a set of transactions.
 *
 * totalTaxableAmountThb = sum(max(transactionTaxableAmount, 0)) per transaction.
 * It is NOT computed as max(sum(profits and losses), 0)).
 */
export function calculateTax(
  inputs: TaxEngineInput[]
): TaxEngineSummary {
  const transactions: TaxEngineOutput[] = inputs.map(
    calculateTransactionTaxable
  );

  const total = transactions.reduce(
    (acc, t) => acc.plus(new Decimal(t.taxableAmountThb)),
    new Decimal(0)
  );

  return {
    transactions,
    totalTaxableAmountThb: total.toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// Capital_Transactions -> tax reconstruction (mapping layer).
//
// SEMANTIC GUARD: The Capital_Transactions schema stores ONLY a raw cash value
// (amount_foreign / amount_thb) plus a coarse CASH_IN/CASH_OUT direction. It
// does NOT store cost basis, quantity, unit price, or a separate
// proceeds-vs-cost split, so true realized gain/loss CANNOT be derived from a
// single row (a CASH_IN may be a pure deposit or capital inflow, not a taxable
// profit; a CASH_OUT may be a purchase/withdrawal, not a loss).
//
// Therefore this layer deliberately does NOT fabricate realizedGainLossThb. It
// only produces a semantically neutral, signed raw cash value and an explicit
// "not computable" signal. The deterministic engine (calculateTax) is used only
// when an authoritative upstream caller supplies a real realizedGainLossThb.
// ---------------------------------------------------------------------------
export const TaxNonComputableReason = {
  REALIZED_GAIN_LOSS_NOT_COMPUTABLE: "REALIZED_GAIN_LOSS_NOT_COMPUTABLE",
} as const;

export type TaxNonComputableReasonValue =
  (typeof TaxNonComputableReason)[keyof typeof TaxNonComputableReason];

export interface CapitalTransactionLike {
  transactionId: string;
  amountThb: string;
  type: string; // "CASH_IN" | "CASH_OUT"
}

/**
 * Neutral signed raw cash value in THB for a Capital_Transactions row.
 * This is merely the cash movement direction expressed as a sign — it is NOT a
 * realized gain/loss and carries no taxable meaning on its own.
 */
export function signedTransactionAmountThb(
  row: CapitalTransactionLike
): string {
  try {
    const amountThb = new Decimal(row.amountThb.trim());
    if (!amountThb.isFinite()) return "0.00";
    if (row.type === "CASH_OUT") return amountThb.negated().toFixed(2);
    return amountThb.toFixed(2);
  } catch {
    return "0.00";
  }
}

export interface TaxRowReconResult {
  transactionId: string;
  transactionAmountThb: string;
  realizedGainLossThb: string | null;
  taxableAmountThb: string | null;
  isTaxable: boolean | null;
  status: "not-computable";
  reason: string;
}

export interface TaxReconSummary {
  computable: false;
  reason: string;
  transactions: TaxRowReconResult[];
  totalTaxableAmountThb: null;
}

function notComputableReason(reasonValue: TaxNonComputableReasonValue): string {
  return (
    reasonValue +
    ": schema lacks cost basis / proceeds data to derive true realized gain/loss for this transaction"
  );
}

/**
 * Build a per-transaction reconstruction result that makes the limitation
 * explicit instead of pretending CASH_IN/CASH_OUT is realized gain/loss.
 */
export function reconResultWithoutRealizedGainLoss(
  row: CapitalTransactionLike,
  reasonValue: TaxNonComputableReasonValue = TaxNonComputableReason.REALIZED_GAIN_LOSS_NOT_COMPUTABLE
): TaxRowReconResult {
  return {
    transactionId: row.transactionId,
    transactionAmountThb: signedTransactionAmountThb(row),
    realizedGainLossThb: null,
    taxableAmountThb: null,
    isTaxable: null,
    status: "not-computable",
    reason: notComputableReason(reasonValue),
  };
}

/**
 * Reconstruct every row as explicitly "not computable". Used when the current
 * schema cannot supply authoritative realized gain/loss, so a taxable total is
 * NEVER fabricated from raw cash flows.
 */
export function buildNonComputableTaxRecon(
  rows: CapitalTransactionLike[]
): TaxReconSummary {
  return {
    computable: false,
    reason: notComputableReason(TaxNonComputableReason.REALIZED_GAIN_LOSS_NOT_COMPUTABLE),
    transactions: rows.map((row) =>
      reconResultWithoutRealizedGainLoss(row)
    ),
    totalTaxableAmountThb: null,
  };
}
