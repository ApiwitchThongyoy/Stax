import { eq, and, inArray } from "drizzle-orm";
import type { Route } from "./+types/analysis";
import { db } from "~/lib/drizzle-db";
import { capitalTransactions } from "~/db/schema";
import { verifyAuth, isAuthError, authErrorResponse } from "~/lib/auth-middleware";
import { analyzeWithGemini, type TransactionAggregates } from "~/lib/gemini-analysis";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";
import { notifyAnalysisComplete } from "~/lib/notification-service";

export async function loader(_: Route.LoaderArgs) {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

const MAX_DOC_IDS = 20;

/**
 * POST /api/v1/analysis
 * body: { documentIds?: string[] }
 *
 * Produces neutral, informational AI insights about the authenticated user's
 * imported statement activity. All figures in the response context are computed
 * deterministically from the user's OWN rows; Gemini only produces qualitative
 * text (summary / patterns / data quality / tax-readiness explanation) and is
 * strictly schema-validated. Gemini NEVER computes tax or invents financial
 * values.
 *
 * Returns { available: false, code, errors } when Gemini is unavailable.
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

  const rawDocIds = (body as { documentIds?: unknown })?.documentIds;
  let docIds: string[] | undefined;
  if (rawDocIds !== undefined) {
    if (!Array.isArray(rawDocIds)) {
      return Response.json(
        { success: false, message: "documentIds must be an array" },
        { status: 400 }
      );
    }
    docIds = rawDocIds
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim());
    if (docIds.length > MAX_DOC_IDS) {
      return Response.json(
        { success: false, message: `documentIds exceeds maximum of ${MAX_DOC_IDS}` },
        { status: 400 }
      );
    }
  }

  try {
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
          docIds !== undefined && docIds.length > 0
            ? inArray(capitalTransactions.sourceDocumentId, docIds)
            : undefined
        )
      )
      .execute();

    if (rows.length === 0) {
      return Response.json({
        success: true,
        data: {
          available: false,
          code: "NO_TRANSACTIONS",
          errors: ["ยังไม่มีธุรกรรมที่ต้องการวิเคราะห์"],
        },
      });
    }

    // Compute deterministic aggregates from the user's authoritative rows only.
    const sumThb = (rows: Array<{ amountThb: string; type: string }>, type: string): string => {
      const total = rows
        .filter((r) => r.type === type)
        .reduce((acc, r) => {
          const v = Number(r.amountThb);
          return acc + (Number.isNaN(v) ? 0 : v);
        }, 0);
      return total.toFixed(2);
    };

    const dates = rows.map((r) => r.transactionDate.slice(0, 10)).sort();
    const aggregates: TransactionAggregates = {
      transactionCount: rows.length,
      currencies: Array.from(new Set(rows.map((r) => r.currency))).sort(),
      minDate: dates[0] ?? "",
      maxDate: dates[dates.length - 1] ?? "",
      cashInTotalThb: sumThb(rows, "CASH_IN"),
      cashOutTotalThb: sumThb(rows, "CASH_OUT"),
    };

    let outcome;
    try {
      outcome = await analyzeWithGemini(aggregates);
    } catch (error) {
      const code = String(
        error instanceof Error ? error.message : "gemini_request_failed"
      );
      await insertAuditLog({
        userId: auth.userId,
        action: AuditAction.GEMINI_PARSE_FAILED,
        entityType: "Capital_Transactions",
        details: {
          route: "/api/v1/analysis",
          method: "POST",
          result: "unavailable",
          code,
        },
      }).catch(() => {});
      return Response.json({
        success: true,
        data: {
          available: false,
          code,
          errors: ["การวิเคราะห์ด้วย Gemini ไม่พร้อมใช้งาน"],
        },
      });
    }

    await insertAuditLog({
      userId: auth.userId,
      action: AuditAction.GEMINI_PARSE,
      entityType: "Capital_Transactions",
      details: {
        route: "/api/v1/analysis",
        method: "POST",
        result: "success",
        model: outcome.model,
        transactionCount: aggregates.transactionCount,
      },
    });
    await notifyAnalysisComplete(
      auth.userId,
      `ธุรกรรม ${aggregates.transactionCount} รายการ`,
      docIds !== undefined ? docIds.slice().sort().join(",") : "all"
    );

    return Response.json({
      success: true,
      data: {
        available: true,
        code: null,
        result: outcome.result,
        aggregates,
      },
    });
  } catch (error) {
    console.error("Analysis POST: failed to query", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
