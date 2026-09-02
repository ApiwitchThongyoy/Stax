import type { Route } from "./+types/daily";
import { verifyAuth, isAuthError, authErrorResponse } from "~/lib/auth-middleware";
import { getDailyAggregation, getDailyAggregationByCurrency } from "~/lib/daily-aggregation";

export async function action() {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

/**
 * GET /api/v1/aggregation/daily?byCurrency=true
 *
 * Returns the authenticated user's daily aggregation of capital transactions.
 * Groups by transaction_date, sums amount_thb, counts transactions.
 * Optionally breaks down by currency (byCurrency=true).
 *
 * Computed from authoritative DB rows. No fabricated P/L.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  const url = new URL(request.url);
  const byCurrency = url.searchParams.get("byCurrency") === "true";

  try {
    if (byCurrency) {
      const rows = await getDailyAggregationByCurrency(auth.userId);
      return Response.json({ success: true, data: rows }, { status: 200 });
    }

    const rows = await getDailyAggregation(auth.userId);
    return Response.json({ success: true, data: rows }, { status: 200 });
  } catch (error) {
    console.error("AggregationDaily GET: failed to query", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
