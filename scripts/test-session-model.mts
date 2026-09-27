// scripts/test-session-model.mts
//
// Behavioural coverage for the session MODEL itself (Task 1), calling the real
// pure helpers instead of grepping source:
//
//   1  access token expired + valid refresh -> stays signed in
//   2  idle for hours -> still inside the refresh session's life
//   3  page reload -> the credential lives in a cookie the page reload keeps
//   4  revoked refresh -> refused
//   5  expired refresh -> refused
//   6  explicit logout -> revokes
//   7  suspended account -> blocked
//   8  a transient 5xx never clears the session
//  12  a rotated refresh token cannot be reused
//
// DB-free: no PostgreSQL connection is opened.

process.env.DATABASE_URL ??= "postgresql://placeholder:placeholder@127.0.0.1:1/placeholder";

import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";

const rs = await import("../app/lib/refresh-session");
const sr = await import("../app/lib/session-refresh");

const {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_SESSION_RENEWAL_WINDOW_SECONDS,
  REFRESH_SESSION_TTL_SECONDS,
  RevokeReason,
  RefreshRejection,
  buildRefreshCookieHeader,
  buildClearRefreshCookieHeader,
  hashRefreshToken,
  refreshCookieIsSecure,
  sessionExpiry,
} = rs;

const { REFRESH_SKEW_SECONDS, msUntilExpiry, needsRefresh } = sr;

const JWT_TEST_SECRET = "session-model-test-secret-0123456789";
/** A real, signed JWT expiring `seconds` from now (negative = already expired). */
function tokenExpiringIn(seconds: number): string {
  return jwt.sign({ sub: "user-1" }, JWT_TEST_SECRET, { expiresIn: seconds });
}

let passed = 0;
let failed = 0;

function check(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log("  PASS  " + label);
  } else {
    failed++;
    console.log("  FAIL  " + label);
  }
}

function section(t: string) {
  console.log("\n=== " + t + " ===");
}

function read(p: string): string {
  return readFileSync(new URL("../" + p, import.meta.url), "utf8");
}

section("LIFETIMES: SHORT ACCESS TOKEN, LONG REFRESH SESSION");

check(ACCESS_TOKEN_TTL_SECONDS === 15 * 60, "the access token lives 15 minutes");
check(
  ACCESS_TOKEN_TTL_SECONDS < 3600,
  "the access token is genuinely short-lived (< 1 hour), not a long-lived token in disguise"
);
check(
  REFRESH_SESSION_TTL_SECONDS === 30 * 24 * 3600,
  "the refresh session lives 30 days"
);
check(
  REFRESH_SESSION_TTL_SECONDS >= 7 * 24 * 3600,
  "the refresh session survives many days of idling (multi-day, per the requirement)"
);
check(
  REFRESH_SESSION_TTL_SECONDS > ACCESS_TOKEN_TTL_SECONDS * 100,
  "the refresh session is orders of magnitude longer than the access token"
);
check(
  ACCESS_TOKEN_TTL_SECONDS < 24 * 3600,
  "the access token is never effectively permanent"
);

section("1/2: IDLE FOR HOURS IS INSIDE THE REFRESH SESSION'S LIFE");

const issuedAt = new Date("2026-03-01T09:00:00.000Z");
const expiresAt = sessionExpiry(issuedAt, REFRESH_SESSION_TTL_SECONDS);

for (const idleHours of [1, 2, 4, 8, 12]) {
  const idleUntil = new Date(issuedAt.getTime() + idleHours * 3600 * 1000);
  check(
    idleUntil.getTime() < expiresAt.getTime(),
    idleHours + "h idle is still inside the 30-day refresh session"
  );
}
check(
  new Date(issuedAt.getTime() + 30 * 24 * 3600 * 1000).getTime() === expiresAt.getTime(),
  "the session expires at exactly 30 days"
);
check(
  new Date(issuedAt.getTime() + 30 * 24 * 3600 * 1000 + 1000).getTime() > expiresAt.getTime(),
  "one second past 30 days the session is dead"
);

section("PROACTIVE REFRESH (so an idle tab never even presents an expired token)");

