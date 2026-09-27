// POST /api/v1/auth/refresh — trade the HttpOnly refresh cookie for a new
// short-lived access token (and a rotated refresh cookie).
//
// WHY THIS ROUTE CARRIES THE MOST SECURITY WEIGHT
// It is the only endpoint that turns a long-lived credential into a working
// access token, so every failure mode is handled explicitly:
//
//   * No cookie            -> 401 REFRESH_MISSING
//   * Unknown token        -> 401 REFRESH_UNKNOWN   (a wrong guess and a
//                            never-existed token are indistinguishable, so the
//                            endpoint is not a token oracle)
//   * Revoked token        -> 401 REFRESH_REVOKED + THE WHOLE FAMILY IS REVOKED.
//                            A revoked row can only be presented if the secret
//                            leaked (or a concurrent request raced), so we treat
//                            it as compromise and kill the rotation chain — which
//                            also logs out the honest holder, the intended
//                            consequence of a suspected theft.
//   * Expired token        -> 401 REFRESH_EXPIRED  (marked "expired" so the audit
//                            trail distinguishes a normal 30-day logout from a
//                            rejected replay)
//   * User deleted         -> 401 REFRESH_USER_GONE
//   * User suspended       -> 403 ACCOUNT_SUSPENDED + the session is revoked.
//                            Suspension must win over a valid cookie: a
//                            suspended account can never be resurrected by
//                            refreshing, which is the whole point of suspending
//                            it.
//
// The access token is signed with the SAME secret/claims shape as login, so
// nothing downstream can tell a refreshed token from a freshly issued one — and
// nothing downstream needs to: verifyAuth is authoritative on every request.

import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/refresh";
import { db } from "~/lib/drizzle-db";
import { users } from "~/db/schema";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";
import { ACCOUNT_SUSPENDED_MESSAGE, ACCESS_TOKEN_AUDIENCE } from "~/lib/auth-middleware";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_COOKIE_NAME,
  RefreshRejection,
  buildClearRefreshCookieHeader,
  buildRefreshCookieHeader,
  findRefreshSession,
  readCookieValue,
  refreshCookieIsSecure,
  revokeRefreshFamily,
  revokeRefreshSession,
  revokeAllUserSessions,
  rotateRefreshSession,
  RevokeReason,
  touchRefreshSession,
  type RefreshRejectionValue,
} from "~/lib/refresh-session";
import {
  REFRESH_IP_RATE_LIMIT,
  clientIpFromRequest,
  evaluateRateLimit,
  incrementRateLimit,
  purgeStaleRateLimits,
  rateLimitResponse,
  refreshIpKey,
} from "~/lib/rate-limit";
import { safeErrorLog } from "~/lib/safe-error-log";

const ACCESS_TOKEN_EXPIRY = `${ACCESS_TOKEN_TTL_SECONDS}s`;

