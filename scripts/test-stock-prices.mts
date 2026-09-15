// Daily stock-price provider unit tests (DB-free).
//
// Covers the pure, injectable core of the stock-price feature:
//   - parseYahooChartResponse: extract the last real daily close + date +
//     currency from a Yahoo /v8/finance/chart body; all malformed/error shapes
//     degrade to null (never a fabricated price).
//   - isDefaultStale: the 1-day staleness gate that drives lazy refresh.
//   - yahooFinanceStockSource with a mocked global fetch (success, non-2xx,
//     invalid JSON).
//   - refreshStockPricesCore with a fake source + in-memory upsert sink:
//     collects stats, never throws, reports failed symbols.
//   - stockPriceRowFromQuote row shaping.
//
// No network and no database are touched (the DB path lives in the
// TEST_DATABASE_URL-gated harness, scripts/run-tests.mts).
//
// Run:  npx tsx scripts/test-stock-prices.mts
import {
  parseYahooChartResponse,
  isDefaultStale,
  yahooFinanceStockSource,
  refreshStockPricesCore,
  stockPriceRowFromQuote,
  type StockPriceSource,
} from "../app/lib/stock-price-provider";

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

function chartBody(
  partial: Partial<{
    error: unknown;
    currency: string;
    timestamps: number[];
    closes: (number | null)[];
  }>
): unknown {
  const { error = null, currency = "USD", timestamps = [], closes = [] } = partial;
  return {
    chart: {
      result: [
        {
          meta: { currency },
          timestamp: timestamps,
          indicators: { quote: [{ close: closes }] },
        },
      ],
      error,
    },
  };
}

