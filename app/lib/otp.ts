// One-time passwords (email_otp) for registration verification and password reset.
//
// WHY A HASHED, PEPPERED OTP
// A 6-digit code has only 1,000,000 possible values. Storing a bare SHA-256 of
// it would be WORTHLESS: an attacker with a database dump could simply hash all
// a million candidates in seconds and recover every outstanding code. So the
// stored digest is:
//
//     sha256(pepper + ":" + email + ":" + purpose + ":" + code)
//
// where `pepper` is a server-only secret (JWT_SECRET). The dump alone now
// reveals nothing usable, because the pepper is never stored beside the rows.
// Binding the email and purpose into the digest also means a code issued for
// registration can never be replayed against password reset, and a code issued
// for alice@example.com can never verify for bob@example.com — without any extra
// lookup or join.
//
// OTHER GUARANTEES
//   * Codes come from crypto.randomInt, which is rejection-sampled and therefore
//     uniform. `Math.random()` is never used: it is predictable, and a
//     predictable OTP is not an OTP.
//   * The plaintext code exists only in the response of the issuing request (and
//     only when AUTH_DEV_SHOW_OTP=true) and in the user's browser. It is never
//     persisted, never logged, and never placed in an audit row (audit-log.ts
//     additionally redacts otp/code_hash/ticket-shaped keys).
//   * Failed verification is bounded: after OTP_MAX_VERIFY_ATTEMPTS wrong guesses
//     the code is burned even if the real code arrives afterwards, so a 6-digit
//     space cannot be ground down inside one code's lifetime. That is the entire
//     reason the attempt counter lives on the row rather than in a rate limiter.
//   * A resend REPLACES the outstanding row for that (email, purpose), so only
//     the newest code can ever verify and an intercepted old code dies the
//     moment a new one is issued.

import {
  createHash,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "./drizzle-db";
import { emailOtps } from "../db/schema";
import { safeErrorLog } from "./safe-error-log";

/** 6 digits: 1,000,000 possible values, which is why attempts are capped. */
export const OTP_CODE_LENGTH = 6;

/** A code is valid for 10 minutes. */
export const OTP_TTL_SECONDS = 10 * 60;

/** Minimum gap between two codes for the same (email, purpose). */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/** Wrong guesses allowed per issued code before it is burned. */
export const OTP_MAX_VERIFY_ATTEMPTS = 5;

/** Explicit opt-in for exposing the generated code in the API response. */
export const DEV_OTP_ENV_FLAG = "AUTH_DEV_SHOW_OTP";

/** Mirrored by chk_email_otp_purpose (migration 0029). */
export const OtpPurpose = {
  REGISTER: "REGISTER",
  PASSWORD_RESET: "PASSWORD_RESET",
} as const;
export type OtpPurposeValue = (typeof OtpPurpose)[keyof typeof OtpPurpose];

/** Why an OTP verification attempt did not succeed. */
export const OtpRejection = {
  MALFORMED: "OTP_MALFORMED",
  NOT_FOUND: "OTP_NOT_FOUND",
  EXPIRED: "OTP_EXPIRED",
  ALREADY_USED: "OTP_ALREADY_USED",
  TOO_MANY_ATTEMPTS: "OTP_TOO_MANY_ATTEMPTS",
  MISMATCH: "OTP_MISMATCH",
} as const;
export type OtpRejectionValue = (typeof OtpRejection)[keyof typeof OtpRejection];

/** Why an OTP could not be issued right now. */
export const OtpIssueRejection = {
  COOLDOWN: "OTP_COOLDOWN",
  MALFORMED_EMAIL: "OTP_MALFORMED_EMAIL",
} as const;
/** A pooled connection or an open transaction, so helpers can compose. */
type Conn = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OtpIssueRejectionValue =
  (typeof OtpIssueRejection)[keyof typeof OtpIssueRejection];

export interface OtpRow {
  id: string;
  userId: string | null;
  purpose: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
  createdAt: Date;
  lastSentAt: Date;
}

export interface IssuedOtp {
  id: string;
  email: string;
  purpose: OtpPurposeValue;
  /** Plaintext code. NEVER persisted, logged or audited. */
  code: string;
  expiresAt: Date;
  ttlSeconds: number;
  resendAfterSeconds: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB, no env) — unit-testable without a database.
// ---------------------------------------------------------------------------

/**
 * The server-side pepper.
 *
 * JWT_SECRET is the app's one mandatory server-only secret, so reusing it means
 * no new secret to provision and no risk of a second secret being left unset in
 * some deployment (a missing pepper must fail LOUDLY, never silently degrade to
 * an unpeppered hash).
 */
export function otpPepper(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.JWT_SECRET;
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error(
      "JWT_SECRET must be configured (at least 16 characters) before OTPs can be issued or verified"
    );
  }
  return secret;
}

