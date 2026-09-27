// DB-free regression tests for the session-renewal client and the reset-ticket
// contract that the password-recovery flow depends on.
//
// The single-use ticket is the security-critical part: verification spends the
// OTP at verify time, so the ticket needs its own server-side claim. These
// tests lock the pure pieces (hashing, comparison, token introspection) and the
// source-level wiring that enforces the claim, without needing a database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";

import {
  RESET_TICKET_AUDIENCE,
  RESET_TICKET_PURPOSE,
  RESET_TICKET_TTL_SECONDS,
  hashResetTicket,
  resetTicketHashMatches,
  signResetTicket,
  verifyResetTicket,
} from "../app/lib/reset-ticket";
import {
  REFRESH_SKEW_SECONDS,
  msUntilExpiry,
  needsRefresh,
  readJwtExpiry,
} from "../app/lib/session-refresh";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, "..", rel), "utf8");

/**
 * app/lib/otp.ts builds a postgres client at import time, so a placeholder is
 * needed before it can be loaded. Nothing in this file issues a query — the
 * predicate under test is pure, and the client is never used.
 */
async function loadIsDevOtpEnabled() {
  process.env.DATABASE_URL ??= "postgresql://placeholder:placeholder@127.0.0.1:1/placeholder";
  const otp = await import("../app/lib/otp");
  return otp.isDevOtpEnabled;
}

let passed = 0;
function check(condition: boolean, label: string) {
  assert.ok(condition, label);
  passed++;
  console.log(`  PASS  ${label}`);
}

const ENV = { JWT_SECRET: "test-only-secret-that-is-long-enough" } as NodeJS.ProcessEnv;
const claims = { userId: "user-1", otpId: "otp-1", purpose: RESET_TICKET_PURPOSE };

