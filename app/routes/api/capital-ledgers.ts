import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Route } from "./+types/capital-ledgers";
import { db } from "~/lib/drizzle-db";
import { capitalTransactions } from "~/db/schema";
import { verifyAuth, type AuthPayload, authErrorResponse } from "~/lib/auth-middleware";
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

export async function loader({ request }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  try {
    const rows = await db
      .select()
      .from(capitalTransactions)
      .where(eq(capitalTransactions.userId, auth.userId))
      .execute();

    return Response.json({ success: true, data: rows }, { status: 200 });
  } catch (error) {
    console.error("CapitalLedgers GET: failed to query", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  if (request.method === "POST") {
    return handleCreate(request, auth);
  }

  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

async function handleCreate(
  request: Request,
  auth: AuthPayload
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

  const {
    amountForeign,
    currency,
    transactionDate,
    fxRateBot,
    amountThb,
    type,
    sourceType,
  } = (body ?? {}) as Record<string, unknown>;

  if (typeof currency !== "string" || currency.trim() === "") {
    return Response.json(
      { success: false, message: "currency is required" },
      { status: 400 }
    );
  }

  if (typeof transactionDate !== "string" || transactionDate.trim() === "") {
    return Response.json(
      { success: false, message: "transactionDate is required" },
      { status: 400 }
    );
  }

  const amtErr = validateAmount(amountForeign, "amountForeign");
  if (amtErr) {
    return Response.json({ success: false, message: amtErr }, { status: 400 });
  }

  const rateErr = validateAmount(fxRateBot, "fxRateBot");
  if (rateErr) {
    return Response.json({ success: false, message: rateErr }, { status: 400 });
  }

  const thbErr = validateAmount(amountThb, "amountThb");
  if (thbErr) {
    return Response.json({ success: false, message: thbErr }, { status: 400 });
  }

  if (
    typeof type !== "string" ||
    !VALID_TRANSACTION_TYPES.includes(type)
  ) {
    return Response.json(
      {
        success: false,
        message: `type must be one of: ${VALID_TRANSACTION_TYPES.join(", ")}`,
      },
      { status: 400 }
    );
  }

  if (
    typeof sourceType !== "string" ||
    !VALID_SOURCE_TYPES.includes(sourceType)
  ) {
    return Response.json(
      {
        success: false,
        message: `sourceType must be one of: ${VALID_SOURCE_TYPES.join(", ")}`,
      },
      { status: 400 }
    );
  }

  const transactionId = randomUUID();

  try {
    await db
      .insert(capitalTransactions)
      .values({
        transactionId,
        userId: auth.userId,
        amountForeign: String(amountForeign),
        currency: currency.trim(),
        transactionDate: transactionDate.trim(),
        fxRateBot: String(fxRateBot),
        amountThb: String(amountThb),
        type,
        sourceType,
      })
      .execute();

    await insertAuditLog({
      userId: auth.userId,
      action: AuditAction.CAPITAL_TRANSACTION_CREATE,
      entityType: "Capital_Transactions",
      entityId: transactionId,
      details: {
        method: "POST",
        route: "/api/v1/capital-ledgers",
        result: "created",
        type,
        sourceType,
        currency: currency.trim(),
        transactionDate: transactionDate.trim(),
      },
    });

    return Response.json(
      {
        success: true,
        data: {
          transactionId,
          userId: auth.userId,
          amountForeign: String(amountForeign),
          currency: currency.trim(),
          transactionDate: transactionDate.trim(),
          fxRateBot: String(fxRateBot),
          amountThb: String(amountThb),
          type,
          sourceType,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("CapitalLedgers POST: failed to insert", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