/**
 * A uniform 6-digit numeric code.
 *
 * randomInt performs rejection sampling internally, so every value in
 * [0, 1000000) is equally likely — there is no modulo bias. This is the ONLY
 * source of OTP randomness in the app; there is no hardcoded or fallback code
 * anywhere, so a "default" 123456 can never ship.
 */
export function generateOtpCode(digits: number = OTP_CODE_LENGTH): string {
  if (!Number.isInteger(digits) || digits < 4 || digits > 10) {
    throw new Error(`generateOtpCode: unsupported digit count ${digits}`);
  }
  const max = 10 ** digits;
  return String(randomInt(0, max)).padStart(digits, "0");
}

/** Exactly `digits` ASCII digits — no spaces, signs, letters or unicode digits. */
export function isValidOtpFormat(
  code: unknown,
  digits: number = OTP_CODE_LENGTH
): code is string {
  if (typeof code !== "string") return false;
  return new RegExp(`^[0-9]{${digits}}$`).test(code);
}

/**
 * The peppered digest that is actually stored.
 * The plaintext `code` must NOT be retained by the caller after this call.
 */
export function hashOtpCode(
  email: string,
  purpose: OtpPurposeValue,
  code: string,
  pepper: string
): string {
  return createHash("sha256")
    .update(`${pepper}:${email}:${purpose}:${code}`, "utf8")
    .digest("hex");
}

/**
 * Constant-time digest comparison.
 *
 * A plain `===` returns as soon as two bytes differ, which lets an attacker
 * time their way to a correct digest prefix. timingSafeEqual removes that signal;
 * the explicit length guards exist only because timingSafeEqual throws on
 * mismatched lengths.
 */
export function safeCompareOtpHash(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Whether the API may echo the generated code back to the caller.
 *
 * EXPLICIT OPT-IN ONLY. This deliberately does NOT fall back to NODE_ENV: a
 * staging deployment running with NODE_ENV=production must not leak codes, and
 * a developer on a NODE_ENV=development box must not have to guess that a
 * production-looking host is actually safe. The single, auditable switch is
 * AUTH_DEV_SHOW_OTP=true, and it is a SERVER variable so the browser can never
 * influence it.
 */
export function isDevOtpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DEV_OTP_ENV_FLAG];
  if (typeof raw !== "string") return false;
  return raw.trim().toLowerCase() === "true";
}

/** Absolute expiry for a code issued at `issuedAt`. */
export function otpExpiry(
  issuedAt: Date,
  ttlSeconds: number = OTP_TTL_SECONDS
): Date {
  return new Date(issuedAt.getTime() + ttlSeconds * 1000);
}

/**
 * Seconds the caller must wait before requesting another code.
 * Returns 0 when the cooldown has already elapsed.
 */
export function resendCooldownRemaining(
  lastSentAt: Date,
  now: Date,
  cooldownSeconds: number = OTP_RESEND_COOLDOWN_SECONDS
): number {
  const elapsed = Math.floor((now.getTime() - lastSentAt.getTime()) / 1000);
  return Math.max(0, cooldownSeconds - elapsed);
}

/** Whether a stored row is still verifiable right now. */
export function isOtpUsable(
  row: Pick<OtpRow, "consumedAt" | "expiresAt" | "attempts">,
  now: Date
): { usable: boolean; reason?: OtpRejectionValue } {
  if (row.consumedAt !== null) return { usable: false, reason: OtpRejection.ALREADY_USED };
  if (row.expiresAt.getTime() <= now.getTime()) {
    return { usable: false, reason: OtpRejection.EXPIRED };
  }
  if (row.attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
    return { usable: false, reason: OtpRejection.TOO_MANY_ATTEMPTS };
  }
  return { usable: true };
}

