// Trade-into-ledger and tax-recon mapping tests (pure, DB-free).
//
// Covers the Path A tax/financial model on the server:
//   - mapToCapitalRow: FX semantics (statement rate -> fx_rate_statement /
//     fx_rate_effective, NEVER fx_rate_bot), THB rows pin the rate to 1,
//     SELL rows with a computable cost basis carry realized gain/loss (THB),
//     everything else stays explicitly null (no invented P&L from cash flows).
//   - applyFxRateFallback: external HISTORICAL FX fallback fires ONLY when a
//     non-THB row has no statement rate (statement FX always wins); applied
//     rate lands in fx_rate_effective and recomputes amountThb + realized
//     gain/loss THB; provider-unavailable stays graceful (base fallback kept,
//     no fabricated rate).
//   - buildTaxRecon: rows with stored realizedGainLossThb produce a REAL
//     taxable total; rows without it are reported not-computable and never
//     contribute to the total.
//   - capitalRowToTransaction: effective-first FX rate fallback.
//
// The imported modules instantiate a postgres client at load time but this
// suite performs ZERO queries (pure functions only). Run:
//   npx tsx scripts/test-statement-tax-recon.mts
import "./_load-env.mjs";

import {
  mapToCapitalRow,
  applyFxRateFallback,
  recomputeCostBasisMap,
  summarizeRows,
} from "../app/lib/statement-pipeline";
import { buildTaxRecon, type TaxReconDetailRow } from "../app/lib/tax-engine";
import {
  capitalRowToTransaction,
  type CapitalLedgerRow,
} from "../app/lib/server-api";
import type { ExtractedTransaction } from "../app/lib/pdfStatementParser";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

const USER_ID = "49af10b3-7b8b-4e0b-bd00-22c2d47822b1";
const DOC_ID = "b3b598f4-ea24-4b85-be8d-8b93ac5263f3";

function txn(overrides: Partial<ExtractedTransaction> = {}): ExtractedTransaction {
  return {
    id: `txn-${Math.random().toString(36).slice(2)}`,
    date: "10/01/2026",
    currency: "USD",
    amount: 100,
    category: "income",
    description: "test row",
    pnlAmount: 0,
    section: "เงินฝาก",
    included: true,
    ...overrides,
  };
}

function map(t: ExtractedTransaction) {
  const out = mapToCapitalRow(t, USER_ID, DOC_ID);
  if (!out.ok) throw new Error(`mapToCapitalRow rejected: ${out.reason}`);
  return out.row;
}

