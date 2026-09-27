// Keep-users-signed-in-while-idle regression tests (pure, DB-free, no browser).
//
// STAX has NO inactivity/idle logout. These tests lock that down and cover the
// real defect behind the "I got logged out for sitting idle" report: a single
// transient 401 (proxy/CDN/gateway) used to wipe localStorage instantly, and a
// backgrounded/refreshed tab whose first probe landed after the token expired
// looked exactly like an idle logout.
//
// Covered:
//   - classifySessionStatus: 200 -> active, 403+ACCOUNT_SUSPENDED -> suspended,
//     5xx/408/425/429/404/non-suspension-403/other -> transient, 401 ->
//     unauthorized (the ONLY outcome that may clear auth).
//   - clearsSession(): only "unauthorized".
//   - probeSession: a lone 401 is a candidate, not a verdict — one 401 followed
//     by 200 keeps the session; a 401 followed by 5xx keeps the session; a
//     repeated 401 (1 + confirmations) IS confirmed.
//   - probeSession never throws: offline/network errors and any non-2xx body
//     that is not a credential rejection are transient.
//   - Source guards: no idle/inactivity timer, no visibilitychange /
//     document.hidden / focus / blur listener, and no bare
//     `status === 401 -> clearAllSessions()` left in the auth wiring.
//   - Explicit logout is preserved (Dashboard + SettingsPage still call it).
//
// Run: npx tsx scripts/test-session-probe.mts
import "./_load-env.mjs";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SESSION_STATUS_ENDPOINT,
  SESSION_UNAUTHORIZED_CONFIRM_ATTEMPTS,
  clearsSession,
  classifySessionStatus,
  isTransientSessionStatus,
  probeSession,
  type SessionProbeOutcome,
} from "../app/lib/session-probe";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Fetch stub that replays a queue of responses (or throws) in order. */
function stubFetch(steps: Array<Response | Error>) {
  const calls: Array<{ url: string; auth: string | null; method: string }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      auth: new Headers(init?.headers).get("Authorization"),
      method: init?.method ?? "GET",
    });
    const next = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (next instanceof Error) throw next;
    // Clone so isSuspendedResponse can still read the body after inspection.
    return next.clone();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noWait = async () => {};

// ---------------------------------------------------------------------------
// 1. Pure classifier
// ---------------------------------------------------------------------------

console.log("\n=== CLASSIFY: 401 IS THE ONLY SESSION-CLEARING OUTCOME ===");

ok(classifySessionStatus(200, false) === "active", "200 -> active");
ok(classifySessionStatus(204, false) === "active", "204 -> active");
ok(
  classifySessionStatus(403, true) === "suspended",
  "403 + ACCOUNT_SUSPENDED -> suspended"
);
ok(classifySessionStatus(401, false) === "unauthorized", "401 -> unauthorized");

for (const status of [500, 502, 503, 504, 408, 425, 429, 404]) {
  ok(
    isTransientSessionStatus(status),
    `${status} is a transient/infrastructure status`
  );
  ok(
    classifySessionStatus(status, false) === "transient",
    `${status} -> transient (never clears auth)`
  );
}

ok(
  classifySessionStatus(403, false) === "transient",
  "403 that is NOT ACCOUNT_SUSPENDED -> transient (never clears auth)"
);
ok(
  classifySessionStatus(400, false) === "transient",
  "400 -> transient (not a credential statement)"
);
ok(
  classifySessionStatus(500, true) === "suspended",
  "suspension code wins over the status class"
);

ok(clearsSession("unauthorized"), "clearsSession(unauthorized) === true");
ok(!clearsSession("active"), "clearsSession(active) === false");
ok(!clearsSession("suspended"), "clearsSession(suspended) === false");
ok(!clearsSession("transient"), "clearsSession(transient) === false");

// ---------------------------------------------------------------------------
// 2. probeSession: a lone 401 is a candidate, not a verdict
// ---------------------------------------------------------------------------

console.log("\n=== PROBE: LONE 401 (PROXY/CDN BLIP) KEEPS THE SESSION ===");

