import { timingSafeEqual } from "node:crypto";
import type { StockPriceRefreshStats } from "./stock-price-refresh";

interface RefreshDependencies {
  cronSecret: string | undefined;
  refresh: () => Promise<StockPriceRefreshStats>;
  authorizeAdmin: (request: Request) => Promise<Response | null>;
}

function secretMatches(value: string | null, secret: string): boolean {
  if (value === null) return false;
  const actual = Buffer.from(value);
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Shared by the route's GET loader and POST action; dependencies keep tests DB-free. */
export async function handleStockPriceRefresh(
  request: Request,
  { cronSecret, refresh, authorizeAdmin }: RefreshDependencies
): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "GET" && request.method !== "POST") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405, headers: { ...headers, Allow: "GET, POST" } }
    );
  }

  const authorization = request.headers.get("Authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : null;
  // Fail closed when the server secret is absent/blank. Keep the existing
  // x-cron-secret alternative for manual callers; Vercel uses Bearer.
  const isCron = Boolean(
    cronSecret?.trim() &&
      (secretMatches(bearer, cronSecret) ||
        secretMatches(request.headers.get("x-cron-secret"), cronSecret))
  );

  if (!isCron) {
    // GET is exclusively cron-authenticated; never fall back to a browser/JWT.
    if (request.method === "GET") {
      return Response.json(
        { success: false, message: "Unauthorized" },
        { status: 401, headers }
      );
    }
    // Preserve the existing on-demand ADMIN POST flow.
    const denied = await authorizeAdmin(request);
    if (denied) {
      denied.headers.set("Cache-Control", "no-store");
      return denied;
    }
  }

  try {
    const stats = await refresh();
    return Response.json({ success: true, data: stats }, { headers });
  } catch {
    // Do not log request credentials or raw upstream/DB errors.
    console.error("Stock prices refresh: failed");
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500, headers }
    );
  }
}
