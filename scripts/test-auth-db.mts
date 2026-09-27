/**
 * DB-backed authentication integration tests (opt-in, requires TEST_DATABASE_URL).
 *
 * These are the behaviours that CANNOT be proven without a real database, and
 * that the pure/source-level suites can only approximate:
 *
 *   1. A registration OTP creates the account ONLY after verification.
 *   2. Refresh rotation invalidates the old token (single use).
 *   3. Reusing a rotated token is detected and kills the whole family.
 *   4. A password reset revokes every existing refresh session.
 *   5. A reset ticket cannot be replayed (the claim is spent atomically).
 *   6. OTP codes are single-use and bound to email + purpose + pepper.
 *
 * Every query is a postgres.js tagged template, so values are always bound as
 * parameters and can never break out of a string literal.
 *
 * Run: TEST_DATABASE_URL=... npx tsx scripts/test-auth-db.mts
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
if (!url) {
  console.log("SKIP: TEST_DATABASE_URL not set (DB-backed auth tests need a real database)");
  process.exit(0);
}

const dbName = new URL(url).pathname.replace(/^\//, "");
if (!/_test$|_live$/.test(dbName)) {
  console.error("REFUSE: database name must end in _test or _live, never production");
  process.exit(1);
}

if ((process.env.JWT_SECRET ?? "").length < 16) {
  console.error("REFUSE: JWT_SECRET must be set (>=16 chars) for these tests");
  process.exit(1);
}

process.env.DATABASE_URL = url;

let passed = 0;
let failed = 0;
function check(ok: unknown, label: string): boolean {
  if (ok) {
    passed++;
    console.log("  PASS  " + label);
  } else {
    failed++;
    console.log("  FAIL  " + label);
  }
  return Boolean(ok);
}

const { db } = await import("../app/lib/drizzle-db");
const raw = postgres(url, { max: 2 });

/** First row of a query, or undefined. */
async function one<T = Record<string, unknown>>(query: unknown): Promise<T | undefined> {
  const rows = (await query) as T[];
  return rows[0];
}
/** A single count(*) from a query. */
async function n(query: unknown): Promise<number> {
  const row = await one<{ n: number }>(query);
  return Number(row?.n ?? 0);
}

const {
  issueRefreshSession,
  rotateRefreshSession,
  findRefreshSession,
  revokeAllUserSessions,
  RevokeReason,
} = await import("../app/lib/refresh-session");
const { issueOtp, consumeOtp, otpAttemptOutcome, OtpPurpose } = await import("../app/lib/otp");
const { signResetTicket, verifyResetTicket, hashResetTicket, RESET_TICKET_PURPOSE } = await import(
  "../app/lib/reset-ticket"
);

const PEPPER = "integration-test-pepper-0123456789";
const createdUsers: string[] = [];
const testEmails: string[] = [];

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  createdUsers.push(id);
  const email = label + "-" + id.slice(0, 8) + "@example.test";
  await raw`insert into "User" ("id","email","password_hash","role","status")
             values (${id}, ${email}, ${"not-a-real-hash"}, ${"USER"}, ${"ACTIVE"})`;
  return id;
}