/**
 * Why a verification attempt failed, without leaking WHICH check failed to the
 * end user. The UI shows one generic message; the specific reason goes to the
 * audit log so an operator can still see a replay pattern.
 */
export function otpAttemptOutcome(
  row: Pick<OtpRow, "codeHash" | "consumedAt" | "expiresAt" | "attempts">,
  submittedCode: string,
  now: Date,
  pepper: string,
  email: string,
  purpose: OtpPurposeValue
): OtpRejectionValue | null {
  if (!isValidOtpFormat(submittedCode)) return OtpRejection.MALFORMED;
  const usability = isOtpUsable(row, now);
  if (!usability.usable) return usability.reason ?? OtpRejection.NOT_FOUND;
  const expected = hashOtpCode(email, purpose, submittedCode, pepper);
  return safeCompareOtpHash(expected, row.codeHash) ? null : OtpRejection.MISMATCH;
}

// ---------------------------------------------------------------------------
// DB-backed operations
// ---------------------------------------------------------------------------

/** The outstanding (unconsumed) code for this (email, purpose), if any. */
export async function findOutstandingOtp(
  email: string,
  purpose: OtpPurposeValue,
  conn: Conn = db
): Promise<OtpRow | null> {
  const rows = await conn
    .select()
    .from(emailOtps)
    .where(
      and(
        eq(emailOtps.email, email),
        eq(emailOtps.purpose, purpose),
        isNull(emailOtps.consumedAt)
      )
    )
    .limit(1);
  return (rows[0] as OtpRow | undefined) ?? null;
}

/**
 * Serialise concurrent code issuance for one (email, purpose).
 *
 * WHY THIS IS NEEDED
 * "Replace the outstanding code so only the newest can verify" is a read-then-write
 * invariant, and read-then-write is not atomic. Two simultaneous requests could
 * both read "no outstanding row", both INSERT, and leave two live codes for the
 * same address — which is exactly the interception window the replacement
 * behaviour exists to close. Cooldown enforcement had the same hole: two requests
 * arriving together both saw the cooldown as elapsed.
 *
 * A transaction-scoped advisory lock keyed on (email, purpose) closes both holes
 * without inventing a schema constraint. It is per (address, flow) rather than
 * global, so unrelated users never block each other, and it is released
 * automatically at COMMIT or ROLLBACK so a crashed request cannot wedge the flow.
 *
 * NOTE: the lock only serialises requests that go through this function. That is
 * the intent — every issuance path in the app does.
 */
async function lockOtpSlot(
  email: string,
  purpose: OtpPurposeValue,
  conn: Conn
): Promise<void> {
  await conn.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${email}|${purpose}`}, 0))`
  );
}

/**
 * Issue a NEW code, replacing any outstanding one for the same (email, purpose).
 *
 * Reuse of `id` makes this an UPSERT: a resend therefore cannot leave two
 * simultaneously-valid codes behind (which would let an intercepted old code
 * keep working), and it keeps the table from growing per resend attempt.
 *
 * ATOMICITY
 * The cooldown check and the write are one unit, serialised by an advisory lock
 * (see lockOtpSlot) so two concurrent requests can never both decide to issue.
 *
 * IMPORTANT (this app runs postgres with `max: 1`): every statement in here must
 * use `conn`. A single query issued against the module-level `db` from inside a
 * transaction would wait for the one pooled connection the transaction is already
 * holding, and deadlock forever. `findOutstandingOtp` therefore takes the conn too.
 */