async function main() {
  console.log("\n=== STOCK PRICE PROVIDER (daily closes) ===\n");

  // 1. parseYahooChartResponse — happy path.
  const ts = new Date(Date.UTC(2026, 8, 10)).getTime() / 1000; // 2026-09-10 UTC
  const parsed = parseYahooChartResponse(
    chartBody({ timestamps: [ts], closes: [142.5] })
  );
  ok(
    parsed !== null &&
      parsed.priceDate === "2026-09-10" &&
      parsed.close === 142.5 &&
      parsed.currency === "USD",
    "parses the last close with its UTC date and currency"
  );

  // 2. Date formatting is UTC and zero-padded.
  const parsed2 = parseYahooChartResponse(
    chartBody({
      timestamps: [new Date(Date.UTC(2026, 0, 5)).getTime() / 1000],
      closes: [1.2],
    })
  );
  ok(
    parsed2 !== null && parsed2.priceDate === "2026-01-05",
    "formats dates as zero-padded yyyy-mm-dd in UTC"
  );

  // 3. Trailing null closes are skipped; the previous real close wins.
  const parsed3 = parseYahooChartResponse(
    chartBody({
      timestamps: [171, 172],
      closes: [100, null],
    })
  );
  ok(
    parsed3 !== null && parsed3.close === 100,
    "skips trailing null closes and returns the last real close"
  );

  // 4. chart.error is never surfaced as a price.
  ok(
    parseYahooChartResponse(chartBody({ error: { code: 404 } })) === null,
    "chart.error -> null (never a fabricated price)"
  );

  // 5. Malformed shapes degrade to null.
  ok(parseYahooChartResponse(null) === null, "null body -> null");
  ok(parseYahooChartResponse({}) === null, "empty body -> null");
  ok(
    parseYahooChartResponse({ chart: {} }) === null,
    "chart without result -> null"
  );
  ok(
    parseYahooChartResponse(
      chartBody({ currency: "USD", timestamps: [], closes: [] })
    ) === null,
    "empty series -> null"
  );
  ok(
    parseYahooChartResponse(
      chartBody({ currency: "USDX", timestamps: [171], closes: [5] })
    ) === null,
    "non-3-letter currency -> null"
  );
  ok(
    parseYahooChartResponse(
      chartBody({ timestamps: [171], closes: [5, 6] })
    ) === null,
    "timestamp/close length mismatch -> null"
  );
  ok(
    parseYahooChartResponse(
      chartBody({ timestamps: [171], closes: [0] })
    ) === null,
    "non-positive close -> null"
  );

  // 6. isDefaultStale — the lazy-refresh gate.
  const now = new Date("2026-09-11T06:00:00Z");
  const freshIso = new Date("2026-09-10T12:00:00Z").toISOString();
  const oldIso = new Date("2026-09-07T06:00:00Z").toISOString();
  ok(isDefaultStale(freshIso, now) === false, "a <1-day-old price is fresh");
  ok(isDefaultStale(oldIso, now) === true, "a >1-day-old price is stale");
  ok(isDefaultStale(null, now) === true, "missing timestamp is stale");
  ok(isDefaultStale("garbage", now) === true, "unparseable timestamp is stale");

  // 7. yahooFinanceStockSource with a mocked global fetch.
  const origFetch = globalThis.fetch;
  try {
    const okBody = JSON.stringify(
      chartBody({
        timestamps: [new Date(Date.UTC(2026, 8, 10)).getTime() / 1000],
        closes: [33.44],
      })
    );
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(okBody, { status: 200 })) as typeof fetch;

    const viaFetch = await yahooFinanceStockSource.getClose("NVDA");
    ok(
      viaFetch !== null &&
        viaFetch.close === 33.44 &&
        viaFetch.currency === "USD" &&
        viaFetch.priceDate === "2026-09-10",
      "source returns a parsed close for a normal 200 response"
    );

    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("not json", { status: 500 })) as typeof fetch;
    ok(
      (await yahooFinanceStockSource.getClose("NVDA")) === null,
      "source yields null on a non-2xx response"
    );

    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("{broken", { status: 200 })) as typeof fetch;
    ok(
      (await yahooFinanceStockSource.getClose("NVDA")) === null,
      "source yields null on invalid JSON"
    );
  } finally {
    globalThis.fetch = origFetch;
  }

  // 8. refreshStockPricesCore — stats + idempotent upserts, no DB.
  const upserted: Array<{ symbol: string; priceDate: string; close: number; currency: string }> = [];
  const goodSource: StockPriceSource = {
    name: "test-source",
    async getClose(symbol: string) {
      return { priceDate: "2026-09-10", close: 10, currency: "USD" };
    },
  };
  const allGood = await refreshStockPricesCore(["AAPL", "MSFT"], goodSource, async (q) => {
    upserted.push(q);
  }, { delayMs: 0 });
  ok(
    allGood.requested === 2 && allGood.updated === 2 && allGood.failed.length === 0,
    "refresh core reports requested=2 updated=2 failed=[]"
  );
  ok(
    upserted.length === 2 &&
      upserted[0].symbol === "AAPL" &&
      upserted[1].symbol === "MSFT" &&
      upserted.every((q) => q.close === 10 && q.currency === "USD"),
    "refresh core upserts each symbol with the resolved quote (symbol included)"
  );

  const failingSource: StockPriceSource = {
    name: "fail-source",
    async getClose(symbol: string) {
      return symbol === "DEAD" ? null : { priceDate: "2026-09-10", close: 7, currency: "USD" };
    },
  };
  const partialStats = await refreshStockPricesCore(["GOOD", "DEAD"], failingSource, async () => {}, { delayMs: 0 });
  ok(
    partialStats.updated === 1 &&
      partialStats.failed.length === 1 &&
      partialStats.failed[0] === "DEAD",
    "a failing symbol is reported in failed[] without aborting the sweep"
  );

  // 9. stockPriceRowFromQuote — stable row shape for storage.
  const fixedNow = new Date("2026-09-11T06:00:00Z");
  const row = stockPriceRowFromQuote(
    { symbol: "NVDA", priceDate: "2026-09-10", close: 142.5, currency: "USD" },
    fixedNow
  );
  ok(
    row.symbol === "NVDA" &&
      row.priceDate === "2026-09-10" &&
      row.closePrice === "142.5" &&
      row.currency === "USD" &&
      row.createdAt === fixedNow.toISOString() &&
      row.updatedAt === fixedNow.toISOString() &&
      typeof row.id === "string" && row.id.length > 0,
    "row helper builds a DB-ready payload (id + timestamps)"
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
  console.error("Stock-price test suite crashed:", e);
  process.exit(1);
});