// DB-free unit tests for the pure rate-limit helpers and safe-error-log.
// No database or environment variables required.
import assert from "node:assert/strict";
import {
  RATE_LIMIT_WINDOW_MS,
  LOGIN_EMAIL_RATE_LIMIT,
  LOGIN_IP_RATE_LIMIT,
  REGISTER_IP_RATE_LIMIT,
  loginIpKey,
  loginEmailKey,
  registerIpKey,
  clientIpFromRequest,
  evaluateRateLimit,
  rateLimitResponse,
} from "../app/lib/rate-limit-core";
import { safeErrorLog } from "../app/lib/safe-error-log";

let passed = 0;
function check(condition: boolean, label: string) {
  assert.ok(condition, label);
  passed++;
  console.log(`  PASS  ${label}`);
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://test.local", { headers });
}

async function main() {
  // ---- Constants ----
  check(RATE_LIMIT_WINDOW_MS === 15 * 60 * 1000, "window is 15 minutes (ms)");
  check(LOGIN_EMAIL_RATE_LIMIT.maxAttempts === 5, "login email budget is 5");
  check(LOGIN_IP_RATE_LIMIT.maxAttempts === 20, "login IP budget is 20");
  check(REGISTER_IP_RATE_LIMIT.maxAttempts === 10, "register IP budget is 10");
  check(LOGIN_EMAIL_RATE_LIMIT.windowMs === RATE_LIMIT_WINDOW_MS, "login email uses canonical window");
  check(LOGIN_IP_RATE_LIMIT.windowMs === RATE_LIMIT_WINDOW_MS, "login IP uses canonical window");
  check(REGISTER_IP_RATE_LIMIT.windowMs === RATE_LIMIT_WINDOW_MS, "register IP uses canonical window");

  // ---- Key builders ----
  check(loginIpKey("1.2.3.4") === "login-ip:1.2.3.4", "loginIpKey prefixes correctly");
  check(loginEmailKey("a@b.c") === "login-email:a@b.c", "loginEmailKey prefixes correctly");
  check(
    registerIpKey("10.0.0.1") === "register-ip:10.0.0.1",
    "registerIpKey prefixes the IP only (no email in the register IP key)"
  );
  check(
    registerIpKey("203.0.113.9") !== registerIpKey("203.0.113.10"),
    "different IPs produce different register buckets"
  );
  check(
    !registerIpKey("203.0.113.9").includes("@"),
    "register IP key never embeds an email (rotating emails share one bucket)"
  );

  // ---- clientIpFromRequest ----
  check(
    clientIpFromRequest(req({ "x-forwarded-for": "203.0.113.1, 10.0.0.1" })) === "203.0.113.1",
    "x-forwarded-for first segment wins"
  );
  check(
    clientIpFromRequest(req({ "x-real-ip": "198.51.100.1" })) === "198.51.100.1",
    "x-real-ip used when no forwarded-for"
  );
  check(
    clientIpFromRequest(req({ "cf-connecting-ip": "104.23.255.1" })) === "104.23.255.1",
    "cf-connecting-ip used as fallback"
  );
  check(
    clientIpFromRequest(req({ "x-forwarded-for": "[::1], 127.0.0.1" })) === "[::1]",
    "IPv6 bracket notation accepted"
  );
  check(clientIpFromRequest(req({})) === "unknown", "missing all headers → 'unknown'");
  check(clientIpFromRequest(req({ "x-forwarded-for": "" })) === "unknown", "empty forwarded-for → 'unknown'");
  check(clientIpFromRequest(req({ "x-forwarded-for": "bad!/@#" })) === "unknown", "invalid chars rejected → 'unknown'");
  check(clientIpFromRequest(req({ "x-forwarded-for": "a".repeat(65) })) === "unknown", "oversized IP string rejected → 'unknown'");
  check(
    clientIpFromRequest(req({ "x-forwarded-for": "bad!@", "x-real-ip": "1.2.3.4" })) === "1.2.3.4",
    "invalid x-forwarded-for skipped, x-real-ip used"
  );

  // ---- evaluateRateLimit: window expired resets ----
  const expiredStart = Date.now() - RATE_LIMIT_WINDOW_MS - 1;
  const expired1 = evaluateRateLimit(REGISTER_IP_RATE_LIMIT, expiredStart, 99);
  check(
    expired1.limited === false && expired1.attempts === 0,
    "expired window resets regardless of attempt count"
  );
  const expired2 = evaluateRateLimit(LOGIN_EMAIL_RATE_LIMIT, expiredStart, 99);
  check(
    expired2.limited === false && expired2.attempts === 0,
    "expired window resets for the email bucket too"
  );

  // ---- evaluateRateLimit: within window, under budget ----
  const activeWindow = Date.now() - 100;
  const under = evaluateRateLimit(LOGIN_EMAIL_RATE_LIMIT, activeWindow, 3);
  check(
    under.limited === false && under.attempts === 3 && under.retryAfterMs === 0,
    "under-budget attempts → not limited"
  );

  // ---- exact boundary: attempts === max → allowed (this request IS the max-th) ----
  const atMax = evaluateRateLimit(LOGIN_EMAIL_RATE_LIMIT, activeWindow, LOGIN_EMAIL_RATE_LIMIT.maxAttempts);
  check(atMax.limited === false, "attempts === maxAttempts → not limited (the max-th attempt is the last allowed)");

  // ---- post-increment semantics: attempts INCLUDES this request ----
  check(
    evaluateRateLimit(LOGIN_EMAIL_RATE_LIMIT, activeWindow, 5).limited === false &&
      evaluateRateLimit(LOGIN_EMAIL_RATE_LIMIT, activeWindow, 6).limited === true,
    "post-increment boundary: 5 failures allowed, the 6th attempt (attempts=6) is limited"
  );

  // ---- over budget: attempts > max → limited ----
  const over = evaluateRateLimit(LOGIN_EMAIL_RATE_LIMIT, activeWindow, LOGIN_EMAIL_RATE_LIMIT.maxAttempts + 1);
  check(over.limited === true, "attempts > maxAttempts → limited (429)");
  check(
    over.retryAfterMs > 0 && over.retryAfterMs <= RATE_LIMIT_WINDOW_MS,
    "retryAfter is within window bounds"
  );
  check(
    evaluateRateLimit(LOGIN_IP_RATE_LIMIT, activeWindow, LOGIN_IP_RATE_LIMIT.maxAttempts + 1).limited === true,
    "login IP over budget → limited"
  );
  check(
    evaluateRateLimit(LOGIN_IP_RATE_LIMIT, activeWindow, LOGIN_IP_RATE_LIMIT.maxAttempts).limited === false,
    "login IP at exact budget → not limited"
  );

  // ---- rateLimitResponse ----
  const resp = rateLimitResponse(899_500, 5, 0);
  check(resp.status === 429, "rateLimitResponse returns 429");
  check(resp.headers.get("Retry-After") === "900", "Retry-After is ceil(ms/1000)");
  check(resp.headers.get("X-RateLimit-Limit") === "5", "X-RateLimit-Limit header matches limit");
  check(resp.headers.get("X-RateLimit-Remaining") === "0", "X-RateLimit-Remaining is 0 when exhausted");
  const resp2 = rateLimitResponse(0, 10, 7);
  check(resp2.headers.get("Retry-After") === "1", "Retry-After minimum is 1 second");
  check(resp2.headers.get("X-RateLimit-Remaining") === "7", "X-RateLimit-Remaining passed through");

  const body = (await resp.json()) as Record<string, unknown>;
  check(body.success === false, "body.success is false");
  check(body.code === "TOO_MANY_ATTEMPTS", "body.code is TOO_MANY_ATTEMPTS");
  check(typeof body.retryAfterSeconds === "number", "body.retryAfterSeconds is a number");

  // ---- safeErrorLog ----
  check(safeErrorLog(new Error("boom")).errorName === "Error", "safeErrorLog returns Error constructor name");
  check(
    safeErrorLog({ constructor: { name: "PostgresError" } }).errorName === "PostgresError",
    "safeErrorLog handles object with constructor.name"
  );
  check(safeErrorLog(null).errorName === "null", "safeErrorLog(null) → 'null'");
  check(safeErrorLog("hello").errorName === "string", "safeErrorLog(string) → typeof name");
  check(safeErrorLog(42).errorName === "number", "safeErrorLog(number) → 'number'");

  console.log(`\nPASS: ${passed}   FAIL: 0`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
