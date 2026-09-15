import { eq, and } from "drizzle-orm";
import type { Route } from "./+types/documents.$id.transactions";
import { db } from "~/lib/drizzle-db";
import { documents } from "~/db/schema";

import {
  verifyAuth,
  authErrorResponse,
} from "~/lib/auth-middleware";
import {
  journalEntryToCapitalRow,
  listCapitalLedgerRowsByDocument,
} from "~/lib/journal-ledger-read";

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
 * User-scoped read of the transaction records that a stored Statement
 * produced. The documents table stores only metadata; the rows live in
 * Capital_Transactions linked via source_document_id. Ownership is verified,
 * and a missing/cross-user document returns a safe 404 (never reveals whether
 * another user holds a document with that id). Purely read-only: no storage
 * read, no re-parse, no writes of any kind — the ledger is the source of truth.
 */
export async function action() {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

export async function loader({ request, params }: Route.LoaderArgs) {
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

  // Load the caller's OWN document. If it does not exist for THIS user we return
  // a safe 404 without revealing whether another user holds that id.
  let ownDoc;
  try {
    const rows = await db
      .select({
        id: documents.id,
        originalName: documents.originalName,
      })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, auth.userId)))
      .limit(1)
      .execute();
    ownDoc = rows[0] ?? null;
  } catch (error) {
    console.error("DocumentTransactions: failed to query document", error);
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

  let transactions;
  try {
    // Journal as SSOT: the document's ledger rows come from the journal (every
    // Capital_Transactions-mirrored entry, migration 0020), oldest-first.
    const entries = await listCapitalLedgerRowsByDocument(auth.userId, id);
    transactions = entries.map(journalEntryToCapitalRow);
  } catch (error) {
    console.error("DocumentTransactions: failed to query transaction journal", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  const buyCount = transactions.filter((r) => r.side === "BUY").length;
  const sellCount = transactions.filter((r) => r.side === "SELL").length;
  const computableSellCount = transactions.filter(
    (r) => r.side === "SELL" && r.realizedGainLossThb != null
  ).length;
  const fxRates = Array.from(
    new Set(
      transactions
        .map((r) => r.fxRateStatement)
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .sort()
    )
  );

  return Response.json(
    {
      success: true,
      data: {
        documentId: ownDoc.id,
        documentName: ownDoc.originalName,
        transactions,
        stats: {
          total: transactions.length,
          buyCount,
          sellCount,
          cashCount: transactions.length - buyCount - sellCount,
          computableSellCount,
          fxRates,
        },
      },
    },
    { status: 200 }
  );
}