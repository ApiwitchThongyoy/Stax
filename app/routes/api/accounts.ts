import { randomUUID } from "node:crypto";
import type { Route } from "./+types/accounts";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";
import {
  getActiveAccounts,
  seedDefaultChartOfAccounts,
} from "~/lib/ledger-service";
import { db } from "~/lib/drizzle-db";
import { accounts } from "~/db/schema";

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

const VALID_ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];

export async function loader({ request }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  try {
    // Lazy-seed for users who registered before the default CoA existed.
    await seedDefaultChartOfAccounts(auth.userId);
    const rows = await getActiveAccounts(auth.userId);
    return Response.json({ success: true, data: rows }, { status: 200 });
  } catch (error) {
    console.error("Accounts GET: failed to query", error);
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
  auth: { userId: string; email: string; role: string }
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

  const { code, name, type, currency } = (body ?? {}) as Record<string, unknown>;

  if (typeof code !== "string" || !/^[0-9]{4}$/.test(code.trim())) {
    return Response.json(
      { success: false, message: "code must be a 4-digit number (e.g. 1020)" },
      { status: 400 }
    );
  }
  if (typeof name !== "string" || name.trim() === "") {
    return Response.json(
      { success: false, message: "name is required" },
      { status: 400 }
    );
  }
  if (typeof type !== "string" || !VALID_ACCOUNT_TYPES.includes(type)) {
    return Response.json(
      {
        success: false,
        message: `type must be one of: ${VALID_ACCOUNT_TYPES.join(", ")}`,
      },
      { status: 400 }
    );
  }
  const normalizedCurrency = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
    return Response.json(
      { success: false, message: "currency must be a 3-letter ISO 4217 code (e.g. USD, THB)" },
      { status: 400 }
    );
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const accountCode = code.trim();

  try {
    await db
      .insert(accounts)
      .values({
        id,
        userId: auth.userId,
        code: accountCode,
        name: name.trim(),
        type,
        currency: normalizedCurrency,
        openingBalance: null,
        parentId: null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505"
    ) {
      return Response.json(
        { success: false, message: "An account with this code already exists" },
        { status: 409 }
      );
    }
    console.error("Accounts POST: failed to insert", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  await insertAuditLog({
    userId: auth.userId,
    action: AuditAction.ACCOUNT_CREATE,
    entityType: "accounts",
    entityId: id,
    details: {
      method: "POST",
      route: "/api/v1/accounts",
      code: accountCode,
      type,
      currency: normalizedCurrency,
    },
  });

  return Response.json(
    {
      success: true,
      data: {
        id,
        code: accountCode,
        name: name.trim(),
        type,
        currency: normalizedCurrency,
        isActive: true,
      },
    },
    { status: 201 }
  );
}