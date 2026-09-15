import type { Route } from "./+types/refresh";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { refreshStockPrices } from "~/lib/stock-price-refresh";

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

/**
 * Daily stock-price sweep endpoint. Authorized two ways:
 *   1. Vercel Cron — when CRON_SECRET is set, Vercel appends
 *      `Authorization: Bearer <CRON_SECRET>` to the cron request; the
 *      `x-cron-secret` header is also accepted for manual `curl` runs.
 *   2. ADMIN JWT — a signed-in admin can trigger a refresh on demand.
 *
 * Persists today's close for every tracked symbol and reports idempotent
 * stats; provider failures are listed (never thrown). Works fine pre-deploy via
 * the lazy refresh baked into GET /api/v1/stock-prices.
 */
async function tryCronRefresh(request: Request): Promise<Response | null> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;

  const headerSecret = request.headers.get("x-cron-secret");
  const authHeader = request.headers.get("Authorization");
  const isCron =
    headerSecret === secret ||
    (authHeader !== null &&
      authHeader.startsWith("Bearer ") &&
      authHeader.slice(7) === secret);

  if (!isCron) return null;

  try {
    const stats = await refreshStockPrices();
    return Response.json({ success: true, data: stats }, { status: 200 });
  } catch (error) {
    console.error("Stock prices refresh: failed", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}

async function runAdminRefresh(request: Request): Promise<Response> {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }
  if (auth.role !== "ADMIN") {
    return Response.json(
      { success: false, message: "Forbidden" },
      { status: 403 }
    );
  }
  try {
    const stats = await refreshStockPrices();
    return Response.json({ success: true, data: stats }, { status: 200 });
  } catch (error) {
    console.error("Stock prices refresh: failed", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}

/** GET is the Vercel cron method; browsers get a clean 405 so nothing auto-runs. */
export async function loader({ request }: Route.LoaderArgs) {
  const cron = await tryCronRefresh(request);
  if (cron) return cron;
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

/** POST supports manual refresh (cron secret or ADMIN JWT). */
export async function action({ request }: Route.ActionArgs) {
  const cron = await tryCronRefresh(request);
  if (cron) return cron;
  return runAdminRefresh(request);
}