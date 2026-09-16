import type { Route } from "./+types/refresh";
import { verifyAuth, authErrorResponse, isAuthError } from "~/lib/auth-middleware";
import { refreshStockPrices } from "~/lib/stock-price-refresh";
import { handleStockPriceRefresh } from "~/lib/stock-price-refresh-handler.server";

async function authorizeAdmin(request: Request): Promise<Response | null> {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) return authErrorResponse(auth);
  if (auth.role !== "ADMIN") {
    return Response.json(
      { success: false, message: "Forbidden" },
      { status: 403 }
    );
  }
  return null;
}

function refresh(request: Request) {
  return handleStockPriceRefresh(request, {
    cronSecret: process.env.CRON_SECRET,
    refresh: refreshStockPrices,
    authorizeAdmin,
  });
}

/** Vercel Cron sends GET with Authorization: Bearer <CRON_SECRET>. */
export async function loader({ request }: Route.LoaderArgs) {
  return refresh(request);
}

/** Manual POST supports the cron secret or a DB-authoritative ADMIN JWT. */
export async function action({ request }: Route.ActionArgs) {
  return refresh(request);
}
