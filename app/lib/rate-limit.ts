// PostgreSQL-backed rate limiting for the auth routes (login + register).
//
// FAIL-OPEN BY DESIGN: every DB helper here catches its own errors and returns
// a safe default (never throws). If the auth_rate_limits table does not exist
// yet (pre-migration deployment) or the database hiccups, requests are allowed
// through — rate limiting is mitigation, it must never be a user-facing 500.
//
// Pure constants, key builders, IP extraction, the decision function and the
// rateLimitResponse builder live in rate-limit-core.ts (no DB dependency) so
// unit tests can pin the boundary math without pulling in drizzle/PostgreSQL.
export {
  RATE_LIMIT_WINDOW_MS,
  LOGIN_EMAIL_RATE_LIMIT,
  LOGIN_IP_RATE_LIMIT,
  REGISTER_IP_RATE_LIMIT,
  RATE_LIMIT_PURGE_CHANCE,
  RATE_LIMIT_MAX_AGE_MS,
  loginIpKey,
  loginEmailKey,
  registerIpKey,
  clientIpFromRequest,
  evaluateRateLimit,
  rateLimitResponse,
} from "./rate-limit-core";

import { RATE_LIMIT_MAX_AGE_MS, RATE_LIMIT_WINDOW_MS } from "./rate-limit-core";
import { sql } from "drizzle-orm";
import { db } from "~/lib/drizzle-db";
import { authRateLimits } from "~/db/schema";

// ---------------------------------------------------------------------------
// DB helpers (all fail-open, all atomic)
// ---------------------------------------------------------------------------

export interface RateLimitRecordRow {
  attempts: number;
  windowStartedAt: Date;
}

/**
 * Atomically bump a rate-limit key's counter inside its window.
 *   - no row yet      -> insert attempts=1, window=now
 *   - window expired  -> reset attempts=1, window=now
 *   - window active   -> attempts+1 (row untouched)
 * Returns the post-increment row. Fail-open: on any DB error returns
 * attempts=0 (the caller treats the request as allowed).
 */
export async function incrementRateLimit(
  key: string
): Promise<RateLimitRecordRow> {
  try {
    const rows = await db
      .insert(authRateLimits)
      .values({ key, attempts: 1 })
      .onConflictDoUpdate({
        target: authRateLimits.key,
        set: {
          attempts: sql`CASE WHEN ${authRateLimits.windowStartedAt} < now() - make_interval(secs => ${RATE_LIMIT_WINDOW_MS / 1000}) THEN 1 ELSE ${authRateLimits.attempts} + 1 END`,
          windowStartedAt: sql`CASE WHEN ${authRateLimits.windowStartedAt} < now() - make_interval(secs => ${RATE_LIMIT_WINDOW_MS / 1000}) THEN now() ELSE ${authRateLimits.windowStartedAt} END`,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        attempts: authRateLimits.attempts,
        windowStartedAt: authRateLimits.windowStartedAt,
      });
    return (rows[0] ?? { attempts: 0, windowStartedAt: new Date() }) as {
      attempts: number;
      windowStartedAt: Date;
    };
  } catch {
    return { attempts: 0, windowStartedAt: new Date() };
  }
}

/**
 * Clear a rate-limit key entirely (login success resets an ACCOUNT's own email
 * budget). Fail-open (no-op on error).
 */
export async function clearRateLimit(key: string): Promise<void> {
  try {
    await db
      .delete(authRateLimits)
      .where(sql`${authRateLimits.key} = ${key}`);
  } catch {
    // fail-open: nothing to clear is fine.
  }
}

/**
 * Roll back the CURRENT request's own per-IP attempt after a successful login.
 *
 * The IP bucket is credential-spray protection shared across ALL emails, so a
 * success must NOT wipe prior failures made from the same IP — it only undoes
 * the reservation THIS request made (each successful login incremented the IP
 * bucket before bcrypt). Concurrent-safe and never negative:
 *   - attempts >= 2 -> attempts - 1 (prior failures stay in place);
 *   - attempts <= 1 -> row deleted (a lone reservation disappears entirely).
 * Implemented as two atomic statements; the UPDATE is attempted first and the
 * DELETE only fires when the UPDATE matched nothing (guarded by RETURNING, so a
 * bucket holding prior failures + leftover reservations is never over-deleted).
 * Fail-open: on any DB error the counter is simply left as-is.
 */
export async function rollbackRateLimit(key: string): Promise<void> {
  try {
    const updated = await db
      .update(authRateLimits)
      .set({
        attempts: sql`${authRateLimits.attempts} - 1`,
        updatedAt: sql`now()`,
      })
      .where(
        sql`${authRateLimits.key} = ${key} AND ${authRateLimits.attempts} >= 2`
      )
      .returning({ key: authRateLimits.key })
      .execute();
    if (updated.length === 0) {
      await db
        .delete(authRateLimits)
        .where(
          sql`${authRateLimits.key} = ${key} AND ${authRateLimits.attempts} <= 1`
        );
    }
  } catch {
    // fail-open.
  }
}

/**
 * Probabilistic cleanup of long-idle rate-limit rows (~1/50 requests). Keeps
 * the table small without a fixed frequency; old windows are already neutral.
 */
export async function purgeStaleRateLimits(
  chance = 1 / 50
): Promise<void> {
  if (Math.random() >= chance) return;
  const cutoff = new Date(Date.now() - RATE_LIMIT_MAX_AGE_MS);
  try {
    await db
      .delete(authRateLimits)
      .where(sql`${authRateLimits.updatedAt} < ${cutoff}`);
  } catch {
    // fail-open.
  }
}