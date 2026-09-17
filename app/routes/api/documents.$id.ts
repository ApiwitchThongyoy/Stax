import { eq, and, or, inArray } from "drizzle-orm";
import type { Route } from "./+types/documents.$id";
import { db } from "~/lib/drizzle-db";
import { documents, capitalTransactions, journalEntries, journalEntryLines } from "~/db/schema";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { deleteStoredFile } from "~/lib/storage/statement-storage";
import { reconcileStatementDeletion } from "~/lib/ledger-service";
import { safeErrorLog } from "~/lib/safe-error-log";
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
 * Removes the document, its capital rows, and linked journal entries/lines
 * that reference that exact source_document_id — for the authenticated user only,
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
      .select({ id: documents.id, filePath: documents.filePath, originalName: documents.originalName })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, auth.userId)))
      .limit(1)
      .execute();
    ownDoc = rows[0] ?? null;
  } catch (error) {
    console.error("DocumentDelete: failed to query document", safeErrorLog(error));
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
    const deleted = await db.transaction(async (tx) => {
      // Serializes with imports' SHARE reference locks and rechecks ownership.
      const owned = await tx.select({ id: documents.id }).from(documents)
        .where(and(eq(documents.id, id), eq(documents.userId, auth.userId))).for("update");
      if (!owned.length) return false;
      const sourceRows = await tx.select().from(capitalTransactions)
        .where(and(eq(capitalTransactions.sourceDocumentId, id), eq(capitalTransactions.userId, auth.userId)))
        .for("update");
      const transactionIds = sourceRows.map(row => row.transactionId);
      // Transaction-linked mirrors/reversals may lack a document link.
      // Unrelated manual entries and other owners are never selected.
      const entries = await tx.select({ id: journalEntries.id, symbol: journalEntries.symbol })
        .from(journalEntries).where(and(eq(journalEntries.userId, auth.userId),
          or(eq(journalEntries.sourceDocumentId, id),
            transactionIds.length ? inArray(journalEntries.sourceTransactionId, transactionIds) : undefined)))
        .for("update");
      const entryIds = entries.map(entry => entry.id);
      if (entryIds.length) {
        // journal_entry_lines FK is NO ACTION, not CASCADE.
        await tx.delete(journalEntryLines).where(and(eq(journalEntryLines.userId, auth.userId),
          inArray(journalEntryLines.journalEntryId, entryIds)));
        await tx.delete(journalEntries).where(and(eq(journalEntries.userId, auth.userId),
          inArray(journalEntries.id, entryIds)));
      }
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
      await reconcileStatementDeletion(tx, auth.userId,
        new Set([...sourceRows, ...entries].flatMap(row => row.symbol ? [row.symbol] : [])));
      return true;
    });
    if (!deleted) return Response.json({ success: false, message: "Document not found" }, { status: 404 });
  } catch (error) {
    console.error("DocumentDelete: transaction failed", safeErrorLog(error));
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
      originalName: ownDoc.originalName,
    },
  });

  // Best-effort physical file cleanup AFTER the DB commit succeeded. A failure
  // here is logged (sanitized) but does NOT recreate DB rows — the document is
  // already gone from the data model. This is a deliberate design decision:
  // an orphaned file is safer and simpler to manually reconcile than silently
  // re-importing rows the user asked to delete. The file path is never exposed.
  await deleteStoredFile(ownDoc.filePath);

  return Response.json({ success: true, data: { id } }, { status: 200 });
}
