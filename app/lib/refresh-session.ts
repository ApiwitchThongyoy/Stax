// Long-lived refresh sessions (DB-backed, opaque token + HttpOnly cookie).
//
// WHY THIS EXISTS
// The access JWT is deliberately SHORT-LIVED now (ACCESS_TOKEN_EXPIRY in
// app/routes/api/auth/login.ts). A short access token is only safe if the user
// can obtain a fresh one without retyping their password โ€” that is the refresh
// session. Without it, being logged out after 15 idle minutes would be a
// regression, and "keep me signed in" would be impossible.
//
// THE SECURITY MODEL (the whole point of this file)
//   1. The browser holds an OPAQUE random token, never a JWT, and only inside an
//      HttpOnly cookie so page JavaScript cannot read it. An XSS payload cannot
//      exfiltrate the session.
//   2. The server stores ONLY sha256(token). A database dump yields no usable
//      credential: the digest cannot be reversed into the token, and it is not
//      itself accepted by the lookup (which hashes the incoming value first).
//   3. Every refresh ROTATES: the presented row is revoked and a brand-new token
//      is issued in the same `familyId`. Rotation is what makes theft
//      detectable: if an attacker presents an already-rotated token we see a
//      revoked row for a live session and revoke the ENTIRE family, logging out
//      the legitimate holder too. That is the correct trade-off โ€” reusing a
//      rotated token is proof of compromise, and silently serving it would leave
//      the victim permanently shadowed.
//   4. Every operation re-reads the authoritative user from the DB and honours
//      suspension. A refresh cookie can never resurrect a suspended account.
//   5. Revocation is explicit and audited: logout revokes one session, a
//      password reset revokes all of them.
//
// Cookie scope: Path is limited to /api/v1/auth, so the browser never attaches
// the session to ordinary API calls or to static asset requests โ€” a stolen or
// misrouted request cannot leak it. SameSite=Lax still sends it on top-level
// navigations so a reload works, while blocking cross-site POST/CSRF.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "./drizzle-db";
import { refreshSessions } from "../db/schema";
import { safeErrorLog } from "./safe-error-log";

/** Cookie name for the refresh session. HttpOnly + SameSite=Lax + path-scoped. */
export const REFRESH_COOKIE_NAME = "stax_refresh";

/**
 * Cookie Path. Deliberately narrow: only the auth endpoints that actually need
 * the cookie receive it, so it is never attached to /api/v1/ledger, /api/v1/reports,
 * asset requests, etc.
 */
export const REFRESH_COOKIE_PATH = "/api/v1/auth";

/** Access-token lifetime. Mirrors ACCESS_TOKEN_EXPIRY in app/routes/api/auth/login.ts. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Refresh-session lifetime (sliding: reset on every rotation). */
export const REFRESH_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Refresh early by this much so an in-flight request never races expiry. */
export const REFRESH_SESSION_RENEWAL_WINDOW_SECONDS = ACCESS_TOKEN_TTL_SECONDS;

/** Refresh tokens are opaque: 48 random bytes -> 64 base64url characters. */
const REFRESH_TOKEN_BYTES = 48;

/** sha256 hex digest length; asserted by the refresh_sessions code path. */
export const TOKEN_HASH_LENGTH = 64;

/**
 * Closed set of revocation reasons. Mirrored by chk_refresh_sessions_revoked_reason
 * (migration 0029) โ€” a value outside this set would be rejected by the DB.
 */
export const RevokeReason = {
  ROTATED: "rotated",
  LOGOUT: "logout",
  REUSE_DETECTED: "reuse_detected",
  PASSWORD_RESET: "password_reset",
  ACCOUNT_SUSPENDED: "account_suspended",
  EXPIRED: "expired",
} as const;
export type RevokeReasonValue = (typeof RevokeReason)[keyof typeof RevokeReason];

/** Why a presented refresh token was not usable. Drives the 401 code + audit. */
export const RefreshRejection = {
  MISSING: "REFRESH_MISSING",
  UNKNOWN: "REFRESH_UNKNOWN",
  REVOKED: "REFRESH_REVOKED",
  EXPIRED: "REFRESH_EXPIRED",
  USER_GONE: "REFRESH_USER_GONE",
} as const;
export type RefreshRejectionValue =
  (typeof RefreshRejection)[keyof typeof RefreshRejection];

