import { sql } from "drizzle-orm";
import type { Route } from "./+types/users";
import { db } from "~/lib/drizzle-db";
import { users, documents } from "~/db/schema";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";

function isAuthError(result: unknown): result is { status: number; message: string } {
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

  if (auth.role !== "ADMIN") {
    await insertAuditLog({
      userId: auth.userId,
      action: AuditAction.ADMIN_UNAUTHORIZED_ACCESS,
      entityType: "User",
      details: {
        route: "/api/v1/admin/users",
        method: "GET",
        result: "denied",
      },
    });
    return Response.json(
      { success: false, message: "Forbidden" },
      { status: 403 }
    );
  }

  try {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        lastSeenAt: users.lastSeenAt,
        createdAt: users.createdAt,
        documentCount: sql<number>`coalesce((SELECT count(*)::int FROM ${documents} WHERE ${documents}.user_id = ${users}.id), 0)`,
      })
      .from(users)
      .orderBy(users.email)
      .execute();

    await insertAuditLog({
      userId: auth.userId,
      action: AuditAction.ADMIN_USER_LIST_VIEW,
      entityType: "User",
      details: {
        route: "/api/v1/admin/users",
        method: "GET",
        result: "success",
        userCount: rows.length,
      },
    });

    return Response.json({ success: true, data: rows }, { status: 200 });
  } catch (error) {
    console.error("AdminUsers GET: failed to query", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function action(_: Route.ActionArgs) {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}
