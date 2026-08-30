import { eq } from "drizzle-orm";
import type { Route } from "./+types/users.$id";
import { db } from "~/lib/drizzle-db";
import { users } from "~/db/schema";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";

const VALID_STATUSES = ["ACTIVE", "SUSPENDED"];
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAuthError(result: unknown): result is { status: number; message: string } {
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
  if (request.method !== "PATCH") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405 }
    );
  }

  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  if (auth.role !== "ADMIN") {
    await insertAuditLog({
      userId: auth.userId,
      action: AuditAction.ADMIN_UNAUTHORIZED_ACCESS,
      entityType: "User",
      entityId: params.id,
      details: {
        route: `/api/v1/admin/users/${params.id ?? ""}`,
        method: "PATCH",
        result: "denied",
      },
    });
    return Response.json(
      { success: false, message: "Forbidden" },
      { status: 403 }
    );
  }

  const { id } = params;
  if (!id || !UUID_REGEX.test(id)) {
    return Response.json(
      { success: false, message: "Invalid user id" },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, message: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { status } = (body ?? {}) as Record<string, unknown>;
  if (typeof status !== "string" || !VALID_STATUSES.includes(status)) {
    return Response.json(
      {
        success: false,
        message: `status must be one of: ${VALID_STATUSES.join(", ")}`,
      },
      { status: 400 }
    );
  }

  if (auth.userId === id && status === "SUSPENDED") {
    await insertAuditLog({
      userId: auth.userId,
      action: AuditAction.ADMIN_USER_STATUS_UPDATE,
      entityType: "User",
      entityId: id,
      details: {
        route: `/api/v1/admin/users/${id}`,
        method: "PATCH",
        result: "rejected",
        reason: "self_suspend_forbidden",
      },
    });
    return Response.json(
      {
        success: false,
        message: "ไม่สามารถระงับบัญชีผู้ดูแลระบบที่กำลังใช้งานอยู่ได้",
      },
      { status: 400 }
    );
  }

  try {
    const existingRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    if (existingRows.length === 0) {
      return Response.json(
        { success: false, message: "User not found" },
        { status: 404 }
      );
    }

    await db
      .update(users)
      .set({ status })
      .where(eq(users.id, id))
      .execute();

    await insertAuditLog({
      userId: auth.userId,
      action: AuditAction.ADMIN_USER_STATUS_UPDATE,
      entityType: "User",
      entityId: id,
      details: {
        route: `/api/v1/admin/users/${id}`,
        method: "PATCH",
        result: "success",
        targetUserId: id,
        newStatus: status,
      },
    });

    const updatedRows = await db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    return Response.json({ success: true, data: updatedRows[0] }, { status: 200 });
  } catch (error) {
    console.error("AdminUsers PATCH: failed to update", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
