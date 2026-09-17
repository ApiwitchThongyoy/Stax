// Trading-journal pure engine unit tests (DB-free).
//
// Covers the pure, injectable core of the trading-journal feature:
//   - classifyJournalSide: BUY/SELL pass through; DIVIDEND for income rows
//     whose section is เงินปันผล:*; everything else (interest, capital-gain
//     summary lines, FX transfers, fees, deposits) is OTHER — never a
//     displayed journal kind.
//   - dividendSymbolFor: dividend ticker derived from the section label when
//     the symbol column is empty; unknown-marker sections stay null.
//   - buildTradingJournalEntries: chronological Webull average-cost replay —
//     first BUY reports null, later BUYs report the pre-trade average, SELLs
//     report the unchanged average they settle against; dividend rows pass
//     through with null; fees keep their absolute value.
//   - isTradeJournalRow: the journal read filter — stock trades ONLY
//     (BUY/SELL + dividend income rows, matched on section). Interest, gain
//     lines, expense, equity and FX rows are all excluded.
//   - buildBehaviorStats: wins/losses from computable SELLs only, best/worst
//     refs, quantity-weighted vintage holding period, null-safe edges.
//
// No network and no database are touched (the DB path lives in the
// TEST_DATABASE_URL-gated harness, scripts/run-tests.mts).
//
// Run:  npx tsx scripts/test-trading-journal.mts
import {
  buildBehaviorStats,
  buildTradingJournalEntries,
  classifyJournalSide,
  dividendSymbolFor,
  isTradeJournalRow,
} from "../app/lib/trading-journal-engine";
import type { CapitalJournalRecord } from "../app/lib/journal-ledger-read";

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

function journalRow(partial: Partial<CapitalJournalRecord>): CapitalJournalRecord {
  return {
    sourceTransactionId: "tx-1",
    userId: "user-1",
    entryDate: "2026-01-15",
    sourceType: "STATEMENT",
    sourceDocumentId: "doc-1",
    category: "asset",
    section: "ซื้อหุ้น",
    symbol: "NVDA",
    side: "BUY",
    exchange: "NASDAQ",
    quantity: "10",
    unitPrice: "150.00",
    grossAmount: "1500.00",
    fees: "-1.00",
    netAmount: "1499.00",
    proceeds: null,
    costBasis: null,
    realizedGainLoss: null,
    realizedGainLossThb: null,
    currency: "USD",
    amount: "1500.00",
    amountThb: "47355.00",
    fxRateEffective: "31.57",
    fxRateStatement: "31.57",
    isFxConversion: false,
    exchangeFromCurrency: null,
    exchangeFromAmount: null,
    exchangeRate: null,
    isMonthlyFeeAggregate: false,
    postingState: "POSTED",
    skipReason: null,
    type: null,
    note: null,
    ...partial,
  };
}