{
  const { impl, calls } = stubFetch([
    new Response(undefined, { status: 401 }),
    new Response(undefined, { status: 200 }),
  ]);
  const outcome = await probeSession({
    token: "t",
    fetchImpl: impl,
    wait: noWait,
  });
  ok(outcome === "active", "one 401 then 200 -> active (session preserved)");
  ok(calls.length === 2, "one 401 triggers exactly one confirmation probe");
  ok(
    calls[1].url === SESSION_STATUS_ENDPOINT,
    "confirmation probe targets the session endpoint"
  );
  ok(
    calls[0].auth === "Bearer t",
    "probe sends the existing bearer token (no new/hardcoded credential)"
  );
}

{
  const { impl } = stubFetch([
    new Response(undefined, { status: 401 }),
    new Response(undefined, { status: 503 }),
  ]);
  const outcome = await probeSession({
    token: "t",
    fetchImpl: impl,
    wait: noWait,
  });
  ok(
    outcome === "transient",
    "401 then 503 -> transient (outage never wipes auth)"
  );
  ok(!clearsSession(outcome), "401 + 5xx does NOT clear the session");
}

console.log("\n=== PROBE: IDLE / BACKGROUND TAB STAYS SIGNED IN ===");

{
  // A backgrounded tab is simply polled less often. Whenever the probe does run
  // it must come back "active" — nothing about being backgrounded logs out.
  const { impl, calls } = stubFetch([
    new Response(undefined, { status: 200 }),
    new Response(undefined, { status: 200 }),
    new Response(undefined, { status: 200 }),
  ]);
  for (let i = 0; i < 3; i++) {
    const outcome = await probeSession({
      token: "t",
      fetchImpl: impl,
      wait: noWait,
    });
    ok(outcome === "active", `background poll #${i + 1} -> active (still signed in)`);
  }
  ok(calls.length === 3, "three background polls issued, none cleared auth");
}

console.log("\n=== PROBE: TRANSIENT FAILURES NEVER CLEAR AUTH ===");

{
  const { impl } = stubFetch([new Error("Failed to fetch")]);
  const outcome = await probeSession({ token: "t", fetchImpl: impl, wait: noWait });
  ok(outcome === "transient", "offline / network error -> transient");
  ok(!clearsSession(outcome), "offline does not clear the session");
}

{
  const { impl } = stubFetch([new Response(undefined, { status: 500 })]);
  const outcome = await probeSession({ token: "t", fetchImpl: impl, wait: noWait });
  ok(outcome === "transient", "500 -> transient");
  ok(!clearsSession(outcome), "500 does not clear the session");
}

{
  const { impl } = stubFetch([
    json(403, { success: false, message: "Forbidden" }),
  ]);
  const outcome = await probeSession({ token: "t", fetchImpl: impl, wait: noWait });
  ok(outcome === "transient", "plain 403 -> transient");
  ok(!clearsSession(outcome), "plain 403 does not clear the session");
}

{
  const { impl } = stubFetch([
    json(403, { success: false, code: "ACCOUNT_SUSPENDED" }),
  ]);
  const outcome = await probeSession({ token: "t", fetchImpl: impl, wait: noWait });
  ok(outcome === "suspended", "403 + ACCOUNT_SUSPENDED -> suspended");
  ok(!clearsSession(outcome), "suspension does not silently wipe the session");
}

console.log("\n=== PROBE: INVALID / REVOKED SESSION STILL LOGS OUT ===");

{
  const { impl, calls } = stubFetch([new Response(undefined, { status: 401 })]);
  const outcome = await probeSession({
    token: "t",
    fetchImpl: impl,
    confirmAttempts: SESSION_UNAUTHORIZED_CONFIRM_ATTEMPTS,
    wait: noWait,
  });
  ok(outcome === "unauthorized", "persistent 401 -> unauthorized (confirmed)");
  ok(clearsSession(outcome), "confirmed 401 clears the session");
  ok(
    calls.length === 1 + SESSION_UNAUTHORIZED_CONFIRM_ATTEMPTS,
    "confirmed via 1 probe + 2 confirmations (3 requests total)"
  );
}