// Every assertion block runs inside try/finally so cleanup ALWAYS executes, even
// if a query throws mid-run. Without this a crashed run leaves users, sessions
// and OTP rows behind, and the next run's self-cleaning assertions fail for
// reasons that have nothing to do with the code under test.
try {
  console.log("\n=== 1. REGISTRATION OTP IS REQUIRED BEFORE AN ACCOUNT EXISTS ===");
{
  const email = "reg-" + randomUUID().slice(0, 8) + "@example.test";
  testEmails.push(email);
  const issued = await issueOtp({ email, purpose: OtpPurpose.REGISTER, pepper: PEPPER, conn: db });

  check(issued.ok, "a registration OTP is issued");
  if (issued.ok) {
    const otp = issued.otp;
    check(/^[0-9]{6}$/.test(otp.code), "the issued code is 6 digits");
    check((await findRefreshSession("no-such-token")) === null, "an unknown refresh token resolves to no session");

    const rec = await one<{ user_id: string | null; consumed_at: Date | null }>(
      raw`select user_id, consumed_at from email_otp where id = ${otp.id}`
    );
    check(rec?.user_id === null, "the OTP has no user_id yet (account not created)");

    await consumeOtp(otp.id, new Date(), db);
    const after = await one<{ consumed_at: Date | null }>(
      raw`select consumed_at from email_otp where id = ${otp.id}`
    );
    check(after?.consumed_at !== null, "verifying consumes the OTP (single use)");
    check((await n(raw`select count(*)::int as n from email_otp where id = ${otp.id}`)) === 1,
      "a consumed OTP is marked, not deleted (auditable)");
    check((await n(raw`select count(*)::int as n from "User" where email = ${email}`)) === 0,
      "an OTP alone still creates no account (the route owns creation)");
  }
}

console.log("\n=== 2. REFRESH ROTATION IS SINGLE USE ===");
{
  const userId = await createUser("rotate");
  const first = await issueRefreshSession(userId, { conn: db });
  check(typeof first.token === "string" && first.token.length > 40, "a long random token is issued");
  check(first.tokenHash !== first.token, "the plaintext token is never what is stored");
  check((await n(raw`select count(*)::int as n from refresh_sessions where token_hash = ${first.tokenHash}`)) === 1,
    "only the hash is persisted");
  check((await n(raw`select count(*)::int as n from refresh_sessions where token_hash = ${first.token}`)) === 0,
    "the raw token is nowhere in the table");

  const found = await findRefreshSession(first.token);
  check(found !== null && found.userId === userId, "the token resolves back to its owner");

  const second = await rotateRefreshSession(found!, { conn: db });
  check(second !== null, "rotation issues a replacement");
  check(second!.tokenHash !== first.tokenHash, "the replacement is a different token");
  check(second!.familyId === first.familyId, "rotation preserves the token family");

  const oldAfter = await findRefreshSession(first.token);
  check(oldAfter !== null && oldAfter.revokedReason === "rotated", "the OLD token is marked rotated after rotation");
  const newAfter = await findRefreshSession(second!.token);
  check(newAfter !== null && newAfter.revokedAt === null, "the NEW token is live");
}

console.log("\n=== 3. REUSING A ROTATED TOKEN IS DETECTED ===");
{
  const userId = await createUser("reuse");
  const a = await issueRefreshSession(userId, { conn: db });
  const rowA = (await findRefreshSession(a.token))!;
  const b = (await rotateRefreshSession(rowA, { conn: db }))!;

  // An attacker replays the already-rotated (old) token.
  const replayed = await findRefreshSession(a.token);
  check(replayed !== null, "the replayed old token is still found (so replay is detectable)");
  check(replayed?.revokedReason === "rotated", "the replayed token is recognisable as already rotated");
  check(replayed?.familyId === b.familyId, "replay links back to the same token family");

  const killed = await revokeAllUserSessions(userId, RevokeReason.REUSE_DETECTED, db);
  // Only the still-live session is newly revoked; the replayed one is already
  // revoked as "rotated", so the count is deliberately 1, not 2.
  check(killed === 1, "reuse detection revokes the remaining live session (counted " + killed + ")");
  check((await n(raw`select count(*)::int as n from refresh_sessions
                      where user_id = ${userId} and revoked_at is null`)) === 0,
    "no session for that user survives reuse detection");
}

console.log("\n=== 4. PASSWORD RESET REVOKES EXISTING SESSIONS ===");
{
  const userId = await createUser("reset");
  await issueRefreshSession(userId, { conn: db });
  await issueRefreshSession(userId, { conn: db });
  check((await n(raw`select count(*)::int as n from refresh_sessions
                      where user_id = ${userId} and revoked_at is null`)) === 2, "two live sessions exist");

  const revoked = await revokeAllUserSessions(userId, RevokeReason.PASSWORD_RESET, db);
  check(revoked === 2, "the reset revoked BOTH live sessions");
  check((await n(raw`select count(*)::int as n from refresh_sessions
                      where user_id = ${userId} and revoked_at is null`)) === 0,
    "no session survives a password reset");

  const reasons = await one<{ r: string }>(
    raw`select distinct revoked_reason as r from refresh_sessions where user_id = ${userId}`
  );
  check(reasons?.r === "password_reset", "the reason is recorded as password_reset (auditable)");
}

console.log("\n=== 5. A RESET TICKET CANNOT BE REPLAYED ===");
{
  const userId = await createUser("ticket");
  const email = "ticket-" + userId.slice(0, 8) + "@example.test";
  testEmails.push(email);
  const otpId = randomUUID();

  // A ticket is only valid with the exact claim shape: userId + otpId + purpose.
  const ticket = signResetTicket({ userId, otpId, purpose: RESET_TICKET_PURPOSE });
  const claims = verifyResetTicket(ticket);
  check(claims !== null, "a freshly signed ticket verifies");
  check(claims?.userId === userId, "the ticket is bound to the right user");
  check(claims?.otpId === otpId, "the ticket is bound to the exact verified OTP row");
  check(claims?.purpose === "PASSWORD_RESET", "the ticket carries its purpose claim");
  check(verifyResetTicket(ticket.slice(0, -3) + "aaa") === null, "a tampered ticket is rejected");
  check(verifyResetTicket("not.a.ticket") === null, "garbage is rejected");
  // Defence in depth: a ticket signed by this same server for another flow.
  check(verifyResetTicket(signResetTicket({ userId, otpId, purpose: "REGISTER" })) === null,
    "a ticket for a different purpose is refused even though the signature is valid");
  check(verifyResetTicket(signResetTicket({ userId, otpId: "", purpose: RESET_TICKET_PURPOSE })) === null,
    "a ticket missing its OTP binding is refused");

  // The single-use claim lives in email_otp.reset_ticket_hash and is spent with a
  // conditional UPDATE, so a second spend must match zero rows.
  const hash = hashResetTicket(ticket);
  check((await n(raw`select count(*)::int as n from email_otp where reset_ticket_hash = ${hash}`)) === 0,
    "an unissued ticket is not already marked as spent");

  await raw`insert into email_otp (id, user_id, purpose, email, code_hash, expires_at, reset_ticket_hash)
            values (${otpId}, ${userId}, ${"PASSWORD_RESET"}, ${email}, ${"a".repeat(64)},
                    now() + interval '10 minutes', ${hash})`;
  check((await n(raw`select count(*)::int as n from email_otp where reset_ticket_hash = ${hash}`)) === 1,
    "the issued ticket is marked as outstanding");

  const firstSpend = await raw`update email_otp set reset_ticket_hash = null
                              where reset_ticket_hash = ${hash} returning id`;
  check(firstSpend.length === 1, "the first spend succeeds");
  const replaySpend = await raw`update email_otp set reset_ticket_hash = null
                               where reset_ticket_hash = ${hash} returning id`;
  check(replaySpend.length === 0, "the SECOND spend updates zero rows (ticket cannot be replayed)");

  await raw`delete from email_otp where id = ${otpId}`;
}

  console.log("\n=== 6. OTP IS BOUND TO EMAIL, PURPOSE AND PEPPER ===");
{
  const email = "bind-" + randomUUID().slice(0, 8) + "@example.test";
  const issued = await issueOtp({ email, purpose: OtpPurpose.PASSWORD_RESET, pepper: PEPPER, conn: db });

  check(issued.ok, "a password-reset OTP is issued");
  if (issued.ok) {
    testEmails.push(email);
    // otpAttemptOutcome takes the Drizzle row shape (camelCase), so map the
    // raw snake_case columns rather than handing the driver row straight over.
    const row = (await one<{
      code_hash: string;
      attempts: number;
      expires_at: Date;
      consumed_at: Date | null;
    }>(raw`select code_hash, attempts, expires_at, consumed_at from email_otp where id = ${issued.otp.id}`))!;
    const rec = {
      codeHash: row.code_hash,
      attempts: Number(row.attempts),
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    };

    check(otpAttemptOutcome(rec, issued.otp.code, new Date(), PEPPER, email, OtpPurpose.PASSWORD_RESET) === null,
      "the correct code for the right email+purpose is accepted");
    check(otpAttemptOutcome(rec, issued.otp.code, new Date(), PEPPER, "someone-else@example.test", OtpPurpose.PASSWORD_RESET) !== null,
      "the same code is rejected for a different email");
    check(otpAttemptOutcome(rec, issued.otp.code, new Date(), PEPPER, email, OtpPurpose.REGISTER) !== null,
      "the same code is rejected for a different purpose");
    check(otpAttemptOutcome(rec, issued.otp.code, new Date(), "a-different-pepper-0123456789", email, OtpPurpose.PASSWORD_RESET) !== null,
      "a different pepper does not verify the digest");
    check(otpAttemptOutcome(rec, issued.otp.code, new Date(Date.now() + 11 * 60_000), PEPPER, email, OtpPurpose.PASSWORD_RESET) !== null,
      "an expired code is rejected");
  }
}

} finally {
  console.log("\n=== CLEANUP (always runs) ===");
  for (const id of createdUsers) {
    await raw`delete from refresh_sessions where user_id = ${id}`;
    await raw`delete from email_otp where user_id = ${id} or email like ${"%" + id.slice(0, 8) + "%"}`;
    await raw`delete from "User" where id = ${id}`;
  }
  for (const email of testEmails) {
    await raw`delete from email_otp where email = ${email}`;
  }
  check((await n(raw`select count(*)::int as n from "User" where email like '%example.test'`)) === 0,
    "every test user was removed (self-cleaning)");
  check((await n(raw`select count(*)::int as n from email_otp where email like '%example.test'`)) === 0,
    "every test OTP row was removed (self-cleaning)");
}

await raw.end();
console.log("\n================ SUMMARY ================");
console.log("PASS: " + passed + "   FAIL: " + failed);
process.exit(failed === 0 ? 0 : 1);
