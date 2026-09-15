import type { Route } from "./+types/stock-prices";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { resolveStockQuotes } from "~/lib/stock-price-refresh";

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

/**
 * GET /api/v1/stock-prices?symbols=AAPL,MSFT
 *
 * Returns the latest daily close for each requested symbol (cache-first, with a
 * lazy refresh when the stored price is older than ~1 day). Provider failures
 * fall back to the last-known price — never a fabricated one; symbols without
 * any price are simply omitted.
 *
 * Authenticated endpoint (auth required). Quote data is global market reference
 * data; the caller is only allowed to query — writing happens via the cron/admin
 * refresh route.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  const url = new URL(request.url);
  const raw = url.searchParams.get("symbols");
  const symbols = raw
    ? raw
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0)
    : [];

  if (symbols.length === 0) {
    return Response.json({ success: true, data: [] }, { status: 200 });
  }

  try {
    const quotes = await resolveStockQuotes(symbols);
    return Response.json({ success: true, data: quotes }, { status: 200 });
  } catch (error) {
    console.error("Stock prices GET: failed", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function action(_: Route.ActionArgs) {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}