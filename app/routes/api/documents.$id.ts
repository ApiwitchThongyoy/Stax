import { eq, and } from "drizzle-orm";
import type { Route } from "./+types/documents.$id";
import { db } from "~/lib/drizzle-db";
import { documents, capitalTransactions } from "~/db/schema";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { deleteStoredFile } from "~/lib/storage/statement-storage";
import { rebuildCostBasisStateFromLedger } from "~/lib/statement-pipeline";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";

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

/**
 * Real user-scoped Statement DELETE (server-authoritative).
 *
 * Removes BOTH the document's ownership row AND every Capital_Transactions row
 * that references that exact source_document_id — for the authenticated user only,
 * atomically. Never deletes a document the caller does not own, never deletes
 * another user's data, and never touches same-looking transactions that came from
 * a different source document. The physical PDF is then removed safely.
 */
export async function loader(_: Route.LoaderArgs) {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "DELETE") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405 }
    );
  }

  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  const { id } = params;
  if (!id || !UUID_REGEX.test(id)) {
    return Response.json(
      { success: false, message: "Invalid document id" },
      { status: 400 }
    );
  }

  // Load the caller's OWN document metadata (including server-side file path).
  // If it does not exist for THIS user we return a safe 404 without revealing
  // whether another user holds a document with that id.
  let ownDoc;
  try {
    const rows = await db
      .select({ id: documents.id, filePath: documents.filePath })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, auth.userId)))
      .limit(1)
      .execute();
    ownDoc = rows[0] ?? null;
  } catch (error) {
    console.error("DocumentDelete: failed to query document", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  if (!ownDoc) {
    return Response.json(
      { success: false, message: "Document not found" },
      { status: 404 }
    );
  }

  try {
    // Atomic user-scoped deletion: the caller's transactions from THIS exact
    // source document first, then the caller's document row.
    await db.transaction(async (tx) => {
      await tx
        .delete(capitalTransactions)
        .where(
          and(
            eq(capitalTransactions.sourceDocumentId, id),
            eq(capitalTransactions.userId, auth.userId)
          )
        )
        .execute();

      await tx
        .delete(documents)
        .where(and(eq(documents.id, id), eq(documents.userId, auth.userId)))
        .execute();
    });
  } catch (error) {
    console.error("DocumentDelete: transaction failed", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  await insertAuditLog({
    userId: auth.userId,
    action: AuditAction.STATEMENT_DELETE,
    entityType: "documents",
    entityId: id,
    details: {
      route: `/api/v1/documents/${id}`,
      method: "DELETE",
      result: "success",
    },
  });

  // Reconcile the derived cost-basis cache with the rows that REMAIN (the
  // deleted statement's rows are gone). Without this, a later re-import could
  // double-count the deleted statement's buys. Best-effort: if it fails, an
  // import re-seeds from the authoritative ledger/statement on the next upload.
  try {
    await rebuildCostBasisStateFromLedger(auth.userId);
  } catch (error) {
    console.warn("DocumentDelete: cost_basis_state rebuild failed", error);
  }

  // Best-effort physical file cleanup AFTER the DB commit succeeded. A failure
  // here is logged (sanitized) but does NOT recreate DB rows — the document is
  // already gone from the data model. This is a deliberate design decision:
  // an orphaned file is safer and simpler to manually reconcile than silently
  // re-importing rows the user asked to delete. The file path is never exposed.
  await deleteStoredFile(ownDoc.filePath);

  return Response.json({ success: true, data: { id } }, { status: 200 });
}
