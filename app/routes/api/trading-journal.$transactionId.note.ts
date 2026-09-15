import { and, eq } from "drizzle-orm";
import type { Route } from "./+types/trading-journal.$transactionId.note";
import { db } from "~/lib/drizzle-db";
import { journalEntries } from "~/db/schema";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";

function isAuthError(
  result: unknown
): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

const MAX_NOTE_LENGTH = 2000;

/**
 * PUT /api/v1/trading-journal/:transactionId/note
 * DELETE /api/v1/trading-journal/:transactionId/note
 *
 * The investor's own note on one journal row (สมุดบันทึก "จดบันทึก").
 * Owner-scoped: only the caller's OWN journal entry (matched by the linked
 * Capital_Transactions id) can be annotated; missing or another user's ids
 * get a safe 404. The note is free text and is NEVER part of the double-entry math —
 * imports, postings, backfills and reversals never write it.
 *
 * PUT body: { "note": string | null } — empty/blank clears the note.
 * DELETE clears the note. Loader → 405.
 */
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

  const { transactionId } = params;
  if (!transactionId) {
    return Response.json(
      { success: false, message: "Missing transactionId parameter" },
      { status: 400 }
    );
  }

  if (request.method !== "PUT" && request.method !== "DELETE") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405 }
    );
  }

  let note: string | null = null;
  if (request.method === "PUT") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { success: false, message: "Invalid JSON body" },
        { status: 400 }
      );
    }
    const raw = (body ?? {}) as Record<string, unknown>;
    if (
      raw.note !== null &&
      raw.note !== undefined &&
      typeof raw.note !== "string"
    ) {
      return Response.json(
        { success: false, message: "note must be a string or null" },
        { status: 400 }
      );
    }
    const trimmed = typeof raw.note === "string" ? raw.note.trim() : "";
    if (trimmed.length > MAX_NOTE_LENGTH) {
      return Response.json(
        {
          success: false,
          message: `note must be at most ${MAX_NOTE_LENGTH} characters`,
        },
        { status: 400 }
      );
    }
    note = trimmed === "" ? null : trimmed;
  }

  try {
    const updated = await db
      .update(journalEntries)
      .set({ note, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(journalEntries.userId, auth.userId),
          eq(journalEntries.sourceTransactionId, transactionId)
        )
      )
      .returning({ id: journalEntries.id })
      .execute();
    if (updated.length === 0) {
      return Response.json(
        { success: false, message: "Record not found" },
        { status: 404 }
      );
    }
    return Response.json({ success: true, data: { note } }, { status: 200 });
  } catch (error) {
    console.error("TradingJournal note: failed to update", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