export async function loader(_: Route.LoaderArgs) {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

/** Uniform 401 for every unusable cookie: never confirm which secret existed. */
function rejectRefresh(
  code: RefreshRejectionValue,
  request: Request,
  clearCookie: boolean
): Response {
  const headers: Record<string, string> = {};
  if (clearCookie) {
    // A cookie we have decided is unusable must be actively removed, otherwise
    // the browser re-presents the same dead token on every single reload.
    headers["Set-Cookie"] = buildClearRefreshCookieHeader(
      refreshCookieIsSecure(request.headers.get("host"))
    );
  }
  return Response.json(
    { success: false, message: "Session expired, please sign in again", code },
    { status: 401, headers }
  );
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405 }
    );
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.error("Refresh: JWT_SECRET is not set");
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  // Per-IP throttle. Refresh is hit automatically by every open tab, so this
  // budget is generous; it exists to stop a script from using the endpoint as a
  // cheap way to hammer the DB or brute-force cookie values.
  const ip = clientIpFromRequest(request);
  const ipRow = await incrementRateLimit(refreshIpKey(ip));
  const ipDecision = evaluateRateLimit(
    REFRESH_IP_RATE_LIMIT,
    ipRow.windowStartedAt.getTime(),
    ipRow.attempts
  );
  if (ipDecision.limited) {
    return rateLimitResponse(
      ipDecision.retryAfterMs,
      REFRESH_IP_RATE_LIMIT.maxAttempts,
      Math.max(0, REFRESH_IP_RATE_LIMIT.maxAttempts - ipRow.attempts)
    );
  }
  void purgeStaleRateLimits();

  const token = readCookieValue(
    request.headers.get("cookie"),
    REFRESH_COOKIE_NAME
  );
  if (!token) {
    return rejectRefresh(RefreshRejection.MISSING, request, true);
  }

  let row;
  try {
    row = await findRefreshSession(token);
  } catch (error) {
    console.error("Refresh: failed to load session", safeErrorLog(error));
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  if (!row) {
    await insertAuditLog({
      userId: null,
      action: AuditAction.SESSION_REFRESH_REJECTED,
      entityType: "RefreshSession",
      details: {
        route: "/api/v1/auth/refresh",
        method: "POST",
        result: "rejected",
        reason: RefreshRejection.UNKNOWN,
      },
    });
    return rejectRefresh(RefreshRejection.UNKNOWN, request, true);
  }

  // REUSE DETECTION. Reaching here with an already-revoked row means a secret
  // that should be dead is still in play. Revoke the entire rotation family so
  // neither the attacker nor the (possibly hijacked) victim keeps access, then
  // tell the client to sign in again.
  if (row.revokedAt !== null) {
    let familyRevoked = 0;
    try {
      familyRevoked = await revokeRefreshFamily(
        row.familyId,
        RevokeReason.REUSE_DETECTED
      );
    } catch (error) {
      console.error("Refresh: failed to revoke family", safeErrorLog(error));
    }
    await insertAuditLog({
      userId: row.userId,
      action: AuditAction.SESSION_REFRESH_REJECTED,
      entityType: "RefreshSession",
      entityId: row.id,
      details: {
        route: "/api/v1/auth/refresh",
        method: "POST",
        result: "rejected",
        reason: RefreshRejection.REVOKED,
        previousRevokeReason: row.revokedReason,
        familyRevokedSessions: familyRevoked,
      },
    });
    return rejectRefresh(RefreshRejection.REVOKED, request, true);
  }

  const now = new Date();
  if (row.expiresAt.getTime() <= now.getTime()) {
    await revokeRefreshSession(row.id, RevokeReason.EXPIRED).catch((error) =>
      console.error("Refresh: failed to mark expired", safeErrorLog(error))
    );
    await insertAuditLog({
      userId: row.userId,
      action: AuditAction.SESSION_REFRESH_REJECTED,
      entityType: "RefreshSession",
      entityId: row.id,
      details: {
        route: "/api/v1/auth/refresh",
        method: "POST",
        result: "rejected",
        reason: RefreshRejection.EXPIRED,
      },
    });
    return rejectRefresh(RefreshRejection.EXPIRED, request, true);
  }

  // Authoritative re-read of the user. A refresh cookie must never outlive the
  // account's authority, so suspension/deletion is decided HERE, from the DB,
  // and not from anything carried in the session.
  let user;
  try {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    user = rows[0];
  } catch (error) {
    console.error("Refresh: failed to query user", safeErrorLog(error));
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  if (!user) {
    await revokeAllForUser(row).catch((error) =>
      console.error("Refresh: failed to revoke orphan", safeErrorLog(error))
    );
    await insertAuditLog({
      userId: null,
      action: AuditAction.SESSION_REFRESH_REJECTED,
      entityType: "RefreshSession",
      entityId: row.id,
      details: {
        route: "/api/v1/auth/refresh",
        method: "POST",
        result: "rejected",
        reason: RefreshRejection.USER_GONE,
      },
    });
    return rejectRefresh(RefreshRejection.USER_GONE, request, true);
  }

  if (user.status !== "ACTIVE") {
    // Revoke the WHOLE user's sessions: a suspended account must lose every
    // device, not just the tab that happened to refresh.
    await revokeAllForUser(row).catch((error) =>
      console.error(
        "Refresh: failed to revoke suspended user sessions",
        safeErrorLog(error)
      )
    );
    await insertAuditLog({
      userId: user.id,
      action: AuditAction.SESSION_REFRESH_REJECTED,
      entityType: "User",
      entityId: user.id,
      details: {
        route: "/api/v1/auth/refresh",
        method: "POST",
        result: "rejected",
        reason: "account_suspended",
      },
    });
    return Response.json(
      {
        success: false,
        message: ACCOUNT_SUSPENDED_MESSAGE,
        code: "ACCOUNT_SUSPENDED",
      },
      {
        status: 403,
        headers: {
          "Set-Cookie": buildClearRefreshCookieHeader(
            refreshCookieIsSecure(request.headers.get("host"))
          ),
        },
      }
    );
  }

  let accessToken: string;
  try {
    accessToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      jwtSecret,
      // Must match login exactly, and must carry the audience that verifyAuth
      // asserts — a renewed token that skipped it would 401 immediately.
      { expiresIn: ACCESS_TOKEN_EXPIRY, audience: ACCESS_TOKEN_AUDIENCE }
    );
  } catch (error) {
    console.error("Refresh: failed to sign access token", safeErrorLog(error));
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  // Rotate. The presented token is revoked and a fresh one is issued in the same
  // family with a reset (sliding) expiry, so an active user is never logged out
  // but a copied old token is worthless.
  let rotated;
  try {
    rotated = await rotateRefreshSession(row, { now });
  } catch (error) {
    console.error("Refresh: failed to rotate session", safeErrorLog(error));
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  if (!rotated) {
    // Lost a race with a concurrent rotation of the same token (e.g. two tabs
    // refreshing at once). The presented token is now revoked, so the honest
    // answer is "your token was just consumed" — the client retries, and the
    // still-current cookie from the winning tab keeps the user signed in.
    return rejectRefresh(RefreshRejection.REVOKED, request, false);
  }

  void touchRefreshSession(rotated.id, now);

  await insertAuditLog({
    userId: user.id,
    action: AuditAction.SESSION_REFRESH,
    entityType: "RefreshSession",
    entityId: rotated.id,
    details: {
      route: "/api/v1/auth/refresh",
      method: "POST",
      result: "success",
      role: user.role,
    },
  });

  return Response.json(
    {
      success: true,
      message: "Session refreshed",
      data: {
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
        },
      },
    },
    {
      status: 200,
      headers: {
        "Set-Cookie": buildRefreshCookieHeader(
          rotated.token,
          rotated.maxAgeSeconds,
          refreshCookieIsSecure(request.headers.get("host"))
        ),
      },
    }
  );
}

/** Revoke every session of the session's user (orphan + suspension paths). */
async function revokeAllForUser(row: { userId: string }): Promise<void> {
  await revokeAllUserSessions(row.userId, RevokeReason.ACCOUNT_SUSPENDED);
}