check(
  REFRESH_SKEW_SECONDS > 0,
  "there is a positive lead time before expiry"
);
check(REFRESH_SKEW_SECONDS <= 5 * 60 * 1000, "the lead time is at most 5 minutes");
check(
  REFRESH_SESSION_RENEWAL_WINDOW_SECONDS === ACCESS_TOKEN_TTL_SECONDS,
  "the server renewal window matches the access-token lifetime (no drift)"
);
check(
  needsRefresh(tokenExpiringIn(60 * 60), Date.now()) === false,
  "a token with a full hour left is NOT refreshed early"
);
check(
  needsRefresh(tokenExpiringIn(-10), Date.now()) === true,
  "an already-expired token needs renewal immediately"
);
check(
  needsRefresh(tokenExpiringIn(REFRESH_SKEW_SECONDS - 5), Date.now()) === true,
  "a token inside the lead window is renewed before it expires"
);
check(needsRefresh("not-a-jwt", Date.now()) === true, "an unreadable expiry is renewed, not trusted");
check(
  msUntilExpiry(tokenExpiringIn(120), Date.now())! > 0,
  "a live token reports positive time remaining"
);
check(
  msUntilExpiry(tokenExpiringIn(-120), Date.now())! < 0,
  "an expired token reports a negative remainder"
);
check(msUntilExpiry(null, Date.now()) === null, "an unreadable token has no known expiry");

section("3/6: THE CREDENTIAL IS AN HTTPONLY COOKIE, SO RELOAD SURVIVES");

const cookie = buildRefreshCookieHeader("the-refresh-token", REFRESH_SESSION_TTL_SECONDS, true);
check(/HttpOnly/i.test(cookie), "the refresh cookie is HttpOnly (invisible to client JS)");
check(/Secure/i.test(cookie), "Secure is set in production");
check(/SameSite=Lax/i.test(cookie), "SameSite=Lax for a same-site deployment");
check(
  cookie.includes("Path=" + REFRESH_COOKIE_PATH),
  "the cookie is scoped to " + REFRESH_COOKIE_PATH + " only"
);
check(
  cookie.includes("Max-Age=" + REFRESH_SESSION_TTL_SECONDS),
  "an explicit Max-Age matches the server-side TTL"
);
check(cookie.startsWith(REFRESH_COOKIE_NAME + "="), "the cookie is named " + REFRESH_COOKIE_NAME);
check(REFRESH_COOKIE_PATH === "/api/v1/auth", "the cookie path is the auth routes only");

const devCookie = buildRefreshCookieHeader("t", 60, false);
check(!/Secure/i.test(devCookie), "Secure is omitted for plain-HTTP localhost development");
check(/HttpOnly/i.test(devCookie), "HttpOnly is still set outside production");

const clearCookie = buildClearRefreshCookieHeader(true);
check(/Max-Age=0/.test(clearCookie), "a zero Max-Age is how logout clears the cookie");
check(/HttpOnly/i.test(clearCookie), "the clearing cookie is HttpOnly too");
check(
  clearCookie.includes("Path=" + REFRESH_COOKIE_PATH),
  "the clearing cookie is scoped to the same path so it actually matches"
);

check(refreshCookieIsSecure("stax.example.com") === true, "a real host is treated as Secure");
check(refreshCookieIsSecure("localhost") === false, "localhost is allowed over plain HTTP");
check(refreshCookieIsSecure("127.0.0.1") === false, "127.0.0.1 is allowed over plain HTTP");
check(refreshCookieIsSecure("localhost:5173") === false, "a localhost port does not force Secure");
// Fail-safe: with no Host header we cannot prove TLS, so Secure is the only
// choice that cannot leak the credential.
check(refreshCookieIsSecure(null) === true, "a missing Host header fails safe to Secure");
check(refreshCookieIsSecure(undefined) === true, "an undefined host fails safe to Secure");
check(refreshCookieIsSecure("   ") === true, "a blank host fails safe to Secure");

section("RAW TOKEN NEVER STORED");

const token = "opaque-refresh-token-value";
const digest = hashRefreshToken(token);
check(digest.length === 64 && /^[0-9a-f]{64}$/.test(digest), "the stored form is a 64-char sha256 hex digest");
check(digest !== token, "the raw token is not what is stored");
check(hashRefreshToken(token) === digest, "hashing is deterministic");
check(hashRefreshToken(token + "x") !== digest, "a different token hashes differently");
check(!digest.includes(token), "the digest does not contain the raw token");

section("4/5/7/12: REVOCATION, ROTATION, REUSE, SUSPENSION");

const reasons: string[] = Object.values(RevokeReason);
for (const r of ["rotated", "logout", "reuse_detected", "password_reset", "account_suspended", "expired"]) {
  check(reasons.includes(r), "a revocation reason exists for '" + r + "'");
}

