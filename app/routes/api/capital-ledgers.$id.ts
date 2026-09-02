import { eq, and } from "drizzle-orm";
import type { Route } from "./+types/capital-ledgers.$id";
import { db } from "~/lib/drizzle-db";
import { capitalTransactions } from "~/db/schema";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { rebuildCostBasisStateFromLedger } from "~/lib/statement-pipeline";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";

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
    const rows = await db
      .select()
      .from(capitalTransactions)
      .where(
        and(
          eq(capitalTransactions.transactionId, id),
          eq(capitalTransactions.userId, auth.userId)
        )
      )
      .limit(1);
    const row = rows[0];

    if (!row) {
      return Response.json(
        { success: false, message: "Record not found" },
        { status: 404 }
      );
    }

    return Response.json({ success: true, data: row }, { status: 200 });
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
    const existingRows = await db
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
      return Response.json(
        { success: false, message: "Record not found" },
        { status: 404 }
      );
    }

    await db
      .update(capitalTransactions)
      .set(setValues)
      .where(
        and(
          eq(capitalTransactions.transactionId, transactionId),
          eq(capitalTransactions.userId, userId)
        )
      )
      .execute();

    const updatedRows = await db
      .select()
      .from(capitalTransactions)
      .where(
        and(
          eq(capitalTransactions.transactionId, transactionId),
          eq(capitalTransactions.userId, userId)
        )
      )
      .limit(1);

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

    return Response.json({ success: true, data: updatedRows[0] }, { status: 200 });
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
    const existingRows = await db
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
      return Response.json(
        { success: false, message: "Record not found" },
        { status: 404 }
      );
    }

    await db
      .delete(capitalTransactions)
      .where(
        and(
          eq(capitalTransactions.transactionId, transactionId),
          eq(capitalTransactions.userId, userId)
        )
      )
      .execute();

    // Reconcile the derived cost-basis cache with the rows that remain, so a
    // deleted BUY/SELL can never leave a double-counted cache for re-imports.
    // Best-effort: an import re-seeds from the authoritative ledger/statement.
    try {
      await rebuildCostBasisStateFromLedger(userId);
    } catch (error) {
      console.warn("CapitalLedgers DELETE: cost_basis_state rebuild failed", error);
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
