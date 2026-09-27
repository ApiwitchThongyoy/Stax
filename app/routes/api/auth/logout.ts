// POST /api/v1/auth/logout — end the current session for real.
//
// Deleting browser state alone is NOT logging out: the HttpOnly refresh cookie
// is unreadable by JavaScript, so the page cannot destroy it, and a token left
// valid on the server would silently re-sign the user in on the next reload
// (exactly the behaviour this project already had to work around for the access
// token). Explicit logout therefore has to reach the server to revoke the
// session row.
//
// The endpoint is deliberately IDEMPOTENT and always answers 200: "no cookie"
// and "already revoked" are both a successful sign-out from the caller's point of
// view, and returning 401 here would make the UI show a spurious error on the
// most common path (logging out twice, or logging out after the cookie already
// expired). The cookie is cleared either way, so the client is always left in a
// clean state.

import type { Route } from "./+types/logout";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";
import {
  REFRESH_COOKIE_NAME,
  buildClearRefreshCookieHeader,
  findRefreshSession,
  readCookieValue,
  refreshCookieIsSecure,
  revokeRefreshSession,
  RevokeReason,
} from "~/lib/refresh-session";
import { safeErrorLog } from "~/lib/safe-error-log";

export async function loader(_: Route.LoaderArgs) {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405 }
    );
  }

  const clearCookie = buildClearRefreshCookieHeader(
    refreshCookieIsSecure(request.headers.get("host"))
  );
  const token = readCookieValue(
    request.headers.get("cookie"),
    REFRESH_COOKIE_NAME
  );

  // Always clear the browser cookie first-class, even when the lookup below
  // fails: the caller's intent ("end my session") must be honoured locally no
  // matter what the server can say about the token.
  if (!token) {
    return Response.json(
      { success: true, message: "Signed out", data: { revokedSession: false } },
      { status: 200, headers: { "Set-Cookie": clearCookie } }
    );
  }

  let revoked = 0;
  let userId: string | null = null;
  try {
    const row = await findRefreshSession(token);
    if (row) {
      userId = row.userId;
      revoked = await revokeRefreshSession(row.id, RevokeReason.LOGOUT);
    }
  } catch (error) {
    // The cookie is still cleared below, so a DB hiccup cannot leave the
    // browser holding a credential; the server-side row (if any) will expire on
    // its own. Never surface this as an error to a user who asked to sign out.
    console.error("Logout: failed to revoke session", safeErrorLog(error));
  }

  await insertAuditLog({
    userId,
    action: AuditAction.SESSION_REVOKED,
    entityType: "RefreshSession",
    details: {
      route: "/api/v1/auth/logout",
      method: "POST",
      result: "success",
      hadToken: true,
    },
  });

  return Response.json(
    {
      success: true,
      message: "Signed out",
      data: { revokedSession: revoked > 0 },
    },
    { status: 200, headers: { "Set-Cookie": clearCookie } }
  );
}
