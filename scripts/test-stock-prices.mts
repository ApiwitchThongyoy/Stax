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
  normalizeStockSymbol,
  isValidStockQuote,
} from "../app/lib/stock-price-provider";
import { readFileSync } from "node:fs";
import { handleStockPriceRefresh } from "../app/lib/stock-price-refresh-handler.server";

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

  // 10. Execute the same handler used by the GET loader and POST action.
  // Both collaborators are fake: no database, JWT service or live provider.
  const cronSecret = "test-only-stock-cron-secret";
  const cronStats = { requested: 2, updated: 1, failed: ["DEAD"] };
  let refreshCalls = 0;
  let adminCalls = 0;
  let adminStatus = 401;
  const dependencies = {
    cronSecret: cronSecret as string | undefined,
    refresh: async () => { refreshCalls++; return cronStats; },
    authorizeAdmin: async () => {
      adminCalls++;
      return adminStatus === 200 ? null : Response.json(
        { success: false, message: "Denied" }, { status: adminStatus }
      );
    },
  };
  const cronRequest = (method = "GET", headers: Record<string, string> = {}) =>
    new Request("https://test.local/api/v1/stock-prices/refresh", { method, headers });
  const bearerHeaders = { Authorization: `Bearer ${cronSecret}` };
  const cronResponse = await handleStockPriceRefresh(cronRequest("GET", bearerHeaders), dependencies);
  const cronPayload = await cronResponse.json();
  ok(cronResponse.status === 200 && cronPayload.success === true &&
    JSON.stringify(cronPayload.data) === JSON.stringify(cronStats),
    "Vercel GET + correct Bearer secret returns refresh stats (including failed symbols)");
  ok(refreshCalls === 1 && adminCalls === 0, "valid cron runs once without JWT authentication");
  ok(cronResponse.headers.get("Cache-Control") === "no-store", "cron response cannot be cached");

  for (const [label, headers] of [
    ["missing secret", {}],
    ["wrong same-length secret", { Authorization: `Bearer ${"x".repeat(cronSecret.length)}` }],
    ["wrong shorter secret", { Authorization: "Bearer wrong" }],
    ["missing Bearer scheme", { Authorization: cronSecret }],
    ["wrong scheme", { Authorization: `Basic ${cronSecret}` }],
    ["empty Bearer", { Authorization: "Bearer " }],
    ["forged Vercel user-agent", { "User-Agent": "vercel-cron/1.0" }],
    ["wrong custom secret", { "x-cron-secret": "wrong" }],
  ] as Array<[string, Record<string, string>]>) {
    const response = await handleStockPriceRefresh(cronRequest("GET", headers), dependencies);
    const payload = await response.json();
    ok(response.status === 401 && payload.message === "Unauthorized" &&
      !JSON.stringify(payload).includes(cronSecret) && refreshCalls === 1 && adminCalls === 0,
      `GET rejects ${label} without running refresh or checking JWT`);
  }
  for (const unsetSecret of [undefined, "", "   "]) {
    const response = await handleStockPriceRefresh(
      cronRequest("GET", { Authorization: `Bearer ${String(unsetSecret)}` }),
      { ...dependencies, cronSecret: unsetSecret }
    );
    ok(response.status === 401 && refreshCalls === 1, "missing/blank server CRON_SECRET fails closed");
  }
  for (const method of ["HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await handleStockPriceRefresh(cronRequest(method, bearerHeaders), dependencies);
    ok(response.status === 405 && response.headers.get("Allow") === "GET, POST" &&
      refreshCalls === 1 && adminCalls === 0, `${method} never runs the sweep, even with valid secret`);
  }
  const manualCron = await handleStockPriceRefresh(cronRequest("POST", bearerHeaders), dependencies);
  ok(manualCron.status === 200 && refreshCalls === 2 && adminCalls === 0, "manual Bearer POST remains supported");
  const customCron = await handleStockPriceRefresh(cronRequest("POST", { "x-cron-secret": cronSecret }), dependencies);
  ok(customCron.status === 200 && refreshCalls === 3, "legacy x-cron-secret POST remains supported");
  const anonPost = await handleStockPriceRefresh(cronRequest("POST"), dependencies);
  ok(anonPost.status === 401 && refreshCalls === 3, "unauthenticated POST cannot refresh");
  adminStatus = 403;
  const userPost = await handleStockPriceRefresh(cronRequest("POST", { Authorization: "Bearer user-jwt" }), dependencies);
  ok(userPost.status === 403 && refreshCalls === 3, "non-admin POST cannot refresh");
  adminStatus = 200;
  const adminPost = await handleStockPriceRefresh(cronRequest("POST", { Authorization: "Bearer admin-jwt" }), dependencies);
  ok(adminPost.status === 200 && refreshCalls === 4, "authorized ADMIN POST still refreshes");
  const savedError = console.error;
  const errorLogs: unknown[][] = [];
  try {
    console.error = (...args: unknown[]) => { errorLogs.push(args); };
    const response = await handleStockPriceRefresh(cronRequest("GET", bearerHeaders), {
      ...dependencies, refresh: async () => { throw new Error(`private upstream error ${cronSecret}`); },
    });
    const body = await response.text();
    ok(response.status === 500 && body.includes("Internal server error") &&
      !body.includes(cronSecret) && !JSON.stringify(errorLogs).includes(cronSecret),
      "refresh failure returns sanitized 500 without leaking credentials into response/log");
  } finally { console.error = savedError; }

  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const schedule = config.crons.find((c: { path: string }) => c.path === "/api/v1/stock-prices/refresh")?.schedule;
  ok(schedule === "30 22 * * *", "daily cron is scheduled for 22:30 UTC");
  const [minute, hour] = schedule.split(" ").map(Number);
  for (const day of ["2026-01-15", "2026-07-15"]) {
    const at = new Date(`${day}T${String(hour).padStart(2, "0")}:${minute}:00Z`);
    const nyHour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23",
    }).format(at));
    ok(nyHour > 16, `scheduled time is after the regular 16:00 New York close (${day}, EST/EDT)`);
  }
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  ok(/^CRON_SECRET=\s*$/m.test(example), "environment example contains only a blank CRON_SECRET placeholder");

  // Release-critical regressions. All outbound requests and timers are controlled.
  for (const symbol of ["../secret", "A/B", "AAPL?x=y", "<script>", "A".repeat(13), ""]) {
    ok(normalizeStockSymbol(symbol) === null, "unsafe symbol is rejected");
  }
  ok(normalizeStockSymbol(" brk-b ") === "BRK-B" && normalizeStockSymbol("ptt.bk") === "PTT.BK", "supported tickers normalize");
  for (const close of ["123junk", "123", true, Infinity, -1]) {
    ok(parseYahooChartResponse(chartBody({ timestamps: [ts], closes: [close as never] })) === null,
      "non-numeric/non-positive close cannot become a price");
  }
  for (const timestamp of ["123junk", "123", Infinity, 1e100]) {
    ok(parseYahooChartResponse(chartBody({ timestamps: [timestamp as never], closes: [5] })) === null,
      "invalid timestamp cannot become a stored date");
  }
  ok(!isValidStockQuote({ close: 5, currency: "USD", priceDate: "2026-02-30" }), "invalid calendar date rejected");
  ok(!isValidStockQuote({ close: 5, currency: "123", priceDate: "2026-09-10" }), "invalid currency rejected");
  const zonedBody = chartBody({ timestamps: [Date.parse("2026-09-09T23:00:00Z") / 1000], closes: [10] }) as any;
  zonedBody.chart.result[0].meta.exchangeTimezoneName = "Australia/Sydney";
  ok(parseYahooChartResponse(zonedBody)?.priceDate === "2026-09-10", "date uses exchange timezone, not server timezone");
  zonedBody.chart.result[0].meta.exchangeTimezoneName = "not-a-timezone";
  ok(parseYahooChartResponse(zonedBody) === null, "malformed exchange timezone rejected safely");
  const openSession = chartBody({ timestamps: [Date.parse("2026-09-09T13:30:00Z") / 1000,
    Date.parse("2026-09-10T13:30:00Z") / 1000], closes: [10, 20] }) as any;
  openSession.chart.result[0].meta.currentTradingPeriod = { regular: {
    start: Date.parse("2026-09-10T13:30:00Z") / 1000, end: Date.parse("2026-09-10T20:00:00Z") / 1000,
  } };
  ok(parseYahooChartResponse(openSession, new Date("2026-09-10T15:00:00Z"))?.close === 10,
    "unfinished daily bar is not published as a daily close");
  ok(parseYahooChartResponse(openSession, new Date("2026-09-10T22:30:00Z"))?.close === 20,
    "cron after market close accepts the completed daily bar");

  const secretFixture = "release-secret-must-not-leak";
  const warnings: unknown[][] = [];
  const savedWarn = console.warn;
  const savedFetch = globalThis.fetch;
  const savedSetTimeout = globalThis.setTimeout;
  const savedClearTimeout = globalThis.clearTimeout;
  let timeoutCallback: (() => void) | undefined;
  let timerCleared = false;
  try {
    console.warn = (...args) => { warnings.push(args.map(String)); };
    for (const status of [404, 429, 500, 503]) {
      globalThis.fetch = async () => new Response(secretFixture, { status });
      ok(await yahooFinanceStockSource.getClose("NVDA") === null, `provider ${status} safely returns no price`);
    }
    globalThis.fetch = async () => { throw new Error(secretFixture); };
    ok(await yahooFinanceStockSource.getClose("NVDA") === null, "network exception is safe");
    globalThis.fetch = async () => new Response("{}");
    ok(await yahooFinanceStockSource.getClose("NVDA") === null, "empty payload is safe");
    globalThis.fetch = async () => new Response(secretFixture);
    ok(await yahooFinanceStockSource.getClose("NVDA") === null, "malformed JSON is safe");

    globalThis.setTimeout = ((callback: () => void) => { timeoutCallback = callback; return 1; }) as never;
    globalThis.clearTimeout = (() => { timerCleared = true; }) as never;
    for (const phase of ["headers", "body"]) {
      timerCleared = false;
      globalThis.fetch = (async (_url, init) => {
        const blocked = () => new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new DOMException(secretFixture, "AbortError")), { once: true });
          queueMicrotask(() => timeoutCallback!());
        });
        return phase === "headers" ? blocked() : { ok: true, json: blocked };
      }) as typeof fetch;
      ok(await yahooFinanceStockSource.getClose("NVDA") === null && timerCleared,
        `timeout covers ${phase} and timer is cleared`);
    }
    globalThis.setTimeout = savedSetTimeout;
    globalThis.clearTimeout = savedClearTimeout;

    const written: string[] = [];
    const mixed = await refreshStockPricesCore(["FIRST", "THROW", "BADDATE", "DBFAIL", "LAST"], {
      name: "mock", async getClose(symbol) {
        if (symbol === "THROW") throw new Error(secretFixture);
        return { priceDate: symbol === "BADDATE" ? "2026-02-30" : "2026-09-10", close: 10, currency: "USD" };
      },
    }, async (quote) => {
      if (quote.symbol === "DBFAIL") throw new Error(secretFixture);
      written.push(quote.symbol);
    }, { delayMs: 0 });
    ok(mixed.updated === 2 && mixed.failed.join(",") === "THROW,BADDATE,DBFAIL" && written.join(",") === "FIRST,LAST",
      "provider/write failures are isolated; later symbols still persist");
    ok(!JSON.stringify(warnings).includes(secretFixture), "provider/refresh logs never expose exception secrets");
  } finally {
    globalThis.fetch = savedFetch;
    console.warn = savedWarn;
    globalThis.setTimeout = savedSetTimeout;
    globalThis.clearTimeout = savedClearTimeout;
  }

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
