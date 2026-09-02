import type { Route } from "./+types/export";
import { verifyAuth, isAuthError, authErrorResponse } from "~/lib/auth-middleware";
import { exportCapitalTransactions, type ExportFormat } from "~/lib/export-service";

export async function loader() {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

/**
 * POST /api/v1/export
 * body: { format?: "csv" | "xlsx", dateFrom?: string, dateTo?: string }
 *
 * Authenticated user-scoped export of capital transactions.
 * Returns a file download with the appropriate MIME type.
 * Only exports the authenticated user's own data — never cross-user.
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, message: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { format: rawFormat, dateFrom, dateTo } = (body ?? {}) as Record<string, unknown>;

  const format: ExportFormat = rawFormat === "xlsx" ? "xlsx" : "csv";

  if (dateFrom && typeof dateFrom === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
    return Response.json(
      { success: false, message: "dateFrom must be YYYY-MM-DD format" },
      { status: 400 }
    );
  }
  if (dateTo && typeof dateTo === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return Response.json(
      { success: false, message: "dateTo must be YYYY-MM-DD format" },
      { status: 400 }
    );
  }

  try {
    const result = await exportCapitalTransactions({
      userId: auth.userId,
      format,
      dateFrom: typeof dateFrom === "string" ? dateFrom : undefined,
      dateTo: typeof dateTo === "string" ? dateTo : undefined,
    });

    const arrayBuffer = new Uint8Array(result.buffer).buffer;

    return new Response(arrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("Export POST: failed", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
