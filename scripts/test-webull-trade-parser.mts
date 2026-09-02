// Real Webull statement trade-parsing regression tests (pure, DB-free).
//
// Covers the real stored statement layout discovered from
// storage/statements/.../49af10b3.../7c1a5786....pdf (74KB):
//   - the ticker sits on its OWN line, immediately BEFORE the trade row:
//       GOOG
//       30/01/2026 22:32:38,GMT+07 30/01/2026 BUY 15 198.25 2973.75 2973.75 0 0 NASDAQ
//   - the trade row starts directly with the date (no inline symbol/name)
//   - legacy inline "SYMBOL NAME dd/mm/yyyy ... BUY ..." still parses
//   - fees are SIGNED (negative = rebate), never Math.abs()'d
//   - `net` is the statement's authoritative value (fees already applied)
//   - cost basis runs chronologically: BUY averages, SELL consumes
//   - insufficient/unknown basis SELL => explicitly non-computable (no fake 0)
//   - unrelated bare-ticker lines never leak into a later trade row
//
//   npx tsx scripts/test-webull-trade-parser.mts
import "./_load-env.mjs";

import { parseStatementRows } from "../app/lib/pdfStatementParser";
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

function approx(a: number | undefined, b: number, tol = 0.001): boolean {
  return a !== undefined && Math.abs(a - b) < tol;
}

function parse(lines: string[]) {
  return parseStatementRows(lines, {});
}

function trade(txs: ExtractedTransaction[], side: "BUY" | "SELL", symbol?: string, unitPrice?: number) {
  return txs.find(
    (t) =>
      t.side === side &&
      (symbol === undefined || t.symbol === symbol) &&
      (unitPrice === undefined || t.unitPrice === unitPrice) &&
      t.section === (side === "BUY" ? "ซื้อหุ้น" : "ขายหุ้น")
  );
}

function gainRow(txs: ExtractedTransaction[], symbol: string) {
  return txs.find(
    (t) => t.section === "กำไรจากการขายหุ้น" && t.subLabel?.includes(symbol)
  );
}

function assertNoRealizedFields(t: ExtractedTransaction | undefined, label: string) {
  ok(t !== undefined, `${label}: SELL row exists`);
  if (!t) return;
  ok(t.realizedGainLoss === undefined, `${label}: realizedGainLoss is ABSENT (not 0)`);
  ok(t.proceeds === undefined && t.costBasis === undefined,
    `${label}: proceeds/costBasis are ABSENT too (non-computable)`);
}