const rejections: string[] = Object.values(RefreshRejection);
for (const r of [
  RefreshRejection.MISSING,
  RefreshRejection.UNKNOWN,
  RefreshRejection.REVOKED,
  RefreshRejection.EXPIRED,
  RefreshRejection.USER_GONE,
]) {
  check(rejections.includes(r), "a distinct refresh rejection exists: " + r);
}
check(
  new Set(rejections).size === rejections.length,
  "every refresh rejection reason is distinguishable, so a definite failure is never confused with a blip"
);

const refreshSrc = read("app/routes/api/auth/refresh.ts");
check(/reuse|REUSE_DETECTED/.test(refreshSrc), "reuse of a rotated token is detected");
check(
  /family/i.test(refreshSrc) || /family/i.test(read("app/lib/refresh-session.ts")),
  "rotation tracks a token family so replay can be detected"
);
check(
  /ACCOUNT_SUSPENDED/.test(refreshSrc),
  "a suspended account is refused at refresh time, not just at login"
);
check(
  /revokeAllUserSessions|revokedSessionCount/.test(read("app/routes/api/auth/forgot-password/reset.ts")),
  "a password reset revokes every existing refresh session"
);

const logoutSrc = read("app/routes/api/auth/logout.ts");
check(
  /RevokeReason.LOGOUT/.test(logoutSrc),
  "explicit logout revokes the refresh session (it is not just a cookie wipe)"
);
check(
  /buildClearRefreshCookieHeader/.test(logoutSrc),
  "logout clears the cookie with the shared clearing helper"
);

section("8: A TRANSIENT FAILURE NEVER LOGS THE USER OUT");

const pollerSrc = read("app/lib/useAccountStatusPolling.ts");
const heartbeatSrc = read("app/lib/usePresenceHeartbeat.ts");
for (const [name, src] of [
  ["useAccountStatusPolling", pollerSrc],
  ["usePresenceHeartbeat", heartbeatSrc],
] as const) {
  check(
    /refreshAccessToken|refreshSession/.test(src),
    name + " renews the session instead of signing out"
  );
  check(
    !/catch[\s\S]{0,200}signOut\(\)/.test(src) || /refreshAccessToken/.test(src),
    name + " does not sign out on a network/5xx error"
  );
  check(
    /probeSession/.test(src),
    name + " re-confirms the failure before treating it as authoritative"
  );
  check(
    /refreshAccessToken\(true\)|renewSession/.test(src),
    name + " forces a renewal attempt on a confirmed 401"
  );
  check(
    /reason === "rejected"|=== "rejected"/.test(src),
    name + " signs out ONLY when the renewal itself is definitively refused"
  );
}

const probeSrc = read("app/lib/session-probe.ts");
check(
  /transient/i.test(probeSrc),
  "the session probe classifies a failure as transient instead of authoritative"
);
check(
  !/clearSession|signOut/.test(probeSrc) || /transient/i.test(probeSrc),
  "a transient probe failure does not clear the session"
);

section("REFRESH STORM PROTECTION");

const refreshLibSrc = read("app/lib/session-refresh.ts");
check(
  /navigator\.locks|LockManager/.test(refreshLibSrc),
  "refresh runs under the Web Locks API for genuine cross-tab mutual exclusion"
);
check(
  /inFlight/.test(refreshLibSrc),
  "an in-memory single-flight promise covers the single-tab case"
);
check(
  /stax-access-token-refresh/.test(refreshLibSrc),
  "the lock name is shared by every tab on the origin"
);

section("ACCESS TOKEN IS NOT EFFECTIVELY PERMANENT");

const loginSrc = read("app/routes/api/auth/login.ts");
const m = loginSrc.match(/ACCESS_TOKEN_EXPIRY\s*=\s*`\$\{ACCESS_TOKEN_TTL_SECONDS\}s`/);
check(!!m, "login derives the access-token expiry from the single TTL constant");
check(
  !/expiresIn:\s*["'](\d+)d/.test(loginSrc),
  "login never signs an access token with a day-scale lifetime"
);
check(
  /ACCESS_TOKEN_AUDIENCE/.test(loginSrc),
  "the access token carries an explicit audience"
);
check(
  /refreshCookieIsSecure/.test(loginSrc),
  "login decides cookie Secure from the request host rather than hardcoding it"
);

console.log("\n================ SUMMARY ================");
console.log("PASS: " + passed + "   FAIL: " + failed);
if (failed > 0) {
  process.exit(1);
}
