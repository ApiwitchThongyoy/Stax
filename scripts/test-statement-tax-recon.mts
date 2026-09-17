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
//     gain/loss THB; provider-unavailable leaves fxRateEffective/amountThb NULL
//     (never a fabricated 1:1 rate, never 0).
//   - capitalRowToTransaction: effective-first FX rate fallback.
//   - 2-stage gain rounding is INTENTIONAL: realizedGainLoss = round2(net -
//     basis), then realizedGainLossThb = round2(roundedGain x fx), so the pair
//     is always mutually consistent (never "simplify" to a single stage).
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
  computeGainLossBackfill,
  recomputeAllGainLoss,
  type GainLossBackfillRow,
} from "../app/lib/statement-pipeline";
import {
  capitalRowToTransaction,
  type CapitalLedgerRow,
} from "../app/lib/server-api";
import {
  postCapitalRow,
  buildStatementJournalEntries,
} from "../app/lib/posting-engine";
import { applyCorporateAction } from "../app/lib/corporate-action";
import type { CostBasisMap } from "../app/lib/cost-basis-engine";
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

  // ---- Dividend symbol derivation: section "เงินปันผล:X" fills symbol column
  // so the dividend account ledger and memo field can show which stock. ----
  const divRow = map(txn({ category: "income", section: "เงินปันผล:goog", symbol: undefined }));
  ok(divRow.symbol === "GOOG", "dividend symbol derived from section 'เงินปันผล:goog' -> GOOG");
  const divUpper = map(txn({ category: "income", section: "เงินปันผล:NVDA", symbol: undefined }));
  ok(divUpper.symbol === "NVDA", "dividend symbol derived uppercase from section even when ticker was already upper");
  const noTicker = map(txn({ category: "income", section: "เงินปันผล:ไม่ทราบสัญลักษณ์", symbol: undefined }));
  ok(noTicker.symbol === null, "dividend symbol stays null when section contains unknown-marker");
  const withExplicit = map(txn({ category: "income", section: "เงินปันผล:xom", symbol: "exxon" }));
  ok(withExplicit.symbol === "exxon", "explicit t.symbol preserved verbatim (never derived/replaced)");

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
    usdNoProvider[0].fxRateEffective === null && usdNoProvider[0].amountThb === null,
    "provider unavailable -> fxRateEffective/amountThb stay NULL (no 1:1 rate, no fabricated 250 THB)"
  );

  // ---- R3: unknown-FX rows are honest (statement -> provider -> NULL) ----
  // (A) statement rate wins: USD 100 @ 35.42 -> 3542 THB.
  const r3a = map(txn({ currency: "USD", amount: 100, rate: "35.42" }));
  ok(
    r3a.fxRateStatement === "35.42" &&
      r3a.fxRateEffective === "35.42" &&
      r3a.amountThb === "3542.00",
    "R3 (A) statement FX 35.42 -> amountThb 3542.00"
  );

  // (B) no statement rate, provider resolves 34.50 -> 3450 THB.
  const r3bBase = map(txn({ currency: "USD", amount: 100, rate: undefined }));
  ok(
    r3bBase.fxRateStatement === null &&
      r3bBase.fxRateEffective === null &&
      r3bBase.amountThb === null,
    "R3 (B) no statement rate -> base row has NULL FX/THB (no silent 1:1)"
  );
  const r3b = (
    await applyFxRateFallback([r3bBase], {
      resolve: async () => ({ rate: 34.5, source: "historical-fx-provider" }),
    })
  )[0];
  ok(
    r3b.fxRateEffective === "34.5" && r3b.amountThb === "3450.00",
    "R3 (B) provider FX 34.50 -> amountThb 3450.00"
  );

  // (C) no statement rate, provider unavailable -> NULL, never 1:1 / 100 THB.
  const r3c = (
    await applyFxRateFallback(
      [map(txn({ currency: "USD", amount: 100, rate: undefined }))],
      { resolve: async () => null }
    )
  )[0];
  ok(
    r3c.fxRateEffective === null &&
      r3c.amountThb === null &&
      r3c.amountThb !== "100.00" &&
      r3c.fxRateEffective !== "1",
    "R3 (C) provider unavailable -> NULL FX/THB (never 1:1, never 100 THB)"
  );

  // (D) THB rows stay pinned to 1 with amountThb = amountForeign.
  const r3d = map(txn({ currency: "THB", amount: 100, rate: undefined }));
  ok(
    r3d.fxRateEffective === "1" &&
      r3d.fxRateStatement === "1" &&
      r3d.amountThb === "100.00",
    "R3 (D) THB 100 -> FX 1, amountThb 100.00"
  );

  // (E) Journal posting: a non-THB row with unknown FX must NOT post.
  const r3eUnknown = map(txn({ category: "income", currency: "USD", amount: 100, rate: undefined }));
  ok(
    postCapitalRow(r3eUnknown).ok === false,
    "R3 (E) postCapitalRow refuses a non-THB row with unknown FX"
  );
  const r3eEntry = buildStatementJournalEntries([r3eUnknown])[0];
  ok(
    r3eEntry.postingState === "SKIPPED" &&
      r3eEntry.entry.lines.length === 0,
    "R3 (E) unknown-FX row becomes a SKIPPED journal entry with ZERO lines (never a fabricated 1:1 posting)"
  );
  ok(
    !r3eEntry.entry.lines.some((l) => l.fxRateEffective === "1" || l.fxRateEffective === 1),
    "R3 (E) no posted line ever carries an invented rate of 1 for the unknown-FX row"
  );
  // Control: a THB row with the same shape still posts normally.
  const r3eThb = map(txn({ category: "income", currency: "THB", amount: 100 }));
  ok(
    postCapitalRow(r3eThb).ok === true &&
      buildStatementJournalEntries([r3eThb])[0].postingState === "POSTED",
    "R3 (E) control: a THB row still posts normally"
  );

  // ---- Gain/loss backfill: heal FROZEN SELL rows (out-of-order imports) ----
  const bfRow = (
    overrides: Partial<GainLossBackfillRow>
  ): GainLossBackfillRow => ({
    transactionId: overrides.transactionId ?? "bf",
    sourceType: "AI_PARSED",
    transactionDate: "2026-02-05",
    symbol: "AAA",
    side: "SELL",
    quantity: "5",
    unitPrice: "60",
    grossAmount: "300",
    fees: "10",
    netAmount: null,
    currency: "USD",
    fxRateEffective: "35.42",
    realizedGainLossThb: null,
    ...overrides,
  });

  const bfFrozen = computeGainLossBackfill([
    bfRow({
      transactionId: "sellFrozen",
      transactionDate: "2026-02-05",
      symbol: "AAA",
      quantity: "5",
      grossAmount: "300",
      fees: "10",
    }),
    bfRow({
      transactionId: "buyLate",
      transactionDate: "2026-01-20",
      symbol: "AAA",
      side: "BUY",
      quantity: "10",
      unitPrice: "20",
      grossAmount: "200",
      fees: "1",
      netAmount: "199",
    }),
  ]);
  ok(bfFrozen.stats.filled === 1, "backfill fills ONE frozen SELL (BUY was imported later)");
  const aaa = bfFrozen.updates.find((u) => u.transactionId === "sellFrozen");
  ok(
    aaa?.update.costBasis === "100.00" && aaa?.update.proceeds === "290.00",
    "backfill cost basis = avg 20 * 5 = 100; proceeds reconstructed from gross 300 - fees 10 (no stored net)"
  );
  ok(
    aaa?.update.realizedGainLoss === "190.00",
    "backfill realized gain = net 290 - basis 100 = 190"
  );
  ok(
    aaa?.update.realizedGainLossThb === "6729.80",
    "backfill THB gain = 190 * stored fx_rate_effective 35.42 (never an invented rate)"
  );

  const bfStoredNet = computeGainLossBackfill([
    bfRow({
      transactionId: "s1",
      symbol: "BBB",
      quantity: "2",
      grossAmount: "100",
      fees: "1",
      netAmount: "98.5",
    }),
    bfRow({
      transactionId: "b1",
      symbol: "BBB",
      side: "BUY",
      transactionDate: "2026-01-01",
      quantity: "2",
      unitPrice: "40",
    }),
  ]);
  ok(
    bfStoredNet.updates[0].update.proceeds === "98.50",
    "backfill prefers the stored authoritative net_amount over gross - fees"
  );

  const bfAlready = computeGainLossBackfill([
    bfRow({
      transactionId: "sDone",
      symbol: "CCC",
      quantity: "1",
      realizedGainLossThb: "123.45",
    }),
    bfRow({
      transactionId: "bDone",
      symbol: "CCC",
      side: "BUY",
      transactionDate: "2026-01-01",
      quantity: "1",
      unitPrice: "10",
    }),
  ]);
  ok(
    bfAlready.stats.skippedAlready === 1 && bfAlready.stats.filled === 0,
    "backfill NEVER overwrites an already-computed SELL (skippedAlready)"
  );

  const bfManual = computeGainLossBackfill([
    bfRow({
      transactionId: "sManual",
      symbol: "DDD",
      quantity: "1",
      sourceType: "MANUAL",
    }),
    bfRow({
      transactionId: "bManual",
      symbol: "DDD",
      side: "BUY",
      transactionDate: "2026-01-01",
      quantity: "1",
      unitPrice: "10",
    }),
  ]);
  ok(
    bfManual.stats.skippedManual === 1 && bfManual.stats.filled === 0,
    "backfill NEVER touches MANUAL rows, even with sufficient basis"
  );

  const bfNoBasis = computeGainLossBackfill([
    bfRow({ transactionId: "sNoBasis", symbol: "EEE", quantity: "15" }),
    bfRow({
      transactionId: "bShort",
      symbol: "EEE",
      side: "BUY",
      transactionDate: "2026-01-01",
      quantity: "10",
      unitPrice: "10",
    }),
  ]);
  ok(
    bfNoBasis.stats.stillNonComputable === 1 && bfNoBasis.stats.filled === 0,
    "backfill stays honest when qty sold exceeds the available basis (no invented gain)"
  );

  const bfNoFx = computeGainLossBackfill([
    bfRow({ transactionId: "sNoFx", symbol: "FFF", quantity: "1", fxRateEffective: null }),
    bfRow({
      transactionId: "bNoFx",
      symbol: "FFF",
      side: "BUY",
      transactionDate: "2026-01-01",
      quantity: "1",
      unitPrice: "10",
    }),
  ]);
  ok(
    bfNoFx.stats.stillNonComputable === 1 && bfNoFx.stats.filled === 0,
    "backfill never invents an FX rate — a non-THB SELL with a NULL effective rate stays non-computable"
  );

  const bfThb = computeGainLossBackfill([
    bfRow({
      transactionId: "sThb",
      symbol: "GGG",
      quantity: "1",
      currency: "THB",
      fxRateEffective: null,
      grossAmount: "100",
      fees: "0",
    }),
    bfRow({
      transactionId: "bThb",
      symbol: "GGG",
      side: "BUY",
      transactionDate: "2026-01-01",
      quantity: "1",
      unitPrice: "80",
    }),
  ]);
  ok(
    bfThb.stats.filled === 1 && bfThb.updates[0].update.realizedGainLossThb === "20.00",
    "THB SELL pins the rate to 1, so backfill computes gain 100 - 80 = 20 THB even with no stored rate"
  );

  // INTENTIONAL 2-stage rounding (locked, not a bug): the stored gain is
  // rounded first, then gainThb is derived from that ROUNDED gain.
  const bfPenny = computeGainLossBackfill([
    bfRow({
      transactionId: "sPenny",
      symbol: "PPP",
      quantity: "1",
      grossAmount: "110.005",
      fees: "0",
    }),
    bfRow({
      transactionId: "bPenny",
      symbol: "PPP",
      side: "BUY",
      transactionDate: "2026-01-01",
      quantity: "1",
      unitPrice: "100",
    }),
  ]);
  const penny = bfPenny.updates.find((u) => u.transactionId === "sPenny");
  ok(
    penny?.update.realizedGainLoss === "10.01",
    "stage 1: raw gain 10.005 rounds half-up to stored 10.01"
  );
  ok(
    penny?.update.realizedGainLossThb === "354.55",
    "stage 2: THB gain from the ROUNDED gain (10.01 x 35.42 = 354.55), not the raw gain (would be 354.38)"
  );

  const bfPennyThb = computeGainLossBackfill([
    bfRow({
      transactionId: "sPennyThb",
      symbol: "QQQ",
      quantity: "1",
      currency: "THB",
      fxRateEffective: null,
      grossAmount: "110.005",
      fees: "0",
    }),
    bfRow({
      transactionId: "bPennyThb",
      symbol: "QQQ",
      side: "BUY",
      transactionDate: "2026-01-01",
      quantity: "1",
      unitPrice: "100",
    }),
  ]);
  const pennyThb = bfPennyThb.updates.find((u) => u.transactionId === "sPennyThb");
  ok(
    pennyThb?.update.realizedGainLoss === "10.01" && pennyThb?.update.realizedGainLossThb === "10.01",
    "THB rows pin fx to 1, so gain and gainThb agree after the same single rounding"
  );

  // A stored FX rate must be authoritative even when a BUY for another symbol
  // interleaves chronologically (state is per-symbol, not global).
  const bfInterleaved = computeGainLossBackfill([
    bfRow({
      transactionId: "sH1",
      symbol: "HHH",
      quantity: "1",
      transactionDate: "2026-02-05",
      grossAmount: "100",
      fees: "0",
    }),
    bfRow({
      transactionId: "bH1",
      symbol: "HHH",
      side: "BUY",
      transactionDate: "2026-01-05",
      quantity: "1",
      unitPrice: "40",
    }),
    bfRow({
      transactionId: "sH2",
      symbol: "III",
      quantity: "1",
      transactionDate: "2026-02-06",
      grossAmount: "50",
      fees: "0",
    }),
  ]);
  ok(
    bfInterleaved.stats.filled === 1 &&
      bfInterleaved.updates[0].transactionId === "sH1" &&
      bfInterleaved.stats.stillNonComputable === 1,
    "backfill state is per-symbol: HHH fills, III (no BUY) stays non-computable"
  );

  // ---- Webull Average Cost: SELL does not change the divisor (avg) ----
  // buy 1000@300, sell 500, buy 200@350:
  //   old running avg = 314.29 (partial-sell math lowers the remaining avg);
  //   Webull avg = (300000 + 70000) / 1200 = 308.33 (fees excluded, avg kept).
  const webullReplay = recomputeCostBasisMap([
    { symbol: "WBL", transactionDate: "2026-01-02", side: "BUY", quantity: "1000", unitPrice: "300.00" },
    { symbol: "WBL", transactionDate: "2026-01-05", side: "SELL", quantity: "500", unitPrice: "330.00" },
    { symbol: "WBL", transactionDate: "2026-02-02", side: "BUY", quantity: "200", unitPrice: "350.00" },
  ]);
  ok(
    webullReplay.WBL?.quantity === 700 &&
      Math.abs((webullReplay.WBL?.avgCost ?? NaN) - 308.333333333) < 1e-6,
    "Webull avg = cumulative cost / cumulative BUY qty = 308.33 (not the old 314.29 running avg)"
  );
  const webullDivergence = computeGainLossBackfill([
    bfRow({
      transactionId: "sWbl",
      symbol: "WBL2",
      quantity: "500",
      transactionDate: "2026-02-10",
      grossAmount: "165000",
      fees: "0",
    }),
    bfRow({
      transactionId: "bWbl1",
      symbol: "WBL2",
      side: "BUY",
      transactionDate: "2026-01-02",
      quantity: "1000",
      unitPrice: "300",
    }),
    bfRow({
      transactionId: "bWbl2",
      symbol: "WBL2",
      side: "BUY",
      transactionDate: "2026-02-02",
      quantity: "200",
      unitPrice: "350",
    }),
  ]);
  ok(
    webullDivergence.updates[0].update.costBasis === "154166.67",
    "Webull SELL basis = 308.3333... * 500 = 154166.67 (lifetime avg, not 157142.86)"
  );

  const wblFullLiquidation = recomputeCostBasisMap([
    { symbol: "WLQ", transactionDate: "2026-01-02", side: "BUY", quantity: "100", unitPrice: "10.00" },
    { symbol: "WLQ", transactionDate: "2026-02-01", side: "BUY", quantity: "100", unitPrice: "12.00" },
    { symbol: "WLQ", transactionDate: "2026-03-01", side: "SELL", quantity: "200", unitPrice: "15.00" },
    { symbol: "WLQ", transactionDate: "2026-03-10", side: "BUY", quantity: "50", unitPrice: "9.00" },
  ]);
  ok(
    wblFullLiquidation.WLQ?.quantity === 50 &&
      Math.abs((wblFullLiquidation.WLQ?.avgCost ?? NaN) - 9) < 1e-9,
    "Webull full liquidation resets the position: next BUY 50@9 restarts avg at 9 (not blended with 11)"
  );

  // ---- Full recompute (one-shot Webull migration): overwrites AI_PARSED ----
  const rc = recomputeAllGainLoss([
    bfRow({
      transactionId: "b1",
      symbol: "RCM",
      side: "BUY",
      transactionDate: "2026-01-01",
      quantity: "100",
      unitPrice: "10",
    }),
    bfRow({
      transactionId: "b2",
      symbol: "RCM",
      side: "BUY",
      transactionDate: "2026-02-01",
      quantity: "100",
      unitPrice: "20",
    }),
    bfRow({
      transactionId: "sOldMethod",
      symbol: "RCM",
      quantity: "100",
      transactionDate: "2026-03-01",
      grossAmount: "3000",
      fees: "0",
      realizedGainLossThb: "123.45", // old-method value — must be OVERWRITTEN
    }),
    bfRow({
      transactionId: "sManual",
      symbol: "RCM",
      quantity: "10",
      transactionDate: "2026-03-02",
      sourceType: "MANUAL",
      grossAmount: "500",
      fees: "0",
    }),
  ]);
  ok(
    rc.stats.recomputed === 1 &&
      rc.stats.skippedManual === 1 &&
      rc.stats.stillNonComputable === 0,
    "full recompute rewrites EVERY AI_PARSED SELL (even already-computed) and still skips MANUAL"
  );
  ok(
    rc.updates[0].update.costBasis === "1500.00" &&
      rc.updates[0].update.realizedGainLoss === "1500.00",
    "full recompute uses the Webull lifetime avg 15 (was 10 before the 2nd BUY): basis 1500, gain 1500"
  );

  // ---- SPIN_OFF FMV allocation: parent cumCost split pro-rata by total FMV ----
  // Parent holds 100 @ 50 (cumCost 5000); spin-off 10 child shares, FMV 90/10:
  //   parentTotal = 90*100 = 9000, childTotal = 10*10 = 100
  //   toChild = 5000 * 100/9100 = 54.94505495; parent keeps 4945.05494505.
  const spinParent: CostBasisMap = {
    MOM: { quantity: 100, avgCost: 50, cumQuantity: 100, cumCost: 5000 },
  };
  const spinFmv = applyCorporateAction(spinParent, {
    symbol: "MOM",
    actionType: "SPIN_OFF",
    transactionDate: "2026-03-01",
    sharesOut: "10",
    priceOut: "10",
    newSymbol: "KID",
    parentFmvPerShare: "90",
    childFmvPerShare: "10",
  });
  ok(
    spinFmv.MOM !== undefined && spinFmv.KID !== undefined,
    "FMV spin-off keeps the parent and creates the child position"
  );
  const momCost = spinFmv.MOM?.cumCost ?? 0;
  const kidCost = spinFmv.KID?.cumCost ?? 0;
  ok(
    Math.abs(momCost + kidCost - 5000) < 1e-6,
    "FMV spin-off preserves total cost across parent + child (5000)"
  );
  ok(
    Math.abs(kidCost - 54.94505495) < 1e-4 && spinFmv.KID?.quantity === 10,
    "child receives the FMV pro-rata share (54.95) with the spun shares"
  );
  ok(
    spinFmv.MOM?.quantity === 100 && Math.abs((spinFmv.MOM?.avgCost ?? 0) - 49.45054945) < 1e-4,
    "parent quantity unchanged, unit cost drops to 49.45"
  );

  // Legacy spin-off (no FMV pair): old valuation kept, parent untouched.
  const spinLegacy = applyCorporateAction(spinParent, {
    symbol: "MOM",
    actionType: "SPIN_OFF",
    transactionDate: "2026-03-01",
    sharesOut: "10",
    priceOut: "10",
    newSymbol: "KID2",
  });
  ok(
    spinLegacy.MOM?.cumCost === 5000 && spinLegacy.KID2?.cumCost === 100,
    "legacy spin-off without FMV keeps the old behaviour (child at priceOut, parent untouched)"
  );

  // One-sided FMV is rejected, never guessed.
  let fmvThrow = "";
  try {
    applyCorporateAction(spinParent, {
      symbol: "MOM",
      actionType: "SPIN_OFF",
      transactionDate: "2026-03-01",
      sharesOut: "10",
      priceOut: "10",
      parentFmvPerShare: "90",
    });
  } catch (e) {
    fmvThrow = e instanceof Error ? e.message : String(e);
  }
  ok(fmvThrow.includes("both-or-neither"), "one-sided FMV spin-off throws (both-or-neither)");

  console.log(`\n================ SUMMARY ================`);
  console.log(`PASS: ${passed}   FAIL: ${failed}`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

void main();