function main() {
  console.log("\n=== REAL WEBULL TRADE PARSER (symbol-on-own-line) ===\n");

  // ---- 1. Real layout: BUY establishes running average, SELL consumes it ----
  const f1 = parse([
    "TRADE RECORDS",
    "Currency: USD",
    "USD/THB = 35.42",
    "VRMAX",
    "02/01/2026 10:00:00,GMT+07 02/01/2026 BUY 100 10.00 1000.00 1000.00 1.00 0.07 NASDAQ",
    "VRMAX",
    "03/01/2026 10:00:00,GMT+07 03/01/2026 BUY 100 20.00 2000.00 2000.00 1.50 0.10 NYSE",
    "VRMAX",
    "04/01/2026 10:00:00,GMT+07 04/01/2026 SELL 50 30.00 1500.00 1497.93 1.00 0.07 NASDAQ",
    "PORTFOLIO SUMMARY",
  ]);
  ok(f1.transactions.length >= 5, "f1: BUY+B+SELL generates rows");
  const f1Buy1 = trade(f1.transactions, "BUY", "VRMAX", 10);
  ok(
    f1Buy1 !== undefined &&
      f1Buy1.quantity === 100 &&
      f1Buy1.unitPrice === 10 &&
      f1Buy1.grossAmount === 1000 &&
      f1Buy1.netAmount === 1000,
    "f1: real-layout BUY parsed (qty/price/gross/net)"
  );
  ok(f1Buy1 !== undefined && approx(f1Buy1.fees, 1.07),
    "f1: BUY fees = comm+vat (1.00 + 0.07)");
  ok(f1Buy1 !== undefined && f1Buy1.exchange === "NASDAQ",
    "f1: BUY exchange captured from the trailing token");
  ok(f1.transactions.filter((t) => t.section === "ซื้อหุ้น").length === 2,
    "f1: exactly 2 BUY rows (no fake duplicate from pendingSymbol bleed)");
  const f1Sell = trade(f1.transactions, "SELL", "VRMAX");
  ok(f1Sell !== undefined && f1Sell.quantity === 50 && f1Sell.unitPrice === 30,
    "f1: SELL qty/price parsed");
  ok(f1Sell !== undefined && f1Sell.netAmount === 1497.93 && f1Sell.grossAmount === 1500,
    "f1: SELL net is the authoritative statement value (not recomputed)");
  ok(f1Sell !== undefined && approx(f1Sell.proceeds ?? NaN, 1497.93),
    "f1: proceeds = statement net (fees already baked in)");
  ok(f1Sell !== undefined && approx(f1Sell.costBasis ?? NaN, 750),
    "f1: costBasis = running avg (15) * qty (50) = 750");
  ok(f1Sell !== undefined && approx(f1Sell.realizedGainLoss ?? NaN, 747.93),
    "f1: realizedGainLoss = net - costBasis = 747.93 (computable)");
  ok(f1Sell !== undefined && f1Sell.rate === "35.42",
    "f1: SELL rate uses the statement FX header (USD/THB = 35.42)");
  ok(approx(f1.updatedCostBasis.VRMAX?.quantity ?? NaN, 150),
    "f1: cost basis quantity after SELL = 150 (200 - 50)");
  ok(approx(f1.updatedCostBasis.VRMAX?.avgCost ?? NaN, 15),
    "f1: cost basis avgCost unchanged by SELL (15)");
  const f1Gain = gainRow(f1.transactions, "VRMAX");
  ok(f1Gain !== undefined && approx(f1Gain.pnlAmount ?? NaN, 747.93) && f1Gain.included === true,
    "f1: computable SELL also emits a REAL income gain row (included)");

  // ---- 2. Signed fees: negative commission = rebate, net used verbatim ----
  const f2 = parse([
    "TRADE RECORDS",
    "Currency: USD",
    "UUUU",
    "05/01/2026 11:00:00,GMT+07 05/01/2026 SELL 2 22.77 45.54 45.48 -0.06 0.00 AMEX",
    "PORTFOLIO SUMMARY",
    "UUUU",
    "200 1 21.03 4206.00 22.77 348.00 USD AMEX",
  ]);
  const f2Sell = trade(f2.transactions, "SELL", "UUUU");
  ok(f2Sell !== undefined && approx(f2Sell.fees ?? NaN, -0.06),
    "f2: negative fee is kept negative (rebate, NOT Math.abs'd)");
  ok(f2Sell !== undefined && f2Sell.netAmount === 45.48,
    "f2: broker net 45.48 used verbatim even though Gross-Comm = 45.60");
  ok(f2Sell !== undefined && approx(f2Sell.realizedGainLoss ?? NaN, 3.42),
    "f2: realized = 45.48 - (21.03 * 2) = 3.42 (portfolio-summary seed)");
  ok(f2Sell !== undefined && f2Sell.exchange === "AMEX",
    "f2: exchange AMEX carried");

  // ---- 3. Insufficient held quantity => non-computable (NO fake 0) ----
  const f3 = parse([
    "TRADE RECORDS",
    "Currency: USD",
    "ABCH",
    "02/01/2026 10:00:00,GMT+07 02/01/2026 BUY 10 5.00 50.00 50.00 0.00 0.00 NASDAQ",
    "ABCH",
    "03/01/2026 10:00:00,GMT+07 03/01/2026 SELL 15 6.00 90.00 90.00 0.00 0.00 NASDAQ",
    "PORTFOLIO SUMMARY",
  ]);
  const f3Sell = trade(f3.transactions, "SELL", "ABCH");
  assertNoRealizedFields(f3Sell, "f3");
  ok(f3Sell !== undefined && f3Sell.netAmount === 90,
    "f3: even non-computable SELL keeps its authoritative netAmount");
  const f3Gain = gainRow(f3.transactions, "ABCH");
  ok(f3Gain !== undefined && f3Gain.included === false && f3Gain.pnlAmount === 0,
    "f3: non-computable SELL income row is NOT included and carries 0");

  // ---- 4. No known basis at all => non-computable (no fake 0) ----
  const f4 = parse([
    "TRADE RECORDS",
    "Currency: USD",
    "MYST",
    "03/01/2026 10:00:00,GMT+07 03/01/2026 SELL 5 10.00 50.00 50.00 0.00 0.00 NASDAQ",
    "PORTFOLIO SUMMARY",
  ]);
  assertNoRealizedFields(trade(f4.transactions, "SELL", "MYST"), "f4");

  // ---- 5. Legacy inline "SYMBOL NAME date ... BUY ..." still works ----
  const f5 = parse([
    "TRADE RECORDS",
    "Currency: USD",
    "AAPL APPLE INC 05/01/2026 09:30:00,GMT+07 05/01/2026 BUY 10 200.00 2000.00 2000.00 0.00 0.00 NASDAQ",
    "PORTFOLIO SUMMARY",
  ]);
  const f5Buy = trade(f5.transactions, "BUY", "AAPL");
  ok(f5Buy !== undefined && f5Buy.quantity === 10 && f5Buy.unitPrice === 200,
    "f5: legacy inline-prefix BUY still parses with symbol AAPL");

  // ---- 6. Unrelated bare ticker line never leaks into the next trade row ----
  const f6 = parse([
    "TRADE RECORDS",
    "Currency: USD",
    "BRKS",
    "This is a company name line, not a ticker",
    "05/01/2026 09:30:00,GMT+07 05/01/2026 BUY 10 200.00 2000.00 2000.00 0.00 0.00 NASDAQ",
    "PORTFOLIO SUMMARY",
  ]);
  const f6Buy = trade(f6.transactions, "BUY");
  ok(f6Buy !== undefined && f6Buy.symbol !== "BRKS",
    "f6: stray BRKS line (followed by a non-trade line) is NOT the BUY's symbol");

  // ---- 7. Chronological ordering: a later BUY must not change an earlier SELL ----
  const f7 = parse([
    "TRADE RECORDS",
    "Currency: USD",
    "ORDK",
    "04/01/2026 10:00:00,GMT+07 04/01/2026 SELL 5 10.00 50.00 50.00 0.00 0.00 NASDAQ",
    "ORDK",
    "02/01/2026 10:00:00,GMT+07 02/01/2026 BUY 10 5.00 50.00 50.00 0.00 0.00 NASDAQ",
    "PORTFOLIO SUMMARY",
  ]);
  const f7Sell = trade(f7.transactions, "SELL", "ORDK");
  ok(f7Sell !== undefined && approx(f7Sell.realizedGainLoss ?? NaN, 25),
    "f7: SELL is computed against the EARLIER BUY avg (50 - (5*5)) = 25");
  ok(approx(f7.updatedCostBasis.ORDK?.quantity ?? NaN, 5),
    "f7: remaining qty 5 (10 buy - 5 sell)");

  // ---- 8. Same-line real detail with fractional qty (GOOG-style) ----
  const f8 = parse([
    "TRADE RECORDS",
    "Currency: USD",
    "GOOG",
    "30/01/2026 22:32:38,GMT+07 30/01/2026 BUY 0.04436 338.11 15.00 15.00 0.00 0.00 NASDAQ",
    "PORTFOLIO SUMMARY",
  ]);
  const f8Buy = trade(f8.transactions, "BUY", "GOOG");
  ok(f8Buy !== undefined && approx(f8Buy.quantity ?? NaN, 0.04436) && approx(f8Buy.unitPrice ?? NaN, 338.11),
    "f8: fractional qty BUY parsed (GOOG 0.04436 @ 338.11)");
  ok(f8Buy !== undefined && approx(f8Buy.grossAmount ?? NaN, 0.04436 * 338.11, 0.01),
    "f8: grossAmount computed from qty*price (not text gross, which may round)");
  ok(f8Buy !== undefined && f8Buy.netAmount === 15,
    "f8: broker-rounded net 15 kept authoritative");

  console.log(`\n================ SUMMARY ================`);
  console.log(`PASS: ${passed}   FAIL: ${failed}`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main();