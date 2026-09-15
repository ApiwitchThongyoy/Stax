import type { Route } from "./+types/corporate-actions.$id";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";
import { deleteCorporateAction } from "~/lib/corporate-action-service";

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

export async function loader() {
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

  if (request.method !== "DELETE") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405 }
    );
  }

  const id = params.id;
  if (!id) {
    return Response.json(
      { success: false, message: "corporate action id is required" },
      { status: 400 }
    );
  }

  const result = await deleteCorporateAction(auth.userId, id);
  if (!result.ok) {
    const notFound = (result.errors ?? []).some((e) => e === "Record not found");
    return Response.json(
      { success: false, message: notFound ? "Record not found" : "Internal server error", errors: result.errors },
      { status: notFound ? 404 : 500 }
    );
  }

  await insertAuditLog({
    userId: auth.userId,
    action: AuditAction.CORPORATE_ACTION_DELETE,
    entityType: "corporate_actions",
    entityId: id,
    details: { method: "DELETE", route: "/api/v1/corporate-actions/:id" },
  });

  return Response.json({ success: true, data: null }, { status: 200 });
}