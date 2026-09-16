import { and, eq } from "drizzle-orm";
import { capitalTransactions, documents } from "../db/schema";
import type { db } from "./drizzle-db";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Check links inside the write transaction. SHARE prevents deletion or an
 * ownership change between validation and insertion. Never include IDs in errors. */
export async function assertOwnedReferences(
  tx: Transaction,
  userId: string,
  references: { sourceDocumentId?: string | null; sourceTransactionId?: string | null }
): Promise<void> {
  if (references.sourceDocumentId) {
    const rows = await tx.select({ id: documents.id }).from(documents)
      .where(and(eq(documents.id, references.sourceDocumentId), eq(documents.userId, userId)))
      .for("share");
    if (!rows.length) throw new Error("Referenced resource not found");
  }
  if (references.sourceTransactionId) {
    const rows = await tx.select({ id: capitalTransactions.transactionId }).from(capitalTransactions)
      .where(and(eq(capitalTransactions.transactionId, references.sourceTransactionId), eq(capitalTransactions.userId, userId)))
      .for("share");
    if (!rows.length) throw new Error("Referenced resource not found");
  }
}
