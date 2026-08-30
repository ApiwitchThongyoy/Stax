import { and, eq } from "drizzle-orm";
import type { Route } from "./+types/notifications.$id.read";
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

export async function loader(_: Route.LoaderArgs) {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

export async function action({ request, params }: Route.ActionArgs) {
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

  const { id } = params;
  if (!id) {
    return Response.json(
      { success: false, message: "Missing notification id" },
      { status: 400 }
    );
  }

  try {
    const updatedRows = await db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.id, id), eq(notifications.userId, auth.userId)))
      .returning();

    if (updatedRows.length === 0) {
      return Response.json(
        {
          success: false,
          message: "Notification not found or not owned by user",
        },
        { status: 404 }
      );
    }

    await insertAuditLog({
      userId: auth.userId,
      action: AuditAction.NOTIFICATION_MARK_READ,
      entityType: "notifications",
      entityId: id,
      details: {
        route: `/api/v1/notifications/${id}/read`,
        method: "PATCH",
        result: "success",
      },
    });

    return Response.json({ success: true, data: updatedRows[0] }, { status: 200 });
  } catch (error) {
    console.error("Notifications PATCH (read): failed to update", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
