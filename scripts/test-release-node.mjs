// Opt-in smoke test of the BUILT Node server, never a deployment/live provider.
// Start it with the same local TEST_DATABASE_URL as DATABASE_URL first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const databaseUrl = new URL(process.env.TEST_DATABASE_URL ?? "http://invalid");
const base = new URL(process.env.TEST_BASE_URL ?? "http://invalid");
if (!['localhost', '127.0.0.1'].includes(databaseUrl.hostname)
  || !databaseUrl.pathname.endsWith('_test')
  || !['localhost', '127.0.0.1'].includes(base.hostname)) {
  throw new Error("Set local TEST_DATABASE_URL ending in _test and local TEST_BASE_URL");
}
const sql = postgres(databaseUrl.toString(), { max: 1 });
const email = `release-node-${randomUUID()}@test.local`;
const password = "ReleaseNodeTest!234";
const stockId = randomUUID();
const fixtureSymbol = "R" + randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
let userId;
let token;
let count = 0;
const check = (condition, label) => { assert.ok(condition, label); count++; console.log(`PASS ${label}`); };
async function request(path, method = "GET", body, authorized = true) {
  const response = await fetch(new URL(`/api/v1/${path}`, base), {
    method,
    headers: { ...(authorized && token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() };
}
try {
  check((await request("auth/session", "GET", undefined, false)).status === 401, "built server routes unauthenticated API safely");
  const registered = await request("auth/register", "POST", { email, password }, false);
  check(registered.status === 201, "HTTP register succeeds");
  // Establish that the running server and cleanup connection use the SAME DB.
  const [stored] = await sql`SELECT id FROM "User" WHERE email=${email}`;
  assert.ok(stored, "server must point at the disposable TEST_DATABASE_URL");
  userId = stored.id;
  const login = await request("auth/login", "POST", { email: ` ${email.toUpperCase()} `, password }, false);
  token = login.body.data?.accessToken;
  check(login.status === 200 && !!token, "HTTP normalized login succeeds");
  const session = await request("auth/session");
  check(session.status === 200 && session.body.data.userId === userId && session.body.data.status === "ACTIVE", "HTTP session resolves database identity");
  check((await request("auth/heartbeat", "POST")).status === 200, "HTTP heartbeat POST succeeds");
  check((await sql`SELECT last_seen_at FROM "User" WHERE id=${userId}`)[0].last_seen_at !== null, "heartbeat persisted");

  await sql`INSERT INTO stock_prices (id,symbol,price_date,close_price,currency,created_at,updated_at)
    VALUES (${stockId},${fixtureSymbol},'2026-09-10','123.45','USD',${new Date().toISOString()},${new Date().toISOString()})`;
  const price = await request(`stock-prices?symbols=${fixtureSymbol}`);
  check(price.status === 200 && price.body.data[0]?.close === 123.45, "HTTP stock read serves seeded cache (zero provider calls)");
  check((await request("stock-prices?symbols=..%2Fbad")).status === 400, "HTTP invalid ticker rejected");
  check((await request("stock-prices/refresh", "GET", undefined, false)).status === 401, "HTTP cron without secret denied");
  check((await request("stock-prices/refresh", "POST")).status === 403, "HTTP USER refresh denied");

  const entry = await request("journal", "POST", {
    entryDate: "2026-09-10", description: "release HTTP reversal",
    lines: [{ accountId: "1020", currency: "USD", debit: "100", fxRateEffective: "1" },
      { accountId: "3010", currency: "USD", credit: "100", fxRateEffective: "1" }],
  });
  check(entry.status === 201, "HTTP balanced journal entry created");
  const reversed = await request(`journal/${entry.body.data.entryId}/reverse`, "POST");
  check(reversed.status === 200, "HTTP own journal reversal succeeds");
  const entries = await sql`SELECT status FROM journal_entries WHERE id=${entry.body.data.entryId} AND user_id=${userId}`;
  check(entries[0]?.status === "REVERSED", "reversal changes original state");
  const lines = await sql`SELECT COALESCE(sum(debit_amount),0)-COALESCE(sum(credit_amount),0) AS net FROM journal_entry_lines WHERE user_id=${userId}`;
  check(Number(lines[0].net) === 0, "double-entry debit/credit remains balanced after reversal");
  check((await request(`journal/${entry.body.data.entryId}/reverse`, "POST")).status === 400, "sequential second reversal rejected");
  for (const path of ["accounts", "journal", "ledger/summary", "cash-summary", "cost-basis", "documents", "trading-journal",
    "reports/trial-balance", "reports/income-statement", "reports/balance-sheet", "settings", "notifications"]) {
    check((await request(path)).status === 200, `HTTP ${path} works`);
  }
  check((await request("admin/users")).status === 403, "HTTP USER cannot read admin users");
  console.log(`Node production smoke: ${count} PASS / 0 FAIL`);
} finally {
  // Also recover the fixture if an assertion failed immediately after register.
  userId ??= (await sql`SELECT id FROM "User" WHERE email=${email}`)[0]?.id;
  await sql`DELETE FROM stock_prices WHERE id=${stockId}`;
  if (userId) {
    await sql`DELETE FROM journal_entry_lines WHERE user_id=${userId}`;
    await sql`DELETE FROM journal_entries WHERE user_id=${userId}`;
    await sql`DELETE FROM accounts WHERE user_id=${userId}`;
    await sql`DELETE FROM notifications WHERE user_id=${userId}`;
    await sql`DELETE FROM audit_logs WHERE user_id=${userId}`;
    await sql`DELETE FROM user_settings WHERE user_id=${userId}`;
    await sql`DELETE FROM "User" WHERE id=${userId}`;
  }
  await sql.end();
}