async function main() {
  // --- classifyJournalSide: exactly 3 displayed kinds ---
  ok(classifyJournalSide("BUY", "asset", "ซื้อหุ้น") === "BUY", "BUY passes through");
  ok(classifyJournalSide("SELL", "asset", "ขายหุ้น") === "SELL", "SELL passes through");
  ok(
    classifyJournalSide(null, "income", "เงินปันผล:nvda") === "DIVIDEND",
    "income + เงินปันผล:* section -> DIVIDEND"
  );
  ok(
    classifyJournalSide(null, "income", "ดอกเบี้ย") === "OTHER",
    "ดอกเบี้ย is NOT a journal kind (OTHER, filtered out)"
  );
  ok(
    classifyJournalSide(null, "income", "กำไรจากการขายหุ้น") === "OTHER",
    "กำไรจากการขายหุ้น is NOT a journal kind (OTHER, filtered out)"
  );
  ok(classifyJournalSide(null, "income", "อื่น") === "OTHER", "unknown income section -> OTHER");
  ok(classifyJournalSide(null, "equity", "ฝากเงิน") === "OTHER", "equity deposit -> OTHER");
  ok(classifyJournalSide(null, "expense", "ค่าธรรมเนียม") === "OTHER", "expense rows -> OTHER");
  ok(classifyJournalSide(null, null, null) === "OTHER", "null triple -> OTHER");
  ok(
    classifyJournalSide(null, "asset", "แลกเปลี่ยนสกุลเงิน") === "OTHER",
    "FX transfers are NOT a journal kind (OTHER, filtered out)"
  );

  // --- dividendSymbolFor ---
  ok(dividendSymbolFor(null, "เงินปันผล:goog") === "GOOG", "dividend ticker from section label");
  ok(dividendSymbolFor("NVDA", "เงินปันผล:nvda") === "NVDA", "explicit symbol column wins");
  ok(
    dividendSymbolFor(null, "เงินปันผล:ไม่ทราบสัญลักษณ์") === null,
    "unknown-marker dividend section stays null"
  );
  ok(dividendSymbolFor(null, null) === null, "no symbol and no section -> null");

  // --- buildTradingJournalEntries: replay ---
  const rows: CapitalJournalRecord[] = [
    journalRow({ sourceTransactionId: "b1", entryDate: "2026-01-10", side: "BUY", symbol: "NVDA", quantity: "1000", unitPrice: "300.00" }),
    journalRow({ sourceTransactionId: "s1", entryDate: "2026-01-15", side: "SELL", symbol: "NVDA", quantity: "500", unitPrice: "320.00" }),
    journalRow({ sourceTransactionId: "b2", entryDate: "2026-01-20", side: "BUY", symbol: "NVDA", quantity: "200", unitPrice: "350.00" }),
    journalRow({
      sourceTransactionId: "d1",
      entryDate: "2026-01-25",
      side: null,
      symbol: null,
      category: "income",
      section: "เงินปันผล:nvda",
      quantity: null,
      unitPrice: null,
      grossAmount: null,
      amount: "50.00",
    }),
  ];
  const entries = buildTradingJournalEntries(rows);
  ok(entries.length === 4, "all rows pass through");
  ok(entries[0].avgCostAtTime === null, "first BUY establishes the position (null basis)");
  ok(
    entries[1].avgCostAtTime !== null && Math.abs(entries[1].avgCostAtTime - 300) < 1e-9,
    "SELL reports the unchanged pre-sale average (300)"
  );
  ok(
    entries[2].avgCostAtTime !== null && Math.abs(entries[2].avgCostAtTime - 300) < 1e-9,
    "second BUY reports the pre-trade average (300, Webull: SELL never moves it)"
  );
  ok(entries[3].side === "DIVIDEND", "dividend row classified DIVIDEND");
  ok(entries[3].symbol === "NVDA", "dividend symbol derived from section");
  ok(entries[3].avgCostAtTime === null, "income rows carry no average-cost snapshot");
  ok(entries[0].fees === "1", "fees keep their absolute value");

  // --- multi-symbol interleave stays per-symbol ---
  const inter: CapitalJournalRecord[] = [
    journalRow({ sourceTransactionId: "a1", entryDate: "2026-01-01", symbol: "AAA", quantity: "10", unitPrice: "100.00" }),
    journalRow({ sourceTransactionId: "b1", entryDate: "2026-01-02", symbol: "BBB", quantity: "5", unitPrice: "50.00" }),
    journalRow({ sourceTransactionId: "a2", entryDate: "2026-01-03", side: "SELL", symbol: "AAA", quantity: "3", unitPrice: "120.00" }),
  ];
  const ie = buildTradingJournalEntries(inter);
  ok(
    ie[2].avgCostAtTime !== null && Math.abs(ie[2].avgCostAtTime - 100) < 1e-9,
    "AAA SELL uses AAA's own average despite the BBB interleave"
  );

  // --- WHY the route replays the full lifetime before filtering ---
  // Building over a date-truncated window drifts the snapshots: the windowed
  // first BUY reports null while the full history knows 200, and the SELL
  // settles at 300 instead of the true lifetime (100*200+100*300)/200 = 250.
  const fullHist = buildTradingJournalEntries([
    journalRow({ sourceTransactionId: "b0", entryDate: "2025-12-01", side: "BUY", symbol: "NVDA", quantity: "100", unitPrice: "200.00" }),
    journalRow({ sourceTransactionId: "b1", entryDate: "2026-01-10", side: "BUY", symbol: "NVDA", quantity: "100", unitPrice: "300.00" }),
    journalRow({ sourceTransactionId: "s1", entryDate: "2026-01-15", side: "SELL", symbol: "NVDA", quantity: "50", unitPrice: "320.00" }),
  ]);
  const windowed = buildTradingJournalEntries([
    journalRow({ sourceTransactionId: "b1", entryDate: "2026-01-10", side: "BUY", symbol: "NVDA", quantity: "100", unitPrice: "300.00" }),
    journalRow({ sourceTransactionId: "s1", entryDate: "2026-01-15", side: "SELL", symbol: "NVDA", quantity: "50", unitPrice: "320.00" }),
  ]);
  ok(
    windowed[0].avgCostAtTime === null &&
      fullHist[1].avgCostAtTime !== null &&
      Math.abs(fullHist[1].avgCostAtTime - 200) < 1e-9,
    "windowed first BUY reports null while the full history keeps the 200 average"
  );
  ok(
    windowed[1].avgCostAtTime !== null &&
      Math.abs(windowed[1].avgCostAtTime - 300) < 1e-9 &&
      fullHist[2].avgCostAtTime !== null &&
      Math.abs(fullHist[2].avgCostAtTime - 250) < 1e-9,
    "windowed SELL settles at 300 instead of the true lifetime 250 — date filters must not truncate the replay"
  );

  // --- isTradeJournalRow: stock trades + dividends only ---
  ok(isTradeJournalRow("BUY", "asset", "ซื้อหุ้น"), "BUY is a trade-journal row");
  ok(isTradeJournalRow("SELL", "asset", "ขายหุ้น"), "SELL is a trade-journal row");
  ok(
    isTradeJournalRow(null, "income", "เงินปันผล:nvda"),
    "dividend income rows are included"
  );
  ok(
    !isTradeJournalRow(null, "income", "ดอกเบี้ย"),
    "interest rows are excluded"
  );
  ok(
    !isTradeJournalRow(null, "income", "กำไรจากการขายหุ้น"),
    "capital-gain summary lines are excluded"
  );
  ok(!isTradeJournalRow(null, "expense", "ค่าธรรมเนียม"), "expense rows are excluded");
  ok(!isTradeJournalRow(null, "equity", "ฝากเงิน"), "equity (deposits) excluded");
  ok(
    !isTradeJournalRow(null, "asset", "แลกเปลี่ยนสกุลเงิน"),
    "FX transfers are excluded"
  );

  // --- only the 3 displayed kinds flow through the builder ---

  // --- note passthrough ---
  const noted = buildTradingJournalEntries([
    journalRow({ sourceTransactionId: "n1", note: "เหตุผลที่ซื้อ" }),
  ]);
  ok(noted[0].note === "เหตุผลที่ซื้อ", "investor note passes through verbatim");
  ok(entries[0].note === null, "rows without a note carry null");

  // --- buildBehaviorStats: wins/losses/best/worst/holding period ---
  const stats = buildBehaviorStats([
    journalRow({
      sourceTransactionId: "b1",
      entryDate: "2026-01-10",
      side: "BUY",
      symbol: "NVDA",
      quantity: "1000",
      unitPrice: "300.00",
    }),
    journalRow({
      sourceTransactionId: "s1",
      entryDate: "2026-01-15",
      side: "SELL",
      symbol: "NVDA",
      quantity: "500",
      unitPrice: "320.00",
      realizedGainLossThb: "10000.00",
    }),
    journalRow({
      sourceTransactionId: "s2",
      entryDate: "2026-01-20",
      side: "SELL",
      symbol: "NVDA",
      quantity: "200",
      unitPrice: "290.00",
      realizedGainLossThb: "-4000.00",
    }),
    journalRow({
      sourceTransactionId: "s3",
      entryDate: "2026-01-25",
      side: "SELL",
      symbol: "NVDA",
      quantity: "100",
      unitPrice: "310.00",
      realizedGainLossThb: null,
    }),
  ]);
  ok(stats.computableSellCount === 2, "only computable SELLs count (null basis skipped)");
  ok(stats.winningSellCount === 1 && stats.losingSellCount === 1, "win/loss split");
  ok(stats.winRate !== null && Math.abs(stats.winRate - 0.5) < 1e-9, "win rate 1/2");
  ok(
    stats.profitFactor !== null && Math.abs(stats.profitFactor - 2.5) < 1e-9,
    "profit factor 10000/4000"
  );
  ok(
    stats.bestTrade !== null &&
      stats.bestTrade.symbol === "NVDA" &&
      stats.bestTrade.realizedGainLossThb === "10000.00",
    "best trade is the +10000 SELL"
  );
  ok(
    stats.worstTrade !== null &&
      stats.worstTrade.realizedGainLossThb === "-4000.00",
    "worst trade is the -4000 SELL"
  );
  ok(
    stats.avgHoldingDays !== null && Math.abs(stats.avgHoldingDays - 7.5) < 1e-9,
    "avg holding days (5 + 10) / 2 — vintage never moves on SELL"
  );

  // --- buildBehaviorStats: empty + gains-only edges ---
  const empty = buildBehaviorStats([]);
  ok(
    empty.computableSellCount === 0 &&
      empty.winRate === null &&
      empty.profitFactor === null &&
      empty.bestTrade === null &&
      empty.worstTrade === null &&
      empty.avgHoldingDays === null,
    "empty input yields zero counts and null stats"
  );
  const gainsOnly = buildBehaviorStats([
    journalRow({
      sourceTransactionId: "b1",
      entryDate: "2026-01-10",
      side: "BUY",
      symbol: "AAA",
      quantity: "10",
      unitPrice: "100.00",
    }),
    journalRow({
      sourceTransactionId: "s1",
      entryDate: "2026-01-11",
      side: "SELL",
      symbol: "AAA",
      quantity: "10",
      unitPrice: "120.00",
      realizedGainLossThb: "500.00",
    }),
  ]);
  ok(
    gainsOnly.winRate === 1 && gainsOnly.profitFactor === null,
    "gains with no losses: win rate 1, profit factor null (no divisor)"
  );
  ok(
    gainsOnly.avgHoldingDays !== null &&
      Math.abs(gainsOnly.avgHoldingDays - 1) < 1e-9,
    "single-day hold measures 1 day"
  );

  console.log(`\n================ SUMMARY ================`);
  console.log(`PASS: ${passed}   FAIL: ${failed}`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Trading-journal test suite crashed:", e);
  process.exit(1);
});
