import { and, eq, inArray } from "drizzle-orm";
import type { Route } from "./+types/calculate";
import { db } from "~/lib/drizzle-db";
import { capitalTransactions } from "~/db/schema";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import {
  buildNonComputableTaxRecon,
  type CapitalTransactionLike,
} from "~/lib/tax-engine";

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

export async function loader(_: Route.LoaderArgs) {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

const MAX_TRANSACTION_IDS = 500;

/**
 * W1-2 — protected tax reconstruction endpoint.
 *
 * POST /api/v1/tax/calculate
 * body: { transactionIds?: string[] }
 *
 * Fetches ONLY the current user's transactions from the DB (ownership is
 * enforced by the WHERE clause on userId).
 *
 * SEMANTIC NOTE: the Capital_Transactions schema stores raw cash only and does
 * not carry cost basis / proceeds, so true realized gain/loss (and hence a
 * taxable amount) CANNOT be computed here. The endpoint therefore returns the
 * neutral signed cash value (transactionAmountThb) per row and marks the tax
 * outcome as explicitly NOT computable — it never treats CASH_IN/CASH_OUT as
 * realized profit/loss. The deterministic Decimal engine is only used when an
 * authoritative upstream caller supplies a real realized gain/loss.
 *
 * All monetary values cross the API as strings.
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405 }
    );
  }

  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, message: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const rawIds = (body as { transactionIds?: unknown })?.transactionIds;
  if (rawIds === undefined) {
    return Response.json(
      { success: false, message: "transactionIds is required" },
      { status: 400 }
    );
  }
  if (!Array.isArray(rawIds)) {
    return Response.json(
      { success: false, message: "transactionIds must be an array" },
      { status: 400 }
    );
  }

  const ids = rawIds
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());

  if (ids.length === 0) {
    return Response.json(
      { success: false, message: "transactionIds must contain at least one id" },
      { status: 400 }
    );
  }
  if (ids.length > MAX_TRANSACTION_IDS) {
    return Response.json(
      {
        success: false,
        message: `transactionIds exceeds maximum of ${MAX_TRANSACTION_IDS}`,
      },
      { status: 400 }
    );
  }

  try {
    // Ownership is enforced here: rows are scoped to the authenticated user.
    const rows = await db
      .select({
        transactionId: capitalTransactions.transactionId,
        transactionDate: capitalTransactions.transactionDate,
        currency: capitalTransactions.currency,
        amountThb: capitalTransactions.amountThb,
        type: capitalTransactions.type,
      })
      .from(capitalTransactions)
      .where(
        and(
          eq(capitalTransactions.userId, auth.userId),
          inArray(capitalTransactions.transactionId, ids)
        )
      )
      .execute();

    // Only the user's own rows are used. Unknown/foreign ids are ignored.
    // The reconstruction is explicitly "not computable" — no realized gain/loss
    // and no taxable total is fabricated from raw cash flows.
    const likeRows: CapitalTransactionLike[] = rows.map((row) => ({
      transactionId: row.transactionId,
      amountThb: row.amountThb,
      type: row.type,
    }));
    const summary = buildNonComputableTaxRecon(likeRows);

    // Enrich each row with date/currency metadata from the authoritative DB row.
    const enriched = summary.transactions.map((t) => {
      const row = rows.find((r) => r.transactionId === t.transactionId);
      return {
        ...t,
        transactionDate: row?.transactionDate ?? null,
        currency: row?.currency ?? null,
      };
    });

    return Response.json(
      {
        success: true,
        data: {
          computable: summary.computable,
          reason: summary.reason,
          transactions: enriched,
          totalTaxableAmountThb: summary.totalTaxableAmountThb,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("TaxCalculate: failed to query", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