/** Build an unsigned-shape JWT with an explicit exp so expiry math is testable. */
function fakeJwt(expSeconds: number): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ exp: expSeconds })}.sig`;
}

async function main() {
  // ---- reset ticket: single-use claim ------------------------------------
  const isDevOtpEnabled = await loadIsDevOtpEnabled();

  const ticket = signResetTicket(claims, ENV);
  const hash = hashResetTicket(ticket);
  check(/^[0-9a-f]{64}$/.test(hash), "ticket hash is a 64-char sha256 hex digest");
  check(hash !== ticket, "the plaintext ticket is never what gets stored");
  check(hashResetTicket(ticket) === hash, "ticket hashing is deterministic");
  check(resetTicketHashMatches(ticket, hash), "the matching ticket passes its own claim");
  check(!resetTicketHashMatches(`${ticket}x`, hash), "a tampered ticket fails the claim");
  check(!resetTicketHashMatches(ticket, "0".repeat(64)), "a different digest is refused");
  check(!resetTicketHashMatches(ticket, ""), "an empty claim is refused rather than thrown on");

  const verified = verifyResetTicket(ticket, ENV);
  check(verified?.userId === "user-1", "a valid ticket round-trips its user");
  check(verified?.otpId === "otp-1", "a valid ticket round-trips the OTP row id");
  check(verifyResetTicket(`${ticket}x`, ENV) === null, "a tampered ticket fails signature verification");
  check(verifyResetTicket("", ENV) === null, "an empty ticket is refused");
  check(verifyResetTicket(undefined, ENV) === null, "a non-string ticket is refused");
  check(verifyResetTicket(ticket, { JWT_SECRET: "a-different-secret-entirely" } as NodeJS.ProcessEnv) === null,
    "a ticket signed with another secret is refused");
  check(
    verifyResetTicket(jwtSignWrongPurpose(), ENV) === null,
    "a ticket minted for another purpose is refused even with a valid signature"
  );
  check(RESET_TICKET_TTL_SECONDS <= 10 * 60, "the ticket lifetime stays short (minutes, not hours)");

  // ---- the two token classes are separated in BOTH directions ------------
  // A reset ticket and an access token share one signing secret, so the
  // separation has to be enforced, not incidental.
  process.env.DATABASE_URL ??= "postgresql://placeholder:placeholder@127.0.0.1:1/placeholder";
  const { ACCESS_TOKEN_AUDIENCE } = await import("../app/lib/auth-middleware");
  // Widened to string so the comparison is checked at runtime rather than
  // rejected at compile time as a disjoint-literal comparison.
  check(
    (ACCESS_TOKEN_AUDIENCE as string) !== (RESET_TICKET_AUDIENCE as string),
    "the two token classes use different audiences"
  );

  const ticketVerified = verifyResetTicket(ticket, ENV);
  check(ticketVerified !== null, "the ticket still verifies against its own audience");
  check(
    verifyResetTicket(ticket, ENV) === null || !("email" in (ticketVerified as object)),
    "a ticket carries no email claim"
  );
  check(
    !("role" in (ticketVerified as object)),
    "a ticket carries no role claim, so it cannot pass the access payload check either"
  );

  const accessToken = jwtSignForTest({ userId: "user-1", email: "u@x.test", role: "USER" }, ENV);
  // The access verifier asserts its audience, so the ticket must not satisfy it.
  check(
    (() => {
      try {
        jwt.verify(ticket, ENV.JWT_SECRET as string, { audience: ACCESS_TOKEN_AUDIENCE });
        return false;
      } catch {
        return true;
      }
    })(),
    "a reset ticket is rejected when verified as an access token (audience mismatch)"
  );
  check(
    (() => {
      try {
        jwt.verify(accessToken, ENV.JWT_SECRET as string, { audience: RESET_TICKET_AUDIENCE });
        return false;
      } catch {
        return true;
      }
    })(),
    "an access token is rejected when verified as a reset ticket (audience mismatch)"
  );

  const authMiddlewareSrc = read("app/lib/auth-middleware.ts");
  check(
    /jwt\.verify\([\s\S]{0,120}audience: ACCESS_TOKEN_AUDIENCE/.test(authMiddlewareSrc),
    "verifyAuth asserts the access-token audience rather than accepting any signed JWT"
  );
  for (const signer of ["app/routes/api/auth/login.ts", "app/routes/api/auth/refresh.ts"]) {
    const src = read(signer);
    check(
      /audience: ACCESS_TOKEN_AUDIENCE/.test(src),
      `${signer} stamps the access-token audience on every token it issues`
    );
  }

  // ---- access-token introspection ---------------------------------------
  const now = 1_000_000_000_000;
  check(readJwtExpiry(fakeJwt(Math.floor(now / 1000) + 300)) !== null, "a well-formed JWT exposes its exp");
  check(readJwtExpiry("not-a-jwt") === null, "a malformed token yields null instead of throwing");
  check(readJwtExpiry(null) === null, "a null token yields null instead of throwing");
  check(readJwtExpiry(undefined) === null, "an undefined token yields null instead of throwing");
  check(readJwtExpiry(12345) === null, "a non-string token yields null instead of throwing");

  const fresh = fakeJwt(Math.floor(now / 1000) + 600);
  const stale = fakeJwt(Math.floor(now / 1000) - 10);
  check(msUntilExpiry(fresh, now) !== null && (msUntilExpiry(fresh, now) as number) > 0, "a future token reports time remaining");
  check(msUntilExpiry(stale, now) !== null && (msUntilExpiry(stale, now) as number) < 0, "an expired token reports a negative remainder");
  check(msUntilExpiry("garbage", now) === null, "an unreadable token has no known expiry");
  check(needsRefresh(fresh, now) === false, "a comfortably valid token is not refreshed early");
  check(needsRefresh(stale, now) === true, "an expired token needs refresh immediately");
  // Inside the lead window: still valid, but within REFRESH_SKEW_SECONDS of
  // expiry, so it must already be renewed rather than left to run out.
  const nearlyStale = fakeJwt(Math.floor(now / 1000) + REFRESH_SKEW_SECONDS - 10);
  check(needsRefresh(nearlyStale, now) === true, "a token inside the lead window needs refresh before expiry");
  check(needsRefresh("garbage", now) === true, "a token with no readable exp is refreshed rather than trusted");
  check(REFRESH_SKEW_SECONDS > 0 && REFRESH_SKEW_SECONDS < 5 * 60, "the refresh lead time is positive and under five minutes");

  // ---- server enforcement of the single-use claim ------------------------
  // These are source assertions because the guarantee lives in a transaction
  // that needs a real database; the pure helpers above cannot prove it.
  const verifySrc = read("app/routes/api/auth/forgot-password/verify-otp.ts");
  check(verifySrc.includes("hashResetTicket(ticket)"), "verify stores the ticket digest on the OTP row");
  check(verifySrc.includes("resetTicketHash: ticketHash"), "verify writes the digest into reset_ticket_hash");
  check(
    /update\(emailOtps\)[\s\S]{0,400}isNull\(emailOtps\.consumedAt\)/.test(verifySrc),
    "verify claims the code with a conditional UPDATE requiring it to be unconsumed"
  );
  check(verifySrc.includes('reason: "code_already_consumed"'), "a lost race to consume the code is audited and refused");
  check(
    /claimed !== 1/.test(verifySrc),
    "verify treats 0 updated rows as a refusal instead of minting a second ticket"
  );
  check(
    !/consumeOtp\(/.test(verifySrc),
    "verify no longer consumes the row with a non-conditional write (which would allow a race)"
  );

  const resetSrc = read("app/routes/api/auth/forgot-password/reset.ts");
  check(
    resetSrc.includes("isNotNull(emailOtps.consumedAt)"),
    "reset expects the code to be already spent by verification"
  );
  check(
    !/isNull\(emailOtps\.consumedAt\)/.test(resetSrc),
    "reset no longer requires an unconsumed code (which verification can never leave behind)"
  );
  check(resetSrc.includes("resetTicketHashMatches"), "reset verifies the ticket against the stored claim");
  check(
    /set\(\{ resetTicketHash: null \}\)/.test(resetSrc),
    "reset clears the claim, so the ticket is spent by using it"
  );
  check(
    /eq\(emailOtps\.resetTicketHash, ticketHash\)/.test(resetSrc),
    "the claim is cleared by a conditional UPDATE matching the presented digest"
  );
  check(
    /spent\.length !== 1/.test(resetSrc),
    "a replayed ticket (0 rows updated) is refused instead of re-setting the password"
  );
  check(
    resetSrc.indexOf("spent.length !== 1") < resetSrc.indexOf("return { kind: \"ok\" as const"),
    "the ticket is spent before the transaction reports success"
  );

  const schemaSrc = read("app/db/schema.ts");
  check(schemaSrc.includes('resetTicketHash: text("reset_ticket_hash")'), "the OTP row carries the ticket claim");
  check(schemaSrc.includes("chk_email_otp_reset_ticket_hash"), "the claim column is length-constrained");
  const migrationSrc = read("drizzle/0029_add_refresh_sessions_and_otp.sql");
  check(migrationSrc.includes('"reset_ticket_hash" text'), "the migration creates the ticket claim column");
  check(migrationSrc.includes("chk_email_otp_reset_ticket_hash"), "the migration adds the matching constraint");

  // ---- renewal is wired into both guards and the poller ------------------
  const protectedSrc = read("app/routes/ProtectedLayout.tsx");
  check(protectedSrc.includes("useSessionRefresh"), "the user layout mounts the renewal hook");
  const adminSrc = read("app/component/Admin/Adminprotected.tsx");
  check(adminSrc.includes("refreshAdminAccessToken"), "the admin layout renews its own session");
  const refreshSrc = read("app/lib/session-refresh.ts");
  check(
    refreshSrc.includes("user: { id: user.id, email: user.email, role: user.role }"),
    "the renewed admin claim is flattened to the stored admin shape, not copied from a user object"
  );
  check(
    !/saveAdminSession\(\{[^}]*user: user\.user/.test(refreshSrc),
    "the renewal never writes a nonexistent nested user object"
  );
  check(
    refreshSrc.includes('user.role !== "ADMIN"'),
    "a non-ADMIN renewal is never written into the admin store"
  );
  const pollSrc = read("app/lib/useAccountStatusPolling.ts");
  check(
    pollSrc.includes("refreshAccessToken") && pollSrc.includes('renewed.reason === "rejected"'),
    "a confirmed 401 triggers a renewal attempt before the session is cleared"
  );
  const heartbeatSrc = read("app/lib/usePresenceHeartbeat.ts");
  check(
    heartbeatSrc.includes("refreshAccessToken") && heartbeatSrc.includes('renewed.reason === "rejected"'),
    "the heartbeat also renews before signing the user out"
  );

  // ---- dev OTP display is explicit, never NODE_ENV -----------------------
  // Behavioural, not a grep: a comment explaining the rule would satisfy a
  // source scan while the code did the opposite.
  check(isDevOtpEnabled({ AUTH_DEV_SHOW_OTP: "true" } as NodeJS.ProcessEnv) === true, "the dev flag alone enables the code echo");
  check(isDevOtpEnabled({ AUTH_DEV_SHOW_OTP: " TRUE " } as NodeJS.ProcessEnv) === true, "the flag tolerates surrounding whitespace and case");
  check(isDevOtpEnabled({} as NodeJS.ProcessEnv) === false, "an unset flag keeps codes hidden");
  check(isDevOtpEnabled({ AUTH_DEV_SHOW_OTP: "false" } as NodeJS.ProcessEnv) === false, "an explicit false keeps codes hidden");
  check(
    isDevOtpEnabled({ AUTH_DEV_SHOW_OTP: "1" } as NodeJS.ProcessEnv) === false,
    "only the literal 'true' enables the code echo (an ambiguous '1' is refused)"
  );
  check(
    isDevOtpEnabled({ NODE_ENV: "development" } as NodeJS.ProcessEnv) === false,
    "NODE_ENV=development alone does NOT enable the code echo (explicit opt-in only)"
  );
  check(
    isDevOtpEnabled({ AUTH_DEV_SHOW_OTP: "true", NODE_ENV: "production" } as NodeJS.ProcessEnv) === true,
    "the flag is honoured even when NODE_ENV=production (it is the single auditable switch)"
  );
  const envExample = read(".env.example");
  check(envExample.includes("AUTH_DEV_SHOW_OTP"), ".env.example documents the dev flag");
  check(envExample.includes("DEVELOPMENT ONLY"), ".env.example marks the dev flag as development-only");

  console.log(`\n${passed} passed`);
}

function jwtSignWrongPurpose(): string {
  // Signed correctly, but carries a purpose the reset route refuses.
  return signResetTicket({ ...claims, purpose: "SOMETHING_ELSE" }, ENV);
}

/** An access-token-shaped JWT, signed the way login/refresh sign them. */
function jwtSignForTest(payload: object, env: NodeJS.ProcessEnv): string {
  return jwt.sign(payload, env.JWT_SECRET as string, {
    expiresIn: "15m",
    audience: "stax-access",
  });
}

void main();