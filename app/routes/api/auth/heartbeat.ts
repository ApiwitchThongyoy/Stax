import { eq } from "drizzle-orm";
import type { Route } from "./+types/heartbeat";
import { db } from "~/lib/drizzle-db";
import { users } from "~/db/schema";
import { verifyAuth, authErrorResponse, isAuthError } from "~/lib/auth-middleware";

/**
 * Lightweight authenticated heartbeat used to track real online presence.
 *
 * - Requires a valid JWT via verifyAuth; the userId used is ALWAYS the one the
 *   backend resolved from the authenticated session (never the request body).
 * - On success it bumps `last_seen_at` for the authenticated user.
 * - Suspended accounts are rejected by verifyAuth (403 + ACCOUNT_SUSPENDED), so
 *   they can never be considered online.
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405 }
    );
  }

  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  try {
    await db
      .update(users)
      .set({ lastSeenAt: new Date() })
      .where(eq(users.id, auth.userId))
      .execute();
  } catch (error) {
    console.error("Heartbeat: failed to update last_seen_at", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  return Response.json(
    { success: true, data: { lastSeenAt: new Date().toISOString() } },
    { status: 200 }
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  if (request.method !== "GET") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405 }
    );
  }
  return action({ request } as Route.ActionArgs);
}
