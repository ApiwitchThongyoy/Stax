// Cash in/out summary aggregator tests (DB-free).
//
// Covers the pure core of the cash summary feature:
//   - buildCashSummary groups equity money movements by month and totals the
//     cash entering/leaving the account.
//   - equity-only scope: a row is counted when it is category='equity' (AI
//     parsed deposits/withdrawals AND manual rows stamped after the POST fix)
//     OR sourceType='MANUAL' (legacy manual rows without a category stamp).
//   - only CASH_IN/CASH_OUT rows contribute; anything else is ignored (never
//     guessed, never included).
//   - safe with null/NaN amount values.
//
// No database is touched (the DB path lives in the TEST_DATABASE_URL-gated
// harness, scripts/run-tests.mts).
//
// Run:  npx tsx scripts/test-cash-summary.mts
import "./_load-env.mjs";

import {
  buildCashSummary,
  buildCashExchangeRows,
  buildExchangeDirectionTotals,
  type CashSummaryExchangeRow,
} from "../app/lib/cash-summary";

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

type FixtureRow = {
  transactionId: string;
  type: string;
  sourceType: string;
  category: string | null;
  transactionDate: string;
  amountThb: string | null;
  currency: string;
  amountForeign: string;
};

function cashRow(p: Partial<FixtureRow>): FixtureRow {
  return {
    transactionId: `tx-${Math.random().toString(16).slice(2)}`,
    type: "CASH_IN",
    sourceType: "MANUAL",
    category: "equity",
    transactionDate: "2026-01-30",
    amountThb: "5000.00",
    currency: "USD",
    amountForeign: "151.52",
    ...p,
  };
}