export type RevokeReasonInput = RevokeReasonValue;

/** A pooled connection or an open transaction, so helpers can compose. */
type Conn = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface RefreshSessionIssue {
  /** Plaintext token. Returned to the caller ONCE, to be set as the cookie. */
  token: string;
  /** sha256(token) hex โ€” what actually gets persisted. */
  tokenHash: string;
  id: string;
  familyId: string;
  expiresAt: Date;
  maxAgeSeconds: number;
}

export interface RefreshSessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  createdAt: Date;
  lastUsedAt: Date;
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB, no clock) โ€” unit-testable without a database.
// ---------------------------------------------------------------------------

/** 48 cryptographically random bytes, base64url encoded. */
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
}

/** sha256 hex digest of the opaque token. This is the ONLY form ever stored. */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hex digests.
 *
 * A naive `===` on a hash leaks its prefix through timing, which turns an
 * online 6-hex-nibble search into a measurable signal; timingSafeEqual closes
 * that. Both sides are re-encoded as Buffers so the comparison is genuinely
 * constant-time over equal-length inputs (timingSafeEqual throws on a length
 * mismatch, hence the explicit length guard first).
 */
export function safeCompareHash(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Absolute expiry for a session issued at `issuedAt` (sliding window). */
export function sessionExpiry(
  issuedAt: Date,
  ttlSeconds: number = REFRESH_SESSION_TTL_SECONDS
): Date {
  return new Date(issuedAt.getTime() + ttlSeconds * 1000);
}

/**
 * Whether `Secure` belongs on the cookie.
 *
 * A `Secure` cookie is REJECTED by browsers over plain http://, which would
 * break local development outright. Conversely, omitting it on any real host
 * would expose the session to network interception. So the decision keys off
 * loopback only โ€” never off NODE_ENV, which a deployment can get wrong:
 * loopback -> plain, every other host -> Secure.
 */
export function refreshCookieIsSecure(host: string | null | undefined): boolean {
  const hostname = (host ?? "").trim().toLowerCase();
  if (hostname === "") return true; // no Host header: fail safe.
  const bare = hostname.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const isLoopback =
    bare === "localhost" ||
    bare === "127.0.0.1" ||
    bare === "::1" ||
    bare === "0.0.0.0" ||
    /^127\.\d+\.\d+\.\d+$/.test(bare);
  return !isLoopback;
}

/**
 * Serialize the Set-Cookie header value.
 *
 * HttpOnly keeps the token out of reach of page JavaScript; SameSite=Lax blocks
 * cross-site POST while still allowing the top-level navigation a reload needs;
 * Max-Age bounds the browser copy to the same sliding window the DB enforces.
 */
export function buildRefreshCookieHeader(
  token: string,
  maxAgeSeconds: number,
  secure: boolean
): string {
  const parts = [
    `${REFRESH_COOKIE_NAME}=${token}`,
    `Path=${REFRESH_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Serialize the Set-Cookie header that clears the session cookie.
 *
 * The attributes MUST match the ones used when setting it (Path especially, and
 * Secure on non-loopback) or the browser keeps the original alongside the
 * deletion and the token stays live.
 */
export function buildClearRefreshCookieHeader(secure: boolean): string {
  const parts = [
    `${REFRESH_COOKIE_NAME}=`,
    `Path=${REFRESH_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Minimal cookie-parser: returns the raw value of `name`, or null. */
export function readCookieValue(
  cookieHeader: string | null | undefined,
  name: string = REFRESH_COOKIE_NAME
): string | null {
  if (!cookieHeader || typeof cookieHeader !== "string") return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (value === "") return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DB-backed operations
// ---------------------------------------------------------------------------

/**
 * Look up a session by the token the caller presented.
 * Returns null for absent, malformed or unknown tokens alike โ€” the caller
 * cannot distinguish "never existed" from "wrong guess".
 */
export async function findRefreshSession(
  token: string
): Promise<RefreshSessionRow | null> {
  if (typeof token !== "string" || token.length === 0) return null;
  const tokenHash = hashRefreshToken(token);
  const rows = await db
    .select()
    .from(refreshSessions)
    .where(eq(refreshSessions.tokenHash, tokenHash))
    .limit(1);
  return (rows[0] as RefreshSessionRow | undefined) ?? null;
}

/**
 * Revoke EVERY session in a rotation family. This is the reuse-detection
 * response: a revoked token being presented again means the secret leaked, so
 * the whole chain (including the token the honest user currently holds) dies.
 */
export async function revokeRefreshFamily(
  familyId: string,
  reason: RevokeReasonInput,
  conn: Conn = db
): Promise<number> {
  const revoked = await conn
    .update(refreshSessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(
      and(
        eq(refreshSessions.familyId, familyId),
        isNull(refreshSessions.revokedAt)
      )
    )
    .returning({ id: refreshSessions.id });
  return revoked.length;
}

/**
 * Revoke EVERY session belonging to a user.
 *
 * Called on explicit password change/reset: the old password may already be
 * compromised, so any session minted from it must stop working immediately โ€”
 * this is what makes "sign out everywhere" a guarantee rather than a request.
 */
export async function revokeAllUserSessions(
  userId: string,
  reason: RevokeReasonInput,
  conn: Conn = db
): Promise<number> {
  const revoked = await conn
    .update(refreshSessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(
      and(eq(refreshSessions.userId, userId), isNull(refreshSessions.revokedAt))
    )
    .returning({ id: refreshSessions.id });
  return revoked.length;
}

/** Revoke a single session row by id. Idempotent (already-revoked is a no-op). */
export async function revokeRefreshSession(
  id: string,
  reason: RevokeReasonInput,
  conn: Conn = db
): Promise<number> {
  const revoked = await conn
    .update(refreshSessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(
      and(eq(refreshSessions.id, id), isNull(refreshSessions.revokedAt))
    )
    .returning({ id: refreshSessions.id });
  return revoked.length;
}

/** Create a brand-new session in a FRESH family (a new login). */
export async function issueRefreshSession(
  userId: string,
  opts: {
    now?: Date;
    ttlSeconds?: number;
    familyId?: string;
    conn?: Conn;
  } = {}
): Promise<RefreshSessionIssue> {
  const conn = opts.conn ?? db;
  const now = opts.now ?? new Date();
  const ttlSeconds = opts.ttlSeconds ?? REFRESH_SESSION_TTL_SECONDS;
  const token = generateRefreshToken();
  const tokenHash = hashRefreshToken(token);
  const id = randomUUID();
  // A login starts a brand-new rotation chain; only a rotation reuses a familyId.
  const familyId = opts.familyId ?? randomUUID();
  const expiresAt = sessionExpiry(now, ttlSeconds);

  await conn
    .insert(refreshSessions)
    .values({
      id,
      userId,
      tokenHash,
      familyId,
      expiresAt,
      revokedAt: null,
      revokedReason: null,
      createdAt: now,
      lastUsedAt: now,
    })
    .execute();

  return { token, tokenHash, id, familyId, expiresAt, maxAgeSeconds: ttlSeconds };
}

/**
 * Atomically claim a session row for rotation: a conditional UPDATE that only
 * matches a still-live row.
 *
 * This is the concurrency primitive the whole rotation scheme rests on. The
 * caller's earlier SELECT told it what the row looked like, but between that read
 * and this write another request may already have rotated the same token. So the
 * claim re-asserts the precondition in the WHERE clause (`revoked_at IS NULL`) and
 * reports whether it actually won the row:
 *
 *   returns 1  -> this caller owns the rotation; nobody else can.
 *   returns 0  -> somebody else already rotated it, i.e. this is (or looks like) a
 *                 replay of a rotated token. The caller must NOT issue a successor
 *                 and must treat the cookie as compromised.
 */
async function claimLiveSession(
  id: string,
  reason: RevokeReasonInput,
  conn: Conn
): Promise<boolean> {
  const claimed = await conn
    .update(refreshSessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(refreshSessions.id, id), isNull(refreshSessions.revokedAt)))
    .returning({ id: refreshSessions.id });
  return claimed.length > 0;
}

/**
 * Rotate a session: atomically claim the presented row, then issue its successor
 * in the SAME family.
 *
 * WHY THE ORDER MATTERS (this was a real bug)
 * An earlier version issued the successor FIRST and revoked the predecessor
 * afterwards, guarded only by the caller's stale `revokedAt === null` read. Two
 * browser tabs refreshing at the same moment — or an attacker replaying a token
 * concurrently — would BOTH see a live row, BOTH mint a successor, and end up with
 * two valid tokens in one family. Reuse detection would never fire, because the
 * predecessor looked live to both callers. Rotation is the entire basis of
 * theft-detection, so that window was unacceptable.
 *
 * The fix is to make the claim a conditional write and do it first:
 *   1. claim the presented row (single atomic UPDATE, `revoked_at IS NULL`).
 *      Losing this race means somebody else is mid-rotation or replaying.
 *   2. only the winner issues the successor, inside the SAME transaction.
 *
 * Consequences that are intentional:
 *   * A concurrent second refresh gets null and is treated as a possible replay,
 *     which revokes the family. That is the safe default: it is far better to sign
 *     out one honest user for a moment than to let a stolen token keep working.
 *     The client is required to single-flight refresh calls for this reason.
 *   * If the successor INSERT fails, the whole transaction rolls back, including
 *     the claim — so the user's original token is still live and they are not left
 *     holding a cookie the server has already invalidated.
 *
 * Returns null when the row cannot be rotated (already claimed, revoked or
 * expired); the caller must then treat the cookie as unusable.
 */
export async function rotateRefreshSession(
  row: RefreshSessionRow,
  opts: { now?: Date; ttlSeconds?: number; conn?: Conn } = {}
): Promise<RefreshSessionIssue | null> {
  const now = opts.now ?? new Date();
  const ttlSeconds = opts.ttlSeconds ?? REFRESH_SESSION_TTL_SECONDS;
  // Cheap pre-checks that avoid opening a transaction for hopeless inputs. These
  // are NOT the security boundary — claimLiveSession below is.
  if (row.revokedAt !== null) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;

  const run = async (conn: Conn): Promise<RefreshSessionIssue | null> => {
    const won = await claimLiveSession(row.id, RevokeReason.ROTATED, conn);
    if (!won) return null; // Lost the race: do not mint a second successor.
    return issueRefreshSession(row.userId, {
      now,
      ttlSeconds,
      familyId: row.familyId,
      conn,
    });
  };

  // When the caller already owns a transaction it is responsible for the atomic
  // unit, so reuse it. Otherwise open one so claim+insert commit together.
  if (opts.conn) return run(opts.conn);
  return db.transaction((tx) => run(tx));
}

/** Record activity on a session (observability; never affects authorization). */
export async function touchRefreshSession(
  id: string,
  now: Date = new Date()
): Promise<void> {
  try {
    await db
      .update(refreshSessions)
      .set({ lastUsedAt: now })
      .where(eq(refreshSessions.id, id))
      .execute();
  } catch (error) {
    // Observability only: never fail a refresh because bookkeeping failed.
    console.error("touchRefreshSession: failed", safeErrorLog(error));
  }
}

/**
 * Best-effort purge of long-dead rows so the table does not grow without bound.
 *
 * Expiry is enforced on every read, so deleting these rows changes no
 * authorization decision โ€” it only reclaims space. Deliberately NOT called from
 * the request path (that would add a write to every refresh); it is invoked by
 * the scheduled maintenance entry point / one-shot script instead.
 */
export async function purgeExpiredRefreshSessions(
  olderThan: Date = new Date()
): Promise<number> {
  const deleted = await db
    .delete(refreshSessions)
    .where(
      or(
        lt(refreshSessions.expiresAt, olderThan),
        lt(refreshSessions.revokedAt, olderThan)
      )
    )
    .returning({ id: refreshSessions.id });
  return deleted.length;
}