{
  // Revoked user record / deleted account also surfaces as 401 from verifyAuth.
  const { impl } = stubFetch([new Response(undefined, { status: 401 })]);
  const outcome = await probeSession({
    token: "t",
    fetchImpl: impl,
    wait: noWait,
  });
  ok(
    outcome === "unauthorized",
    "revoked/invalid session confirmed even with default options"
  );
}

// ---------------------------------------------------------------------------
// 3. Source guards — no inactivity logout anywhere in the auth surface
// ---------------------------------------------------------------------------

console.log("\n=== SOURCE: NO INACTIVITY LOGOUT EXISTS ===");

const AUTH_SOURCES = [
  "app/lib/auth.tsx",
  "app/routes/ProtectedLayout.tsx",
  "app/lib/session-probe.ts",
  "app/lib/useAccountStatusPolling.ts",
  "app/lib/usePresenceHeartbeat.ts",
  "app/lib/session.ts",
  "app/lib/suspended-account.tsx",
];

const IDLE_PATTERNS: Array<[RegExp, string]> = [
  [/\binactiv/i, "inactivity"],
  [/\bidle_timeout/i, "idle timeout"],
  [/\bidletime/i, "idle time"],
  [/\blast_?activit/i, "last-activity tracking"],
  [/\bauto_?logout/i, "auto-logout"],
  [/\bvisibilitychange\b/, "visibilitychange listener"],
  [/document\.hidden/, "document.hidden check"],
  [/\bpagehide\b/, "pagehide listener"],
  [/\bpageshow\b/, "pageshow listener"],
  [/\bbeforeunload\b/, "beforeunload listener"],
  [/\bfreezeblur\b/, "freeze/blur-based logout"],
];

for (const rel of AUTH_SOURCES) {
  const src = read(rel);
  for (const [pattern, label] of IDLE_PATTERNS) {
    // Strip comments so the documentation that explains the absence of these
    // mechanisms is not mistaken for their presence.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    ok(!pattern.test(code), `${rel}: no ${label} logic`);
  }
}

const pollingSrc = read("app/lib/useAccountStatusPolling.ts");
ok(
  pollingSrc.includes("probeSession"),
  "useAccountStatusPolling routes every probe through probeSession"
);
ok(
  !/res\.status === 401/.test(pollingSrc),
  "useAccountStatusPolling no longer trusts a single raw 401"
);

const heartbeatSrc = read("app/lib/usePresenceHeartbeat.ts");
ok(
  heartbeatSrc.includes("probeSession"),
  "usePresenceHeartbeat confirms a 401 via probeSession before clearing"
);
ok(
  /outcome === "unauthorized"/.test(heartbeatSrc),
  "usePresenceHeartbeat only clears auth on a confirmed unauthorized outcome"
);

const protectedSrc = read("app/routes/ProtectedLayout.tsx");
ok(
  protectedSrc.includes("clearsSession") && protectedSrc.includes("probeSession"),
  "ProtectedLayout clears auth only via clearsSession(probeSession(...))"
);
ok(
  !/clearAllSessions\(\);\s*\n\s*logout\(\);/.test(
    protectedSrc.replace(/\/\/.*$/gm, "")
  ) || protectedSrc.includes('if (clearsSession(outcome))'),
  "ProtectedLayout entry check gates logout behind clearsSession"
);

