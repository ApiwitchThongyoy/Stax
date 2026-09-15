import type { Route } from "./+types/corporate-actions";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";
import {
  createCorporateAction,
  listCorporateActions,
} from "~/lib/corporate-action-service";
import type { CorporateActionInput } from "~/lib/corporate-action";

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  try {
    const rows = await listCorporateActions(auth.userId);
    // Derived flag (not a column): legacy spin-offs recorded before the FMV
    // columns existed keep the old valuation; the UI can badge them for review
    // instead of the server guessing a backfill.
    const data = rows.map((r) => ({
      ...r,
      needsReview:
        r.actionType === "SPIN_OFF" &&
        (r.parentFmvPerShare == null || r.childFmvPerShare == null),
    }));
    return Response.json({ success: true, data }, { status: 200 });
  } catch (error) {
    console.error("CorporateActions GET: failed to query", error);
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

  const raw = (body ?? {}) as Record<string, unknown>;

  const input: CorporateActionInput = {
    symbol: typeof raw.symbol === "string" ? raw.symbol : "",
    actionType: (raw.actionType as CorporateActionInput["actionType"]) ?? "",
    transactionDate: typeof raw.transactionDate === "string" ? raw.transactionDate : "",
    ratioOld: typeof raw.ratioOld === "string" ? raw.ratioOld : null,
    ratioNew: typeof raw.ratioNew === "string" ? raw.ratioNew : null,
    newSymbol: typeof raw.newSymbol === "string" ? raw.newSymbol : null,
    sharesOut: typeof raw.sharesOut === "string" ? raw.sharesOut : null,
    priceOut: typeof raw.priceOut === "string" ? raw.priceOut : null,
    parentFmvPerShare:
      typeof raw.parentFmvPerShare === "string" ? raw.parentFmvPerShare : null,
    childFmvPerShare:
      typeof raw.childFmvPerShare === "string" ? raw.childFmvPerShare : null,
    cashInLieu:
      typeof raw.cashInLieu === "string" ? raw.cashInLieu : null,
    description: typeof raw.description === "string" ? raw.description : null,
  };

  const result = await createCorporateAction(auth.userId, input);
  if (!result.ok) {
    return Response.json(
      { success: false, message: "Invalid corporate action", errors: result.errors },
      { status: 422 }
    );
  }

  await insertAuditLog({
    userId: auth.userId,
    action: AuditAction.CORPORATE_ACTION_CREATE,
    entityType: "corporate_actions",
    entityId: result.id,
    details: {
      method: "POST",
      route: "/api/v1/corporate-actions",
      symbol: input.symbol,
      actionType: input.actionType,
      transactionDate: input.transactionDate,
    },
  });

  return Response.json(
    { success: true, data: { id: result.id } },
    { status: 201 }
  );
}