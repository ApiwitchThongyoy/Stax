import type { Route } from "./+types/documents";
import { eq, desc, count, and, isNotNull } from "drizzle-orm";
import { db } from "~/lib/drizzle-db";
import { documents, journalEntries } from "~/db/schema";
import {
  verifyAuth,
  authErrorResponse,
  isAuthError,
} from "~/lib/auth-middleware";

/**
 * User-scoped Statement archive list.
 *
 * Returns ONLY the authenticated user's own document metadata (safe fields),
 * never another user's rows. The `file_path` (server filesystem path) is
 * intentionally omitted — the frontend does not need it. `transactionCount`
 * counts the document's journal entries (the same source the
 * "ดูธุรกรรม" panel reads via listCapitalLedgerRowsByDocument), so the list
 * subtitle always agrees with the drill-down — including SKIPPED mirrors and
 * orphan entries whose Capital_Transactions row was deleted.
 */
export async function action() {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  try {
    const rows = await db
      .select({
        id: documents.id,
        originalName: documents.originalName,
        mimeType: documents.mimeType,
        fileSize: documents.fileSize,
        createdAt: documents.createdAt,
        transactionCount: count(journalEntries.sourceTransactionId),
      })
      .from(documents)
      .leftJoin(
        journalEntries,
        and(
          eq(journalEntries.sourceDocumentId, documents.id),
          eq(journalEntries.userId, auth.userId),
          isNotNull(journalEntries.sourceTransactionId)
        )
      )
      .where(eq(documents.userId, auth.userId))
      .groupBy(
        documents.id,
        documents.originalName,
        documents.mimeType,
        documents.fileSize,
        documents.createdAt
      )
      .orderBy(desc(documents.createdAt))
      .execute();

    return Response.json({ success: true, data: rows }, { status: 200 });
  } catch (error) {
    console.error("Documents GET: failed to query", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
