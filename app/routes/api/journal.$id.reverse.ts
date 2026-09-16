import type { Route } from "./+types/journal.$id.reverse";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";
import { reverseJournalEntry } from "~/lib/ledger-service";
import { safeErrorLog } from "~/lib/safe-error-log";

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

/** Reverse a POSTED journal entry: marks it REVERSED and posts an inverted mirror. */
export async function action({ request, params }: Route.ActionArgs) {
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

  const entryId = (params.id ?? "").trim();
  if (!entryId) {
    return Response.json(
      { success: false, message: "Journal entry id is required" },
      { status: 400 }
    );
  }

  try {
    const result = await reverseJournalEntry(auth.userId, entryId);
    if (!result.ok) {
      return Response.json(
        { success: false, message: result.errors.join("; ") },
        { status: result.errors.includes("Journal entry not found") ? 404 : 400 }
      );
    }

    await insertAuditLog({
      userId: auth.userId,
      action: AuditAction.JOURNAL_ENTRY_REVERSE,
      entityType: "journal_entries",
      entityId: result.reversalEntryId,
      details: {
        method: "POST",
        route: "/api/v1/journal/:id/reverse",
        originalEntryId: entryId,
        reversalEntryNo: result.reversalEntryNo,
      },
    });

    return Response.json(
      {
        success: true,
        data: {
          reversalEntryId: result.reversalEntryId,
          reversalEntryNo: result.reversalEntryNo,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Journal reverse: failed", safeErrorLog(error));
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