export async function issueOtp(
  params: {
    email: string;
    purpose: OtpPurposeValue;
    userId?: string | null;
    now?: Date;
    ttlSeconds?: number;
    cooldownSeconds?: number;
    pepper: string;
    conn?: Conn;
  }
): Promise<{ ok: true; otp: IssuedOtp } | { ok: false; reason: OtpIssueRejectionValue; retryAfterSeconds: number }> {
  const now = params.now ?? new Date();
  const ttlSeconds = params.ttlSeconds ?? OTP_TTL_SECONDS;
  const cooldownSeconds = params.cooldownSeconds ?? OTP_RESEND_COOLDOWN_SECONDS;

  const run = async (conn: Conn): Promise<
    | { ok: true; otp: IssuedOtp }
    | { ok: false; reason: OtpIssueRejectionValue; retryAfterSeconds: number }
  > => {
    await lockOtpSlot(params.email, params.purpose, conn);

    const existing = await findOutstandingOtp(
      params.email,
      params.purpose,
      conn
    );
    if (existing) {
      const wait = resendCooldownRemaining(
        existing.lastSentAt,
        now,
        cooldownSeconds
      );
      if (wait > 0) {
        return {
          ok: false,
          reason: OtpIssueRejection.COOLDOWN,
          retryAfterSeconds: wait,
        };
      }
    }

    const code = generateOtpCode();
    const codeHash = hashOtpCode(
      params.email,
      params.purpose,
      code,
      params.pepper
    );
    const expiresAt = otpExpiry(now, ttlSeconds);
    const id = existing?.id ?? randomUUID();

    const values = {
      userId: params.userId ?? null,
      purpose: params.purpose,
      email: params.email,
      codeHash,
      expiresAt,
      consumedAt: null,
      attempts: 0,
      createdAt: existing?.createdAt ?? now,
      lastSentAt: now,
    };

    if (existing) {
      await conn
        .update(emailOtps)
        .set(values)
        .where(eq(emailOtps.id, id))
        .execute();
    } else {
      await conn.insert(emailOtps).values({ id, ...values }).execute();
    }

    return {
      ok: true,
      otp: {
        id,
        email: params.email,
        purpose: params.purpose,
        code,
        expiresAt,
        ttlSeconds,
        resendAfterSeconds: cooldownSeconds,
      },
    };
  };

  // Reuse the caller's transaction when there is one; otherwise open our own so
  // the lock, the read and the write commit as a single unit.
  if (params.conn) return run(params.conn);
  return db.transaction((tx) => run(tx));
}

/**
 * Increment the failure counter for a row.
 *
 * Once the counter reaches the cap the row is CONSUMED, which permanently burns
 * that code. This is the mitigation that makes a 1,000,000-value space safe to
 * expose: the attacker gets 5 guesses per issued code, not 5 guesses ever.
 */
export async function recordFailedOtpAttempt(
  id: string,
  conn: Conn = db
): Promise<number> {
  const rows = await conn
    .update(emailOtps)
    .set({ attempts: sql`${emailOtps.attempts} + 1` })
    .where(eq(emailOtps.id, id))
    .returning({ attempts: emailOtps.attempts });
  const attempts = rows[0]?.attempts ?? OTP_MAX_VERIFY_ATTEMPTS;
  if (attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
    // Burn it: the SQL increment is atomic, so even concurrent misses cannot
    // push the counter past the cap unnoticed.
    await conn
      .update(emailOtps)
      .set({ consumedAt: sql`coalesce(${emailOtps.consumedAt}, now())` })
      .where(eq(emailOtps.id, id))
      .execute();
  }
  return attempts;
}

/** Mark a code used. Idempotent-safe: a consumed row stays consumed. */
export async function consumeOtp(
  id: string,
  now: Date = new Date(),
  conn: Conn = db
): Promise<void> {
  await conn
    .update(emailOtps)
    .set({ consumedAt: now })
    .where(and(eq(emailOtps.id, id), isNull(emailOtps.consumedAt)))
    .execute();
}

/**
 * Best-effort purge of codes that can no longer verify.
 *
 * `before` is a cutoff, not "now": callers pass a grace point such as
 * "one hour after expiry" so a just-expired code remains available for audit
 * inspection before it is removed. Never called from a request path.
 *
 * ONLY rows that are provably dead are removed:
 *   * expired before the cutoff, or
 *   * CONSUMED before the cutoff (including burned-by-attempts codes).
 *
 * A still-valid outstanding code is NEVER deleted, no matter how old it was
 * created. An earlier version of this predicate also matched
 * `created_at < before`, which with the default cutoff deleted every code created
 * more than a moment ago — silently destroying a user's in-progress signup or
 * password reset. Reclaiming space is not worth breaking a live flow.
 */
export async function purgeStaleOtps(before: Date = new Date()): Promise<number> {
  try {
    const deleted = await db
      .delete(emailOtps)
      .where(
        or(
          lt(emailOtps.expiresAt, before),
          and(isNotNull(emailOtps.consumedAt), lt(emailOtps.consumedAt, before))
        )
      )
      .returning({ id: emailOtps.id });
    return deleted.length;
  } catch (error) {
    console.error("purgeStaleOtps: failed", safeErrorLog(error));
    return 0;
  }
}