async function main() {
  console.log("\n=== STATEMENT TRADE MAPPING + TAX RECON (pure) ===\n");

  // ---- FX semantics: statement-provided rate must NOT land in fx_rate_bot ----
  const usdBuy = map(
    txn({ symbol: "GLD", side: "BUY", quantity: 10, unitPrice: 50, fees: 1.75, rate: "35.42" })
  );
  ok(usdBuy.fxRateBot === null, "imported row has fx_rate_bot = null (legacy column, importer never writes it)");
  ok(usdBuy.fxRateStatement === "35.42", "statement rate lands in fx_rate_statement");
  ok(usdBuy.fxRateEffective === "35.42", "statement rate used as fx_rate_effective");
  ok(usdBuy.amountThb === "3542.00", "amountThb = amount * effective rate");
  ok(usdBuy.symbol === "GLD" && usdBuy.side === "BUY", "trade detail (symbol/side) carried");
  ok(usdBuy.quantity === "10" && usdBuy.unitPrice === "50", "trade qty/unitPrice carried");

  const thbRow = map(txn({ currency: "THB", amount: 5000, rate: undefined }));
  ok(thbRow.fxRateStatement === "1" && thbRow.fxRateEffective === "1" && thbRow.fxRateBot === null,
    "THB rows pin both FX columns to 1, fx_rate_bot stays null");

  // ---- Realized gain/loss: only computable SELL rows carry a value ----
  const usdSell = map(
    txn({
      symbol: "AAPL",
      side: "SELL",
      quantity: 5,
      unitPrice: 200,
      grossAmount: 1000,
      fees: 6.3,
      proceeds: 993.7,
      costBasis: 900,
      realizedGainLoss: 93.7,
      rate: "35.42",
    })
  );
  ok(usdSell.realizedGainLoss === "93.7", "realized gain/loss carried on computable SELL");
  // 93.7 * 35.42 = 3318.854 -> 3318.85
  ok(usdSell.realizedGainLossThb === "3318.85", "realized gain/loss converted to THB with effective rate");
  ok(usdSell.type === "CASH_IN", "SELL maps to CASH_IN (money in)");

  const plainIn = map(txn({ category: "income", amount: 10 }));
  ok(plainIn.realizedGainLoss === null && plainIn.realizedGainLossThb === null,
    "CASH_IN without trade detail carries NO realized P&L (nothing invented)");

  const feeRow = map(txn({ category: "expense", amount: 6.3, description: "broker fee" }));
  ok(feeRow.type === "CASH_OUT" && feeRow.realizedGainLoss === null && feeRow.realizedGainLossThb === null,
    "expense row stays CASH_OUT with no realized P&L");

  // ---- buildTaxRecon: real taxable totals, no fabrication ----
  const calcRow: TaxReconDetailRow = {
    transactionId: "c1",
    amountThb: "3318.85",
    type: "CASH_IN",
    realizedGainLossThb: "3318.85",
    symbol: "AAPL",
    side: "SELL",
  };
  const plainRow: TaxReconDetailRow = {
    transactionId: "c2",
    amountThb: "5000.00",
    type: "CASH_IN",
    realizedGainLossThb: null,
    symbol: null,
    side: null,
  };
  const mixed = buildTaxRecon([calcRow, plainRow]);
  ok(mixed.computable === true, "tax recon is computable when stored realized gain/loss exists");
  ok(mixed.computedCount === 1 && mixed.nonComputableCount === 1, "1 computed + 1 not-computable row");
  ok(mixed.totalTaxableAmountThb === "3318.85", "taxable total comes ONLY from stored realized gain/loss");
  const nonC = buildTaxRecon([plainRow]);
  ok(nonC.computable === false && nonC.totalTaxableAmountThb === null,
    "no stored gain/loss -> explicitly not computable, NO fabricated total");

  // ---- buildTaxRecon: classification + trade detail threading (UI labels) ----
  const nvdaRow: TaxReconDetailRow = {
    transactionId: "c3",
    amountThb: "4433.37",
    type: "CASH_IN",
    realizedGainLossThb: "140.45",
    symbol: "NVDA",
    side: "SELL",
    quantity: "0.0160",
    unitPrice: "140.43",
    grossAmount: "2.25",
    fees: "0.01",
    proceeds: "2.25",
    costBasis: "2.10",
    realizedGainLoss: "0.15",
    fxRateStatement: "31.57",
    fxRateEffective: "31.57",
    exchange: "NASDAQ",
  };
  const buyRow: TaxReconDetailRow = {
    transactionId: "c4",
    amountThb: "1771.00",
    type: "CASH_OUT",
    realizedGainLossThb: null,
    symbol: "TSLA",
    side: "BUY",
    quantity: "1",
    unitPrice: "50",
    grossAmount: "50",
    fees: "0.5",
    proceeds: "49.5",
    costBasis: "49.5",
    fxRateStatement: "35.42",
    fxRateEffective: "35.42",
    exchange: "NASDAQ",
  };
  const cashRow: TaxReconDetailRow = {
    transactionId: "c5",
    amountThb: "5000.00",
    type: "CASH_IN",
    realizedGainLossThb: null,
    symbol: null,
    side: null,
  };
  const sellNoBasis: TaxReconDetailRow = {
    transactionId: "c6",
    amountThb: "1000.00",
    type: "CASH_IN",
    realizedGainLossThb: null,
    symbol: "MSFT",
    side: "SELL",
  };
  const classified = buildTaxRecon([nvdaRow, buyRow, cashRow, sellNoBasis]);
  ok(classified.computedCount === 1 && classified.nonComputableCount === 3,
    "mixed set: 1 computed SELL + 3 rows without stored gain/loss");
  ok(classified.totalTaxableAmountThb === "140.45",
    "taxable total reflects ONLY the computable SELL");
  const byId = (id: string) =>
    classified.transactions.find((t) => t.transactionId === id)!;
  const computeRow = byId("c3");
  ok(computeRow.classification === "realized-gain" && computeRow.status === "computable",
    "computable SELL row classified as realized-gain");
  ok(computeRow.grossAmount === "2.25" && computeRow.fees === "0.01" &&
    computeRow.proceeds === "2.25" && computeRow.costBasis === "2.10" &&
    computeRow.realizedGainLoss === "0.15" && computeRow.fxRateStatement === "31.57" &&
    computeRow.fxRateEffective === "31.57" && computeRow.exchange === "NASDAQ",
    "computable SELL threads gross/fees/proceeds/costBasis/realized/fx/exchange detail");
  const buyOut = byId("c4");
  ok(buyOut.classification === "buy-basis" && buyOut.status === "not-computable",
    "BUY row classified as buy-basis (status stays not-computable, no fake number)");
  ok(buyOut.quantity === "1" && buyOut.unitPrice === "50" && buyOut.fxRateEffective === "35.42",
    "BUY row carries qty/price/fx detail for display");
  ok(byId("c5").classification === "not-applicable",
    "pure CASH_IN (deposit) classified as not-applicable");
  const noBasis = byId("c6");
  ok(noBasis.classification === "non-computable" && noBasis.symbol === "MSFT",
    "SELL without a computed basis classified as non-computable (real reason, distinct from CASH)");

  // ---- capitalRowToTransaction: effective-first FX rate fallback ----
  const capRow = (
    fxRateBot: string | null,
    fxRateEffective?: string | null
  ): CapitalLedgerRow => ({
    transactionId: "r1",
    userId: USER_ID,
    amountForeign: "100.00",
    currency: "USD",
    transactionDate: "2026-01-10",
    fxRateBot,
    fxRateEffective,
    amountThb: "3542.00",
    type: "CASH_IN",
    sourceType: "AI_PARSED",
    sourceDocumentId: DOC_ID,
  });
  ok(capitalRowToTransaction(capRow("35.42", "37.00")).rate === "37.00",
    "effective rate wins when present");
  ok(capitalRowToTransaction(capRow("35.42")).rate === "35.42",
    "fx_rate_bot used as fallback for historical rows");
  ok(capitalRowToTransaction(capRow(null, null)).rate === "",
    "null FX renders an empty rate string (no crash, no bogus number)");
  ok(capitalRowToTransaction(capRow("35.42")).pnlAmount === null,
    "row without a stored realized gain exposes pnlAmount null (not fake 0)");
  ok(
    capitalRowToTransaction({
      ...capRow("35.42"),
      realizedGainLossThb: "3318.85",
    }).pnlAmount === 3318.85,
    "row WITH a stored realized gain exposes pnlAmount as that authoritative value"
  );
  ok(
    capitalRowToTransaction({
      ...capRow("35.42"),
      realizedGainLossThb: "0",
    }).pnlAmount === 0,
    "an authoritative zero gain stays numeric 0 (distinguishable from null)"
  );

  // ---- re-import rebuild: cost-basis replay + import diagnostics ----
  // Mirror of the real parser math; used to reconcile cost_basis_state after any
  // deletion so a re-import of a deleted document never double-counts buys.
  const replay = recomputeCostBasisMap([
    { symbol: "VRMAX", transactionDate: "2026-01-02", side: "BUY", quantity: "100", unitPrice: "10.00" },
    { symbol: "VRMAX", transactionDate: "2026-01-03", side: "BUY", quantity: "100", unitPrice: "20.00" },
    { symbol: "VRMAX", transactionDate: "2026-01-04", side: "SELL", quantity: "50", unitPrice: "30.00" },
    { symbol: "ABCH", transactionDate: "2026-02-01", side: "SELL", quantity: "15", unitPrice: "6.00" },
  ]);
  ok(
    replay.VRMAX?.quantity === 150 &&
      Math.abs((replay.VRMAX?.avgCost ?? NaN) - 15) < 1e-9,
    "replay: BUY averaging then SELL deduction leaves qty 150 @ avg 15 (parser math)"
  );
  ok(
    replay.ABCH === undefined,
    "replay: SELL with no prior BUY leaves the symbol ABSENT (honest non-computable)"
  );

  const drained = recomputeCostBasisMap([
    { symbol: "UUU", transactionDate: "2026-01-02", side: "BUY", quantity: "10", unitPrice: "5.00" },
    { symbol: "UUU", transactionDate: "2026-01-05", side: "SELL", quantity: "10", unitPrice: "8.00" },
  ]);
  ok(
    drained.UUU === undefined,
    "replay: fully drained position is removed so the next statement re-seeds"
  );

  const reordered = recomputeCostBasisMap([
    { symbol: "ORDK", transactionDate: "2026-01-02", side: "SELL", quantity: "5", unitPrice: "10.00" },
    { symbol: "ORDK", transactionDate: "2026-02-02", side: "BUY", quantity: "10", unitPrice: "5.00" },
  ]);
  ok(
    reordered.ORDK?.quantity === 10,
    "replay: SELL before any BUY contributes nothing; the later BUY establishes qty 10"
  );

  // Import diagnostics: BUY / SELL / CASH split, computable SELLs, statement FX.
  const stats = summarizeRows([
    { side: "BUY", fxRateStatement: "35.42", realizedGainLossThb: null },
    { side: "BUY", fxRateStatement: "35.42", realizedGainLossThb: null },
    { side: "SELL", fxRateStatement: "35.42", realizedGainLossThb: "747.93" },
    { side: "SELL", fxRateStatement: null, realizedGainLossThb: null },
    { side: null, fxRateStatement: null, realizedGainLossThb: null },
  ]);
  ok(
    stats.buyCount === 2 && stats.sellCount === 2 && stats.cashCount === 1,
    "stats: BUY / SELL / CASH counts split correctly"
  );
  ok(
    stats.computableSellCount === 1 && stats.statementFxCount === 3,
    "stats: exactly one computable SELL and 3 rows carry a statement FX rate"
  );
  ok(
    stats.fxRates.length === 1 && stats.fxRates[0] === "35.42",
    "stats: distinct statement FX values are reported"
  );

  // ---- FX resolution priority: statement rate ALWAYS wins over fallback ----
  const stubbedFallback = {
    resolve: async (_date: string, _currency: string) =>
      ({ rate: 99, source: "historical-fx-provider" } as const),
  };
  const nvda = map(
    txn({
      symbol: "NVDA",
      side: "SELL",
      quantity: 1,
      unitPrice: 189,
      amount: 189,
      grossAmount: 189,
      fees: 1,
      proceeds: 188,
      costBasis: 170,
      realizedGainLoss: 18,
      rate: "31.57",
    })
  );
  const nvdaAfter = (await applyFxRateFallback([nvda], stubbedFallback))[0];
  ok(
    nvdaAfter.fxRateEffective === "31.57" && nvdaAfter.fxRateStatement === "31.57",
    "statement FX (31.57) wins, provider fallback is NOT applied to a row that has one"
  );
  ok(
    nvdaAfter.realizedGainLossThb === (18 * 31.57).toFixed(2) &&
      nvdaAfter.amountThb === (189 * 31.57).toFixed(2),
    "statement-rate P&L + amount conversion are NOT recomputed by the fallback"
  );

  // ---- External fallback fires ONLY when statement FX is absent ----
  const noRateSell = map(
    txn({
      symbol: "MSFT",
      side: "SELL",
      quantity: 2,
      unitPrice: 50,
      amount: 100,
      grossAmount: 100,
      fees: 1,
      proceeds: 99,
      costBasis: 80,
      realizedGainLoss: 19,
    })
  );
  const fallbackRows = await applyFxRateFallback([noRateSell], {
    resolve: async () => ({ rate: 34.5, source: "historical-fx-provider" }),
  });
  const fxRow = fallbackRows[0];
  ok(
    fxRow.fxRateStatement === null && fxRow.fxRateEffective === "34.5",
    "external fallback lands in fx_rate_effective ONLY when statement FX is absent (statement stays null)"
  );
  ok(
    fxRow.amountThb === "3450.00" && fxRow.realizedGainLossThb === "655.50",
    "fallback recomputes amountThb (100*34.5) + realized gain THB (19*34.5) from the external rate"
  );
  ok(
    fxRow.fxRateBot === null,
    "external fallback never writes into the legacy fx_rate_bot column"
  );

  const noRateCash = await applyFxRateFallback(
    [map(txn({ category: "income", amount: 120 }))],
    {
      resolve: async () => ({ rate: 34.5, source: "historical-fx-provider" }),
    }
  );
  ok(
    noRateCash[0].fxRateEffective === "34.5" && noRateCash[0].realizedGainLossThb === null,
    "fallback applies to non-THB CASH rows but never invents realized P&L (stays null)"
  );

  const sellUncomputable = await applyFxRateFallback(
    [map(txn({ symbol: "Z", side: "SELL", quantity: 1, unitPrice: 10 }))],
    {
      resolve: async () => ({ rate: 34.5, source: "historical-fx-provider" }),
    }
  );
  ok(
    sellUncomputable[0].realizedGainLossThb === null,
    "SELL without a computed basis keeps realized P&L null even after a fallback rate"
  );

  // ---- THB = 1 is never overridden, and provider-unavailable is graceful ----
  const thbFallback = await applyFxRateFallback(
    [map(txn({ currency: "THB", amount: 5000 }))],
    stubbedFallback
  );
  ok(
    thbFallback[0].fxRateEffective === "1" && thbFallback[0].amountThb === "5000.00",
    "THB rows stay pinned to 1; the fallback is never applied"
  );
  const usdNoProvider = await applyFxRateFallback(
    [map(txn({ currency: "USD", amount: 250 }))],
    { resolve: async () => null }
  );
  ok(
    usdNoProvider[0].fxRateEffective === "1" && usdNoProvider[0].amountThb === "250.00",
    "provider unavailable -> graceful: base fallback kept, no fabricated rate, import still succeeds"
  );

  console.log(`\n================ SUMMARY ================`);
  console.log(`PASS: ${passed}   FAIL: ${failed}`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

void main();