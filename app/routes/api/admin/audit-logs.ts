import { desc, sql } from "drizzle-orm";
import type { Route } from "./+types/audit-logs";
import { db } from "~/lib/drizzle-db";
import { auditLogs, users } from "~/db/schema";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";

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
    return Response.json(
      { success: false, message: "Forbidden" },
      { status: 403 }
    );
  }

  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;

  try {
    const rows = await db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        details: auditLogs.details,
        createdAt: auditLogs.createdAt,
        userEmail: users.email,
        userId: auditLogs.userId,
      })
      .from(auditLogs)
      .leftJoin(users, sql`${users.id} = ${auditLogs.userId}`)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .execute();

    return Response.json({ success: true, data: rows }, { status: 200 });
  } catch (error) {
    console.error("AdminAuditLogs GET: failed to query", error);
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
