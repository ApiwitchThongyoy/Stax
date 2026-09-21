import { eq, and } from "drizzle-orm";
import type { Route } from "./+types/capital-ledgers.$id";
import { db } from "~/lib/drizzle-db";
import { capitalTransactions } from "~/db/schema";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { rebuildCostBasisStateFromLedger, backfillComputedGainLoss } from "~/lib/statement-pipeline";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";
import {
  removeCapitalLedgerJournal,
  syncCapitalLedgerJournal,
} from "~/lib/ledger-service";
import {
  getCapitalLedgerRow,
  journalEntryToCapitalRow,
} from "~/lib/journal-ledger-read";

const VALID_TRANSACTION_TYPES = ["CASH_IN", "CASH_OUT"];
const VALID_SOURCE_TYPES = ["MANUAL", "AI_PARSED"];

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

function validateAmount(value: unknown, fieldName: string): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return `${fieldName} is required and must be a non-empty string`;
  }
  const num = Number(value);
  if (isNaN(num)) {
    return `${fieldName} must be a valid number`;
  }
  return null;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  const { id } = params;
  if (!id) {
    return Response.json(
      { success: false, message: "Missing id parameter" },
      { status: 400 }
    );
  }

  try {
    // Journal as SSOT: single-record reads come from the journal, which holds
    // every Capital_Transactions-mirrored entry (migration 0020).
    const record = await getCapitalLedgerRow(auth.userId, id);
    if (!record) {
      return Response.json(
        { success: false, message: "Record not found" },
        { status: 404 }
      );
    }

    return Response.json(
      { success: true, data: journalEntryToCapitalRow(record) },
      { status: 200 }
    );
  } catch (error) {
    console.error("CapitalLedgers GET by ID: failed to query", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  const { id } = params;
  if (!id) {
    return Response.json(
      { success: false, message: "Missing id parameter" },
      { status: 400 }
    );
  }

  if (request.method === "PUT" || request.method === "PATCH") {
    return handleUpdate(request, auth.userId, id);
  }

  if (request.method === "DELETE") {
    return handleDelete(auth.userId, id);
  }

  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

async function handleUpdate(
  request: Request,
  userId: string,
  transactionId: string
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, message: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const updates = (body ?? {}) as Record<string, unknown>;
  const setValues: Record<string, string> = {};

  if ("amountForeign" in updates) {
    const err = validateAmount(updates.amountForeign, "amountForeign");
    if (err) {
      return Response.json({ success: false, message: err }, { status: 400 });
    }
    setValues.amountForeign = String(updates.amountForeign);
  }

  if ("currency" in updates) {
    if (typeof updates.currency !== "string" || updates.currency.trim() === "") {
      return Response.json(
        { success: false, message: "currency must be a non-empty string" },
        { status: 400 }
      );
    }
    setValues.currency = updates.currency.trim();
  }

  if ("transactionDate" in updates) {
    if (
      typeof updates.transactionDate !== "string" ||
      updates.transactionDate.trim() === ""
    ) {
      return Response.json(
        { success: false, message: "transactionDate must be a non-empty string" },
        { status: 400 }
      );
    }
    setValues.transactionDate = updates.transactionDate.trim();
  }

  if ("fxRateBot" in updates) {
    const err = validateAmount(updates.fxRateBot, "fxRateBot");
    if (err) {
      return Response.json({ success: false, message: err }, { status: 400 });
    }
    setValues.fxRateBot = String(updates.fxRateBot);
    // Keep the effective rate in sync so consumers read it uniformly.
    setValues.fxRateEffective = String(updates.fxRateBot);
  }

  if ("amountThb" in updates) {
    const err = validateAmount(updates.amountThb, "amountThb");
    if (err) {
      return Response.json({ success: false, message: err }, { status: 400 });
    }
    setValues.amountThb = String(updates.amountThb);
  }

  if ("type" in updates) {
    if (
      typeof updates.type !== "string" ||
      !VALID_TRANSACTION_TYPES.includes(updates.type)
    ) {
      return Response.json(
        {
          success: false,
          message: `type must be one of: ${VALID_TRANSACTION_TYPES.join(", ")}`,
        },
        { status: 400 }
      );
    }
    setValues.type = updates.type;
  }

  if ("sourceType" in updates) {
    if (
      typeof updates.sourceType !== "string" ||
      !VALID_SOURCE_TYPES.includes(updates.sourceType)
    ) {
      return Response.json(
        {
          success: false,
          message: `sourceType must be one of: ${VALID_SOURCE_TYPES.join(", ")}`,
        },
        { status: 400 }
      );
    }
    setValues.sourceType = updates.sourceType;
  }

  if (Object.keys(setValues).length === 0) {
    return Response.json(
      { success: false, message: "No valid fields to update" },
      { status: 400 }
    );
  }

  try {
    // The capital-row update AND the journal mirror sync commit (or roll back)
    // together. syncing the MANUAL entry inside the same transaction means an
    // edited row can never be left with a stale journal, and a journal that
    // cannot represent the edited row rolls the whole update back (500) rather
    // than committing an inconsistent pair.
    const updated = await db.transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(capitalTransactions)
        .where(
          and(
            eq(capitalTransactions.transactionId, transactionId),
            eq(capitalTransactions.userId, userId)
          )
        )
        .limit(1);

      if (existingRows.length === 0) {
        return null;
      }

      await tx
        .update(capitalTransactions)
        .set(setValues)
        .where(
          and(
            eq(capitalTransactions.transactionId, transactionId),
            eq(capitalTransactions.userId, userId)
          )
        )
        .execute();

      const updatedRows = await tx
        .select()
        .from(capitalTransactions)
        .where(
          and(
            eq(capitalTransactions.transactionId, transactionId),
            eq(capitalTransactions.userId, userId)
          )
        )
        .limit(1);

      const updatedRow = updatedRows[0];

      // Journal as SSOT: keep the mirrored journal entry fresh so journal-backed
      // reads never show stale values. Only cash rows (CASH_IN/CASH_OUT) get the
      // two-leg equity entry rebuilt; statement trade rows keep their original
      // posting lines untouched (sync no-ops for non-MANUAL linked entries).
      if (
        updatedRow &&
        (updatedRow.type === "CASH_IN" || updatedRow.type === "CASH_OUT")
      ) {
        await syncCapitalLedgerJournal(userId, transactionId, {
          transactionId,
          type: updatedRow.type,
          amountForeign: String(updatedRow.amountForeign ?? ""),
          currency: String(updatedRow.currency ?? ""),
          transactionDate: String(updatedRow.transactionDate ?? ""),
          fxRateEffective: String(
            updatedRow.fxRateEffective ?? updatedRow.fxRateBot ?? "1"
          ),
          amountThb: String(updatedRow.amountThb ?? ""),
        }, tx);
      }

      return updatedRow;
    });

    if (!updated) {
      return Response.json(
        { success: false, message: "Record not found" },
        { status: 404 }
      );
    }

    await insertAuditLog({
      userId,
      action: AuditAction.CAPITAL_TRANSACTION_UPDATE,
      entityType: "Capital_Transactions",
      entityId: transactionId,
      details: {
        method: request.method,
        route: `/api/v1/capital-ledgers/${transactionId}`,
        result: "updated",
        updatedFields: Object.keys(setValues),
      },
    });

    // Journal as SSOT: the response comes from the mirrored journal record
    // (same shape as GET /:id), with the raw capital row only as a fallback
    // when the journal read fails — never the other way around.
    let data: unknown = updated;
    try {
      const record = await getCapitalLedgerRow(userId, transactionId);
      if (record) data = journalEntryToCapitalRow(record);
    } catch (error) {
      console.warn("CapitalLedgers PUT: journal re-read failed, returning capital row", error);
    }
    return Response.json({ success: true, data }, { status: 200 });
  } catch (error) {
    console.error("CapitalLedgers PUT: failed to update", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}

async function handleDelete(
  userId: string,
  transactionId: string
): Promise<Response> {
  try {
    // Journal as SSOT: delete the capital row AND its mirrored journal entry in
    // ONE transaction — a mirrored entry is never left pointing at a deleted
    // transaction (journal-backed views would then show a phantom row). Purely
    // recursive cleanup — the entry itself is not reversed, because reversal
    // would re-show the movement in the account ledger.
    const deleted = await db.transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(capitalTransactions)
        .where(
          and(
            eq(capitalTransactions.transactionId, transactionId),
            eq(capitalTransactions.userId, userId)
          )
        )
        .limit(1);

      if (existingRows.length === 0) {
        return false;
      }

      await removeCapitalLedgerJournal(userId, transactionId, tx);

      await tx
        .delete(capitalTransactions)
        .where(
          and(
            eq(capitalTransactions.transactionId, transactionId),
            eq(capitalTransactions.userId, userId)
          )
        )
        .execute();

      return true;
    });

    if (!deleted) {
      return Response.json(
        { success: false, message: "Record not found" },
        { status: 404 }
      );
    }

    // Reconcile the derived cost-basis cache with the rows that remain, so a
    // deleted BUY/SELL can never leave a double-counted cache for re-imports.
    // Best-effort: an import re-seeds from the authoritative ledger/statement.
    try {
      await rebuildCostBasisStateFromLedger(userId);
    } catch (error) {
      console.warn("CapitalLedgers DELETE: cost_basis_state rebuild failed", error);
    }

    // Heal frozen SELL rows that only became computable after this deletion
    // (fills holes only; never overwrites existing values, never touches
    // MANUAL rows). Best-effort — a deletion must never fail because of it.
    try {
      await backfillComputedGainLoss(userId);
    } catch (error) {
      console.warn("CapitalLedgers DELETE: gain-loss backfill failed", error);
    }

    await insertAuditLog({
      userId,
      action: AuditAction.CAPITAL_TRANSACTION_DELETE,
      entityType: "Capital_Transactions",
      entityId: transactionId,
      details: {
        method: "DELETE",
        route: `/api/v1/capital-ledgers/${transactionId}`,
        result: "deleted",
      },
    });

    return Response.json(
      { success: true, message: "Record deleted" },
      { status: 200 }
    );
  } catch (error) {
    console.error("CapitalLedgers DELETE: failed to delete", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
