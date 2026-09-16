import { randomUUID } from "node:crypto";
import type postgres from "postgres";

/** Real stock routes/cache, mocked Yahoo only. Called by the guarded W2 harness. */
export async function runReleaseReadinessTests(sql: postgres.Sql,
  ok: (condition: boolean, label: string) => void, token: string, admin: string, userId: string) {
  const check = (condition: boolean, label: string) => ok(condition, `REG-release: ${label}`);
  const read = await import("../app/routes/api/stock-prices");
  const refresh = await import("../app/routes/api/stock-prices/refresh");
  const { upsertStockPrice } = await import("../app/lib/stock-price-cache");
  const { resolveStockPrice } = await import("../app/lib/stock-price-refresh");
  const savedFetch = globalThis.fetch, savedSecret = process.env.CRON_SECRET;
  const secret = "release-cron-test-only";
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const symbols = ["RRA", "RRB", "RRC", "RRNONE", "RREMPTY"];
  let providerCalls = 0;
  const get = (query: string) => read.loader({ request: new Request(`http://test.local/api/v1/stock-prices?${query}`,
    { headers: { Authorization: `Bearer ${token}` } }) } as never);
  const sweep = () => refresh.loader({ request: new Request("http://test.local/api/v1/stock-prices/refresh",
    { headers: { Authorization: `Bearer ${secret}` } }) } as never);
  try {
    process.env.CRON_SECRET = secret;
    for (const [i, symbol] of symbols.slice(0, 3).entries()) {
      await sql`INSERT INTO "Capital_Transactions" (transaction_id,user_id,amount_foreign,amount_thb,currency,transaction_date,type,source_type,symbol)
        VALUES (${ids[i]},${userId},'1','1','THB','2026-09-10','CASH_IN','MANUAL',${symbol})`;
    }
    globalThis.fetch = async () => { providerCalls++; throw new Error(secret); };
    for (const bad of ["../secret", "A/B", "AAPL?token=secret", "A".repeat(13)]) {
      const response = await get(`symbols=${encodeURIComponent(bad)}`);
      check(response.status === 400 && !(await response.text()).includes(bad), "invalid ticker rejected without reflecting input");
    }
    check(providerCalls === 0, "invalid symbols never call provider");

    const quote = { symbol: "RRA", priceDate: "2026-09-10", close: 100, currency: "USD" };
    const writes = await Promise.all(Array.from({ length: 8 }, () => upsertStockPrice({ ...quote, symbol: " rra " })));
    const rows = await sql`SELECT * FROM stock_prices WHERE symbol='RRA' AND price_date='2026-09-10'`;
    check(rows.length === 1 && writes.every((row) => row.id === rows[0].id), "8 concurrent daily upserts return one canonical row (no 23505)");
    const response = await get("symbols=rra,RRA");
    const body = await response.json();
    check(response.status === 200 && body.data.length === 1 && body.data[0].close === 100 && body.data[0].priceDate === "2026-09-10",
      "valid read normalizes/deduplicates symbols and keeps trading date");
    check(providerCalls === 0, "fresh cache read avoids network");
    await sql`UPDATE stock_prices SET updated_at='2020-01-01T00:00:00Z' WHERE symbol='RRA'`;
    const stale = await get("symbols=RRA,RRNONE");
    const staleBody = await stale.json();
    check(stale.status === 200 && staleBody.data.length === 1 && staleBody.data[0].close === 100
      && staleBody.data[0].priceUpdatedAt === "2020-01-01T00:00:00Z", "network failure serves dated stale price; missing ticker omitted");
    const thrown = await resolveStockPrice("RRA", { name: "throws", async getClose() { throw new Error(secret); } });
    check(thrown?.close === 100, "thrown custom provider also falls back to cache");
    globalThis.fetch = async () => new Response("{}");
    const empty = await get("symbols=RREMPTY");
    check(empty.status === 200 && (await empty.json()).data.length === 0, "empty provider payload gives no fabricated price");

    let closingPrice = 123.45;
    globalThis.fetch = async (input) => {
      providerCalls++;
      const symbol = decodeURIComponent(new URL(String(input)).pathname.split("/").at(-1)!);
      if (symbol === "RRB") return new Response(secret, { status: 429 });
      return Response.json({ chart: { error: null, result: [{ meta: { currency: "USD", exchangeTimezoneName: "America/New_York" },
        timestamp: [Date.parse("2026-09-10T13:30:00Z") / 1000], indicators: { quote: [{ close: [closingPrice] }] } }] } });
    };
    for (let i = 0; i < 2; i++) {
      const cron = await sweep();
      const data = (await cron.json()).data;
      check(cron.status === 200 && data.updated >= 2 && data.failed.includes("RRB"), "cron partial 429 failure preserves successful symbols and reports failure");
      closingPrice = 124.5;
    }
    const stored = await sql`SELECT symbol,price_date,close_price FROM stock_prices WHERE symbol IN ('RRA','RRB','RRC') ORDER BY symbol`;
    check(stored.length === 2 && stored.every((row) => row.price_date === "2026-09-10" && Number(row.close_price) === 124.5),
      "repeated cron updates same-day values with no duplicate dates or failed-symbol writes");
    const adminResult = await refresh.action({ request: new Request("http://test.local/api/v1/stock-prices/refresh", {
      method: "POST", headers: { Authorization: `Bearer ${admin}` },
    }) } as never);
    check(adminResult.status === 200, "ADMIN refresh remains supported");
    check((await sql`SELECT id FROM stock_prices WHERE symbol='RRA'`).length === 1, "ADMIN after repeated cron still has one daily row");

    const before = providerCalls;
    for (const authorization of ["", "Bearer wrong", `Bearer ${token}`]) {
      const denied = await refresh.loader({ request: new Request("http://test.local/api/v1/stock-prices/refresh", {
        headers: authorization ? { Authorization: authorization } : {},
      }) } as never);
      check(denied.status === 401 && !(await denied.text()).includes(secret), "missing/wrong/JWT cron credentials rejected safely");
    }
    const userPost = await refresh.action({ request: new Request("http://test.local/api/v1/stock-prices/refresh", {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
    }) } as never);
    check(userPost.status === 403 && providerCalls === before, "USER refresh denied before provider call");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = savedSecret;
    await sql`DELETE FROM "Capital_Transactions" WHERE transaction_id IN ${sql(ids)} AND user_id=${userId}`;
    await sql`DELETE FROM stock_prices WHERE symbol IN ${sql(symbols)}`;
  }
}
