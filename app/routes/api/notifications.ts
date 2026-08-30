import { and, eq } from "drizzle-orm";
import type { Route } from "./+types/notifications";
import { db } from "~/lib/drizzle-db";
import { notifications } from "~/db/schema";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";

function isAuthError(
  result: unknown
): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  const url = new URL(request.url);
  const rawUnreadOnly = url.searchParams.get("unreadOnly");
  const unreadOnly = rawUnreadOnly === "true";
  const rawLimit = Number(url.searchParams.get("limit") ?? "20");
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;

  try {
    const rows = await db
      .select()
      .from(notifications)
      .where(
        unreadOnly
          ? and(
              eq(notifications.userId, auth.userId),
              eq(notifications.isRead, false)
            )
          : eq(notifications.userId, auth.userId)
      )
      .orderBy(notifications.createdAt)
      .limit(limit)
      .execute();

    const unreadRows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, auth.userId),
          eq(notifications.isRead, false)
        )
      )
      .execute();

    return Response.json(
      {
        success: true,
        data: rows,
        meta: { unreadCount: unreadRows.length },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Notifications GET: failed to query", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  if (request.method !== "PATCH") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405 }
    );
  }

  try {
    await db
      .update(notifications)
      .set({ isRead: true })
      .where(
        and(
          eq(notifications.userId, auth.userId),
          eq(notifications.isRead, false)
        )
      )
      .execute();

    await insertAuditLog({
      userId: auth.userId,
      action: AuditAction.NOTIFICATION_READ_ALL,
      entityType: "notifications",
      details: {
        route: "/api/v1/notifications",
        method: "PATCH",
        result: "success",
        scope: "all",
      },
    });

    return Response.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("Notifications PATCH (read-all): failed to update", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
