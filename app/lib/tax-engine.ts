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

/**
 * UI-facing row classification that distinguishes "genuinely non-computable"
 * (SELL without a usable cost basis) from "not a realized-gain event at all"
 * (deposits, withdrawals, fees, FX conversions) and BUY rows that merely build
 * cost basis. `status` keeps its original meaning (computable / not-computable);
 * `classification` refines HOW the frontend labels a row without fabricating
 * numbers.
 */
export type TaxRowClassification =
  | "realized-gain"
  | "non-computable"
  | "buy-basis"
  | "not-applicable";

export function classifyCapitalTransaction(row: {
  side?: string | null;
  type?: string | null;
}): TaxRowClassification {
  const side = row.side?.trim().toUpperCase();
  if (side === "SELL") return "non-computable";
  if (side === "BUY") return "buy-basis";
  return "not-applicable";
}

export interface TaxRowReconResult {
  transactionId: string;
  transactionAmountThb: string;
  realizedGainLossThb: string | null;
  taxableAmountThb: string | null;
  isTaxable: boolean | null;
  status: "computable" | "not-computable";
  classification: TaxRowClassification;
  reason: string;
  symbol?: string | null;
  side?: string | null;
  quantity?: string | null;
  unitPrice?: string | null;
  grossAmount?: string | null;
  fees?: string | null;
  proceeds?: string | null;
  costBasis?: string | null;
  realizedGainLoss?: string | null;
  fxRateStatement?: string | null;
  fxRateEffective?: string | null;
  exchange?: string | null;
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
    ": no stored realized gain/loss for this transaction (only SELL rows with a known running-average cost basis carry one)"
  );
}

/**
 * Build a per-transaction reconstruction result that makes the limitation
 * explicit instead of pretending CASH_IN/CASH_OUT is realized gain/loss.
 *
 * `classification` defaults to the row's category: SELL => "non-computable",
 * BUY => "buy-basis", everything else (deposits/withdrawals/fees/FX) =>
 * "not-applicable". Pass an explicit value to override.
 */
export function reconResultWithoutRealizedGainLoss(
  row: CapitalTransactionLike,
  reasonValue: TaxNonComputableReasonValue = TaxNonComputableReason.REALIZED_GAIN_LOSS_NOT_COMPUTABLE,
  classification?: TaxRowClassification
): TaxRowReconResult {
  const detail = row as TaxReconDetailRow;
  return {
    transactionId: row.transactionId,
    transactionAmountThb: signedTransactionAmountThb(row),
    realizedGainLossThb: null,
    taxableAmountThb: null,
    isTaxable: null,
    status: "not-computable",
    classification: classification ?? classifyCapitalTransaction(detail),
    reason: notComputableReason(reasonValue),
    symbol: detail.symbol ?? null,
    side: detail.side ?? null,
    quantity: detail.quantity ?? null,
    unitPrice: detail.unitPrice ?? null,
    grossAmount: detail.grossAmount ?? null,
    fees: detail.fees ?? null,
    proceeds: detail.proceeds ?? null,
    costBasis: detail.costBasis ?? null,
    realizedGainLoss: detail.realizedGainLoss ?? null,
    fxRateStatement: detail.fxRateStatement ?? null,
    fxRateEffective: detail.fxRateEffective ?? null,
    exchange: detail.exchange ?? null,
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

// ---------------------------------------------------------------------------
// Authoritative tax reconstruction (migration 0009)
//
// When Capital_Transactions rows carry a stored realizedGainLossThb (persisted
// deterministically by the statement pipeline for SELL trades with a known
// running-average cost basis), the engine computes the REAL taxable amount. All
// arithmetic is Decimal. Rows without that value remain explicitly
// "not-computable" — the engine never converts CASH_IN/CASH_OUT into gain/loss.
// ---------------------------------------------------------------------------

export interface TaxReconDetailRow extends CapitalTransactionLike {
  realizedGainLossThb?: string | null;
  symbol?: string | null;
  side?: string | null;
  quantity?: string | null;
  unitPrice?: string | null;
  grossAmount?: string | null;
  fees?: string | null;
  proceeds?: string | null;
  costBasis?: string | null;
  realizedGainLoss?: string | null;
  fxRateStatement?: string | null;
  fxRateEffective?: string | null;
  exchange?: string | null;
  transactionDate?: string | null;
  currency?: string | null;
}

export interface ComputableTaxRow extends TaxRowReconResult {
  status: "computable";
  classification: "realized-gain";
  realizedGainLossThb: string;
  taxableAmountThb: string;
  isTaxable: boolean;
  symbol?: string | null;
  side?: string | null;
  quantity?: string | null;
  unitPrice?: string | null;
  grossAmount?: string | null;
  fees?: string | null;
  proceeds?: string | null;
  costBasis?: string | null;
  realizedGainLoss?: string | null;
  fxRateStatement?: string | null;
  fxRateEffective?: string | null;
  exchange?: string | null;
}

export interface TaxReconSummaryV2 {
  computable: boolean;
  computedCount: number;
  nonComputableCount: number;
  reason: string;
  transactions: (TaxRowReconResult | ComputableTaxRow)[];
  totalTaxableAmountThb: string | null;
}

/**
 * Build an authoritative tax reconstruction from stored, real realized
 * gain/loss values. Rows without realizedGainLossThb are reported as explicitly
 * not-computable (and never contribute to the taxable total).
 */
export function buildTaxRecon(rows: TaxReconDetailRow[]): TaxReconSummaryV2 {
  const computableRows = rows.filter(
    (r) =>
      r.realizedGainLossThb !== undefined &&
      r.realizedGainLossThb !== null &&
      r.realizedGainLossThb.trim() !== ""
  );

  const engine = calculateTax(
    computableRows.map((r) => ({
      transactionId: r.transactionId,
      realizedGainLossThb: r.realizedGainLossThb as string,
    }))
  );
  const engineByTxn = new Map(
    engine.transactions.map((t) => [t.transactionId, t])
  );

  const transactions: (TaxRowReconResult | ComputableTaxRow)[] = rows.map(
    (row) => {
      const eng = engineByTxn.get(row.transactionId);
      if (eng) {
        return {
          transactionId: row.transactionId,
          transactionAmountThb: signedTransactionAmountThb(row),
          realizedGainLossThb: eng.realizedGainLossThb,
          taxableAmountThb: eng.taxableAmountThb,
          isTaxable: eng.isTaxable,
          status: "computable",
          classification: "realized-gain",
          reason: eng.reason,
          symbol: row.symbol ?? null,
          side: row.side ?? null,
          quantity: row.quantity ?? null,
          unitPrice: row.unitPrice ?? null,
          grossAmount: row.grossAmount ?? null,
          fees: row.fees ?? null,
          proceeds: row.proceeds ?? null,
          costBasis: row.costBasis ?? null,
          realizedGainLoss: row.realizedGainLoss ?? null,
          fxRateStatement: row.fxRateStatement ?? null,
          fxRateEffective: row.fxRateEffective ?? null,
          exchange: row.exchange ?? null,
        };
      }
      return reconResultWithoutRealizedGainLoss(row);
    }
  );

  const computable = computableRows.length > 0;
  return {
    computable,
    computedCount: computableRows.length,
    nonComputableCount: rows.length - computableRows.length,
    reason: computable
      ? "Realized gain/loss computed deterministically from trade rows with a known running-average cost basis."
      : notComputableReason(
          TaxNonComputableReason.REALIZED_GAIN_LOSS_NOT_COMPUTABLE
        ),
    transactions,
    totalTaxableAmountThb: computable ? engine.totalTaxableAmountThb : null,
  };
}