async function main() {
  console.log("\n=== CASH IN/OUT SUMMARY AGGREGATOR (equity-only) ===\n");

  // 1. Happy path: manual CASH_IN + CASH_OUT in the same month group, totals net out.
  const month = buildCashSummary([
    cashRow({ type: "CASH_IN", sourceType: "MANUAL", amountThb: "5000.00" }),
    cashRow({ type: "CASH_OUT", sourceType: "MANUAL", amountThb: "1750.00" }),
  ]);
  ok(
    month.months.length === 1 &&
      month.months[0].month === "2026-01" &&
      month.months[0].cashInThb === "5000" &&
      month.months[0].cashOutThb === "1750" &&
      month.months[0].netThb === "3250",
    "one month groups CASH_IN/CASH_OUT with net = in - out"
  );
  ok(
    month.totalCashInThb === "5000" &&
      month.totalCashOutThb === "1750" &&
      month.totalNetThb === "3250",
    "totals reflect the same month's cash in / out / net"
  );

  // 2. Months are sorted newest-first (server-authoritative display order).
  const sorted = buildCashSummary([
    cashRow({ transactionDate: "2025-12-05", amountThb: "100.00" }),
    cashRow({ transactionDate: "2026-01-30", amountThb: "200.00" }),
  ]);
  ok(
    sorted.months[0].month === "2026-01" && sorted.months[1].month === "2025-12",
    "months are sorted descending (newest month first)"
  );

  // 3. AI-parsed equity rows (no MANUAL sourceType) are included via category.
  const ai = buildCashSummary([
    cashRow({
      type: "CASH_IN",
      sourceType: "AI_PARSED",
      category: "equity",
      amountThb: "35420.00",
    }),
  ]);
  ok(
    ai.totalCashInThb === "35420" && ai.totalNetThb === "35420",
    "AI-parsed equity deposit is included through category='equity'"
  );

  // 4. Legacy manual rows with a NULL category are still counted (sourceType=MANUAL).
  const legacy = buildCashSummary([
    cashRow({ sourceType: "MANUAL", category: null, amountThb: "999.00" }),
  ]);
  ok(
    legacy.totalCashInThb === "999",
    "legacy manual row with category=null is counted via sourceType=MANUAL"
  );

  // 5. Non-equity AI rows (e.g. income, expense, asset) are excluded.
  const excluded = buildCashSummary([
    cashRow({ sourceType: "AI_PARSED", category: "income", amountThb: "500.00" }),
    cashRow({ sourceType: "AI_PARSED", category: "expense", amountThb: "300.00" }),
    cashRow({ sourceType: "AI_PARSED", category: "asset", amountThb: "200.00" }),
  ]);
  ok(
    excluded.months.length === 0 &&
      excluded.totalCashInThb === "0" &&
      excluded.totalCashOutThb === "0" &&
      excluded.totalNetThb === "0",
    "non-equity AI rows are never counted (no invented cash flow)"
  );

  // 6. Only CASH_IN/CASH_OUT contribute; other types on an equity row are ignored.
  const oddType = buildCashSummary([
    cashRow({ type: "BUY", amountThb: "4444.00" }),
    cashRow({ type: "SELL", amountThb: "3333.00" }),
  ]);
  ok(
    oddType.totalCashInThb === "0" && oddType.totalCashOutThb === "0",
    "BUY/SELL rows are not cash in/out (trade, not a transfer)"
  );

  // 7. Decimal math: fractional amounts sum exactly without float drift.
  const decimals = buildCashSummary([
    cashRow({ type: "CASH_IN", amountThb: "0.10" }),
    cashRow({ type: "CASH_IN", amountThb: "0.20" }),
    cashRow({ type: "CASH_OUT", amountThb: "0.05" }),
  ]);
  ok(
    decimals.totalCashInThb === "0.3" &&
      decimals.totalCashOutThb === "0.05" &&
      decimals.totalNetThb === "0.25",
    "fractional amounts use Decimal (0.1+0.2 = 0.3, no float drift)"
  );

  // 8. Null/NaN amounts are skipped gracefully (never -Infinity, never counted).
  const badAmount = buildCashSummary([
    cashRow({ amountThb: null }),
    cashRow({ amountThb: "not-a-number" }),
    cashRow({ amountThb: "10.00" }),
  ]);
  ok(
    badAmount.totalCashInThb === "10" && badAmount.totalNetThb === "10",
    "null/NaN amounts are skipped; the valid row still counts"
  );

  // 9. Empty input produces an empty, non-throwing summary.
  const empty = buildCashSummary([]);
  ok(
    empty.months.length === 0 &&
      empty.totalCashInThb === "0" &&
      empty.totalCashOutThb === "0" &&
      empty.totalNetThb === "0",
    "empty input yields an empty summary with zeroed totals"
  );

  // 10. month scope: only rows in the requested calendar month contribute.
  const scopedMonth = buildCashSummary(
    [
      cashRow({
        transactionId: "tx-jan",
        transactionDate: "2026-01-30",
        amountThb: "1000.00",
      }),
      cashRow({
        transactionId: "tx-feb",
        transactionDate: "2026-02-10",
        amountThb: "2000.00",
      }),
    ],
    { month: "2026-02" }
  );
  ok(
    scopedMonth.view === "month" &&
      scopedMonth.months.length === 1 &&
      scopedMonth.months[0].month === "2026-02" &&
      scopedMonth.totalCashInThb === "2000",
    "month scope keeps only the requested calendar month"
  );

  // 11. asOf scope: dates on/before the cutoff count, later dates are dropped.
  const scopedAsOf = buildCashSummary(
    [
      cashRow({
        transactionId: "tx-early",
        transactionDate: "2026-03-14",
        amountThb: "500.00",
      }),
      cashRow({
        transactionId: "tx-cutoff",
        transactionDate: "2026-03-15",
        amountThb: "300.00",
      }),
      cashRow({
        transactionId: "tx-late",
        transactionDate: "2026-03-16",
        amountThb: "9999.00",
      }),
    ],
    { asOf: "2026-03-15" }
  );
  ok(
    scopedAsOf.view === "asOf" &&
      scopedAsOf.totalCashInThb === "800",
    "asOf scope counts rows up to (inclusive) the cutoff date only"
  );

  // 12. withDetail: matching rows are returned chronologically (drill-down).
  const withDetail = buildCashSummary(
    [
      cashRow({
        transactionId: "tx-b",
        transactionDate: "2026-01-20",
        amountThb: "200.00",
        currency: "USD",
        amountForeign: "6.00",
      }),
      cashRow({
        transactionId: "tx-a",
        transactionDate: "2026-01-05",
        amountThb: "100.00",
        currency: "USD",
        amountForeign: "3.00",
      }),
      cashRow({
        transactionId: "tx-expense",
        transactionDate: "2026-01-06",
        amountThb: "50.00",
        currency: "USD",
        amountForeign: "1.50",
        sourceType: "AI_PARSED",
        category: "expense",
      }),
    ],
    { month: "2026-01", withDetail: true }
  );
  ok(
    withDetail.rows?.length === 2 &&
      withDetail.rows?.[0].transactionId === "tx-a" &&
      withDetail.rows?.[1].transactionId === "tx-b" &&
      withDetail.rows?.[0].amountThb === "100.00",
    "withDetail returns only counted rows, sorted by transaction date"
  );

  // 13. Overview (no scope) carries no drill-down rows.
  const plainAll = buildCashSummary([cashRow({ amountThb: "10.00" })]);
  ok(
    plainAll.view === "all" && plainAll.rows === undefined,
    "overview view defaults to 'all' and omits detail rows"
  );

  // 14. All-time withDetail (no month/asOf): every counted row, oldest first.
  const chronologicalAll = buildCashSummary(
    [
      cashRow({
        transactionId: "tx-newest",
        transactionDate: "2026-03-01",
        amountThb: "300.00",
      }),
      cashRow({
        transactionId: "tx-oldest",
        transactionDate: "2025-11-30",
        amountThb: "100.00",
      }),
      cashRow({
        transactionId: "tx-mid",
        transactionDate: "2026-01-15",
        amountThb: "200.00",
      }),
      cashRow({
        transactionId: "tx-trade",
        type: "BUY",
        amountThb: "99999.00",
      }),
    ],
    { withDetail: true }
  );
  ok(
    chronologicalAll.view === "all" &&
      chronologicalAll.rows?.length === 3 &&
      chronologicalAll.rows?.[0].transactionId === "tx-oldest" &&
      chronologicalAll.rows?.[1].transactionId === "tx-mid" &&
      chronologicalAll.rows?.[2].transactionId === "tx-newest" &&
      chronologicalAll.rows?.[0].amountThb === "100.00",
    "all-time withDetail lists every counted row sorted oldest-first"
  );
  ok(
    chronologicalAll.months.length === 3 &&
      chronologicalAll.totalCashInThb === "600" &&
      chronologicalAll.totalNetThb === "600",
    "all-time withDetail keeps the monthly breakdown and totals intact"
  );

  // --- Currency exchange tests ---

  type ExchRow = {
    transactionId: string;
    transactionDate: string;
    currency: string | null;
    amount: string | null;
    amountThb: string | null;
    exchangeFromCurrency: string | null;
    exchangeFromAmount: string | null;
    exchangeRate: string | null;
  };

  function exchRow(p: Partial<ExchRow> = {}): ExchRow {
    return {
      transactionId: `ex-${Math.random().toString(16).slice(2)}`,
      transactionDate: "2026-03-01",
      currency: "THB",
      amount: "35000.00",
      amountThb: "35000.00",
      exchangeFromCurrency: "USD",
      exchangeFromAmount: "1000.00",
      exchangeRate: "35.00",
      ...p,
    };
  }

  console.log("\n=== CURRENCY EXCHANGE ROWS ===\n");

  // 15. buildCashExchangeRows basic: single row
  const singleExch = buildCashExchangeRows([
    exchRow({ transactionId: "ex-1", currency: "THB", amount: "35000.00", amountThb: "35000.00", exchangeFromCurrency: "USD", exchangeFromAmount: "1000.00", exchangeRate: "35.00" }),
  ]);
  ok(
    singleExch.exchanges.length === 1 &&
      singleExch.exchanges[0].fromCurrency === "USD" &&
      singleExch.exchanges[0].toCurrency === "THB" &&
      singleExch.exchanges[0].fromAmount === "1000.00" &&
      singleExch.exchanges[0].rate === "35.00" &&
      singleExch.exchanges[0].amountThb === "35000.00",
    "buildCashExchangeRows: single USD→THB row has correct fields"
  );
  ok(
    singleExch.exchangeTotals.length === 1 &&
      singleExch.exchangeTotals[0].currency === "THB" &&
      singleExch.exchangeTotals[0].totalForeign === "35000" &&
      singleExch.exchangeTotals[0].totalThb === "35000",
    "buildCashExchangeRows: single-row total has one bucket"
  );

  // 16. buildCashExchangeRows: multiple rows with same target currency are summed
  const multiExch = buildCashExchangeRows([
    exchRow({ transactionId: "ex-a", transactionDate: "2026-01-10", currency: "THB", amount: "17500.00", amountThb: "17500.00", exchangeFromCurrency: "USD", exchangeFromAmount: "500.00", exchangeRate: "35.00" }),
    exchRow({ transactionId: "ex-b", transactionDate: "2026-01-20", currency: "THB", amount: "18000.00", amountThb: "18000.00", exchangeFromCurrency: "USD", exchangeFromAmount: "500.00", exchangeRate: "36.00" }),
  ]);
  ok(
    multiExch.exchangeTotals.length === 1 &&
      multiExch.exchangeTotals[0].totalForeign === "35500" &&
      multiExch.exchangeTotals[0].totalThb === "35500",
    "same-currency exchange totals are summed via Decimal (no float drift)"
  );

  // 17. buildCashExchangeRows: different target currencies produce separate totals
  const twoCcy = buildCashExchangeRows([
    exchRow({ transactionId: "ex-thb", transactionDate: "2026-01-10", currency: "THB", amount: "35000.00", amountThb: "35000.00", exchangeFromCurrency: "USD" }),
    exchRow({ transactionId: "ex-jpy", transactionDate: "2026-01-10", currency: "JPY", amount: "150000", amountThb: "34500.00", exchangeFromCurrency: "USD" }),
  ]);
  ok(
    twoCcy.exchangeTotals.length === 2 &&
      twoCcy.exchangeTotals[0].currency === "JPY" &&
      twoCcy.exchangeTotals[1].currency === "THB",
    "different target currencies produce separate totals, sorted alphabetically"
  );

  // 18. buildCashExchangeRows: null from fields are kept as null (honest)
  const nullFrom = buildCashExchangeRows([
    exchRow({ exchangeFromCurrency: null, exchangeFromAmount: null, exchangeRate: null }),
  ]);
  ok(
    nullFrom.exchanges[0].fromCurrency === null &&
      nullFrom.exchanges[0].fromAmount === null &&
      nullFrom.exchanges[0].rate === null,
    "null from/rate fields are preserved honestly (legacy rows)"
  );

  // 19. buildCashExchangeRows: month scope excludes out-of-month rows
  const scopedExch = buildCashExchangeRows(
    [
      exchRow({ transactionId: "ex-jan", transactionDate: "2026-01-15", amount: "1000.00", amountThb: "1000.00" }),
      exchRow({ transactionId: "ex-feb", transactionDate: "2026-02-15", amount: "2000.00", amountThb: "2000.00" }),
    ],
    { month: "2026-02" }
  );
  ok(
    scopedExch.exchanges.length === 1 &&
      scopedExch.exchanges[0].transactionId === "ex-feb" &&
      scopedExch.exchangeTotals[0].totalForeign === "2000",
    "month scope excludes rows from other months"
  );

  // 20. buildCashExchangeRows: asOf scope excludes rows after the cutoff
  const asOfExch = buildCashExchangeRows(
    [
      exchRow({ transactionId: "ex-before", transactionDate: "2026-03-14", amount: "500.00", amountThb: "500.00" }),
      exchRow({ transactionId: "ex-on", transactionDate: "2026-03-15", amount: "300.00", amountThb: "300.00" }),
      exchRow({ transactionId: "ex-after", transactionDate: "2026-03-16", amount: "999.00", amountThb: "999.00" }),
    ],
    { asOf: "2026-03-15" }
  );
  ok(
    asOfExch.exchanges.length === 2 &&
      asOfExch.exchanges.every((x) => x.transactionDate <= "2026-03-15") &&
      asOfExch.exchangeTotals[0].totalForeign === "800",
    "asOf scope counts rows up to (inclusive) the cutoff date"
  );

  // 21. buildCashExchangeRows: empty input yields empty results + zeroed direction totals
  const emptyExch = buildCashExchangeRows([]);
  ok(
    emptyExch.exchanges.length === 0 &&
      emptyExch.exchangeTotals.length === 0 &&
      emptyExch.exchangeDirectionTotals.intoThbCount === 0 &&
      emptyExch.exchangeDirectionTotals.outOfThbCount === 0 &&
      emptyExch.exchangeDirectionTotals.netThb === "0" &&
      emptyExch.exchangeDirectionTotals.moreInThanOut === false,
    "empty exchange input yields empty results + zeroed direction totals"
  );

  // 22. buildCashSummary always returns exchanges/exchangeTotals (empty defaults)
  const summaryDefaults = buildCashSummary([]);
  ok(
    Array.isArray(summaryDefaults.exchanges) &&
      summaryDefaults.exchanges.length === 0 &&
      Array.isArray(summaryDefaults.exchangeTotals) &&
      summaryDefaults.exchangeTotals.length === 0 &&
      summaryDefaults.exchangeDirectionTotals.intoThbTotal === "0" &&
      summaryDefaults.exchangeDirectionTotals.outOfThbTotal === "0",
    "buildCashSummary returns empty arrays for exchanges/exchangeTotals by default"
  );

  // 23. buildCashExchangeRows: rows sorted by transactionDate ascending
  const sortedExch = buildCashExchangeRows([
    exchRow({ transactionId: "ex-late", transactionDate: "2026-03-20" }),
    exchRow({ transactionId: "ex-early", transactionDate: "2026-01-05" }),
    exchRow({ transactionId: "ex-mid", transactionDate: "2026-02-10" }),
  ]);
  ok(
    sortedExch.exchanges[0].transactionId === "ex-early" &&
      sortedExch.exchanges[1].transactionId === "ex-mid" &&
      sortedExch.exchanges[2].transactionId === "ex-late",
    "exchange rows are sorted by transaction date ascending"
  );

  console.log("\n=== EXCHANGE DIRECTION TOTALS (back vs out) ===\n");

  // 24. Direction totals: mixes into-THB and out-of-THB rows, summed in THB.
  const dirMix = buildExchangeDirectionTotals([
    { transactionDate: "2026-01-05", currency: "THB", amountThb: "35200.00", exchangeFromCurrency: "USD" },
    { transactionDate: "2026-01-10", currency: "THB", amountThb: "17500.00", exchangeFromCurrency: "EUR" },
    { transactionDate: "2026-01-15", currency: "USD", amountThb: "35000.00", exchangeFromCurrency: "THB" },
    { transactionDate: "2026-01-20", currency: "USD", amountThb: "10500.00", exchangeFromCurrency: "THB" },
    { transactionDate: "2026-01-25", currency: "THB", amountThb: "10650.00", exchangeFromCurrency: "USD" },
  ]);
  ok(
    dirMix.intoThbTotal === "63350" &&
      dirMix.intoThbCount === 3 &&
      dirMix.outOfThbTotal === "45500" &&
      dirMix.outOfThbCount === 2 &&
      dirMix.netThb === "17850" &&
      dirMix.moreInThanOut === true,
    "direction totals: into 63350/count 3, out 45500/count 2, net +17850 more-in"
  );

  // 25. Direction totals: more exchanged OUT than back — net negative, moreOut.
  const dirOut = buildExchangeDirectionTotals([
    { transactionDate: "2026-02-01", currency: "THB", amountThb: "10000.00", exchangeFromCurrency: "USD" },
    { transactionDate: "2026-02-02", currency: "USD", amountThb: "22000.00", exchangeFromCurrency: "THB" },
  ]);
  ok(
    dirOut.intoThbTotal === "10000" &&
      dirOut.outOfThbTotal === "22000" &&
      dirOut.netThb === "-12000" &&
      dirOut.moreInThanOut === false,
    "direction totals: more exchanged out than back -> net -12000, moreOut"
  );

  // 26. Direction totals: legacy rows without fromCurrency are NOT counted on the out side.
  const dirLegacy = buildExchangeDirectionTotals([
    { transactionDate: "2026-03-01", currency: "USD", amountThb: "99999.00", exchangeFromCurrency: null },
    { transactionDate: "2026-03-02", currency: "THB", amountThb: "5000.00", exchangeFromCurrency: "USD" },
    { transactionDate: "2026-03-03", currency: "USD", amountThb: "7777.00", exchangeFromCurrency: "THB" },
  ]);
  ok(
    dirLegacy.intoThbTotal === "5000" &&
      dirLegacy.intoThbCount === 1 &&
      dirLegacy.outOfThbTotal === "7777" &&
      dirLegacy.outOfThbCount === 1,
    "legacy out-side rows (null fromCurrency) are not counted, never assumed"
  );

  // 27. Direction totals: a row with a non-THB target and no THB from side is
  // neither into nor out of THB — counted nowhere.
  const dirForeign = buildExchangeDirectionTotals([
    { transactionDate: "2026-04-01", currency: "EUR", amountThb: "12000.00", exchangeFromCurrency: "USD" },
  ]);
  ok(
    dirForeign.intoThbCount === 0 &&
      dirForeign.outOfThbCount === 0 &&
      dirForeign.intoThbTotal === "0" &&
      dirForeign.outOfThbTotal === "0" &&
      dirForeign.netThb === "0",
    "foreign-to-foreign rows touch neither direction"
  );

  // 28. Direction totals respect the month scope exactly like the exchange rows.
  const dirScoped = buildExchangeDirectionTotals(
    [
      { transactionDate: "2026-05-01", currency: "THB", amountThb: "1000.00", exchangeFromCurrency: "USD" },
      { transactionDate: "2026-06-01", currency: "USD", amountThb: "2000.00", exchangeFromCurrency: "THB" },
      { transactionDate: "2026-06-15", currency: "THB", amountThb: "700.00", exchangeFromCurrency: "USD" },
    ],
    { month: "2026-06" }
  );
  ok(
    dirScoped.intoThbTotal === "700" &&
      dirScoped.outOfThbTotal === "2000" &&
      dirScoped.netThb === "-1300",
    "direction totals respect the month scope"
  );

  // 29. buildCashExchangeRows also carries the direction totals alongside exchanges.
  const viaRows = buildCashExchangeRows([
    exchRow({ transactionId: "ex-in", currency: "THB", amountThb: "35000.00", exchangeFromCurrency: "USD" }),
    exchRow({ transactionId: "ex-out", currency: "USD", amountThb: "12000.00", exchangeFromCurrency: "THB" }),
  ]);
  ok(
    viaRows.exchangeDirectionTotals.intoThbTotal === "35000" &&
      viaRows.exchangeDirectionTotals.outOfThbTotal === "12000" &&
      viaRows.exchangeDirectionTotals.moreInThanOut === true,
    "buildCashExchangeRows returns the same direction totals for the UI"
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
  console.error("Cash-summary test suite crashed:", e);
  process.exit(1);
});