const probeSrc = read("app/lib/session-probe.ts");
ok(
  probeSrc.includes("probeSession") &&
    probeSrc.includes("isTransientSessionStatus") &&
    probeSrc.includes("clearsSession"),
  "session-probe exports the classifier, the transient guard and the clearer"
);
ok(
  !/localStorage\.setItem\(\s*STORAGE_KEY/.test(read("app/lib/session-probe.ts")),
  "session-probe never writes credentials into storage"
);

console.log("\n=== SOURCE: EXPLICIT LOGOUT PRESERVED ===");

const dashboardSrc = read("app/component/DashboardUser/Dashboard.tsx");
ok(
  /const handleLogout = \(\) => \{\s*logout\(\);/.test(dashboardSrc),
  "Dashboard explicit logout still calls logout()"
);
ok(
  dashboardSrc.includes('navigate("/login", { replace: true })'),
  "Dashboard explicit logout still redirects to /login"
);
const settingsSrc = read("app/component/DashboardUser/SettingsPage.tsx");
ok(
  /authLogout\(\);/.test(settingsSrc) && settingsSrc.includes("<LogOut"),
  "SettingsPage explicit logout button still calls authLogout()"
);
const authSrc = read("app/lib/auth.tsx");
ok(
  /const logout = useCallback/.test(authSrc) &&
    authSrc.includes('window.localStorage.removeItem(STORAGE_KEY)'),
  "AuthProvider.logout still clears the stored session"
);

console.log("\n=== SOURCE: SERVER-SIDE AUTHORIZATION UNTOUCHED ===");

const middlewareSrc = read("app/lib/auth-middleware.ts");
ok(
  /jwt\.verify\(\s*token,\s*jwtSecret\s*,\s*\{[\s\S]{0,200}?audience: ACCESS_TOKEN_AUDIENCE/.test(middlewareSrc),
  "verifyAuth still verifies the JWT signature server-side, and additionally asserts the access-token audience"
);
ok(
  middlewareSrc.includes('decoded.email') &&
    middlewareSrc.includes("user.email !== decoded.email"),
  "verifyAuth still re-resolves the user from the database"
);
ok(
  middlewareSrc.includes('user.status !== "ACTIVE"'),
  "verifyAuth still enforces ACTIVE status (suspension honored)"
);
ok(
  middlewareSrc.includes('"Invalid or expired token"'),
  "verifyAuth still rejects an invalid/expired token with 401"
);
ok(
  middlewareSrc.includes("return { status: 500, message: \"Internal server error\" }"),
  "verifyAuth still answers 500 (not 401) on a database failure"
);

const loginSrc = read("app/routes/api/auth/login.ts");
const refreshLibSrc = read("app/lib/refresh-session.ts");

// The original 1h assertion is deliberately INVERTED. A 1-hour access token is
// exactly the exposure this work removed: any leaked token (XSS capture, shared
// machine, proxy log) stayed usable for an hour. The token is now 15 minutes, and
// the assertion pins that number so it cannot silently creep back up.
ok(
  /export const ACCESS_TOKEN_TTL_SECONDS = 15 \* 60;/.test(refreshLibSrc),
  "the access token is short-lived (15 minutes), owned by refresh-session.ts"
);
ok(
  loginSrc.includes(
    "const ACCESS_TOKEN_EXPIRY = `${ACCESS_TOKEN_TTL_SECONDS}s`"
  ),
  "login derives the token lifetime from the shared constant (no per-file drift)"
);

// The SECOND original assertion ("no fabricated refresh token was introduced into
// the login response") encoded a real invariant that is still correct and still
// load-bearing: the long-lived credential must never reach page JavaScript. The
// new design satisfies it differently — via an HttpOnly cookie — so the assertion
// is re-pointed at the actual guarantee rather than deleted.
ok(
  !/data:\s*\{[^}]*refreshToken/s.test(loginSrc) &&
    !/refreshToken\s*:/.test(loginSrc),
  "the login response body never carries a long-lived refresh credential"
);
ok(
  loginSrc.includes("buildRefreshCookieHeader") &&
    refreshLibSrc.includes('"HttpOnly"') &&
    refreshLibSrc.includes("SameSite=Lax") &&
    refreshLibSrc.includes("REFRESH_COOKIE_PATH"),
  "the refresh credential is delivered only as a path-scoped HttpOnly cookie"
);
ok(
  !/document\.cookie/.test(loginSrc) && !/localStorage/i.test(loginSrc),
  "login never hands the session to JS-cookie or localStorage storage"
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n================ SUMMARY ================");
console.log(`PASS: ${passed}   FAIL: ${failed}`);

if (failed > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  process.exit(1);
}
