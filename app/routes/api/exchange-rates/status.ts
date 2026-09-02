import type { Route } from "./+types/status";
import { verifyAuth, isAuthError, authErrorResponse } from "~/lib/auth-middleware";
import { isGeminiConfigured } from "~/lib/gemini-statement-parser";
import { HISTORICAL_FX_SOURCE_NAME } from "~/lib/historical-fx-provider";

export async function action() {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

/**
 * GET /api/v1/exchange-rates/status
 *
 * Returns the status of external API integrations (FX provider, Gemini, Tax
 * Engine). Used by the admin dashboard to show real integration status. The
 * historical FX provider is keyless and built-in, so it is always configured.
 *
 * Authenticated — admin-only endpoint.
 */
export async function loader({ request }: Route.LoaderArgs) {
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

  const geminiConfigured = isGeminiConfigured();

  return Response.json(
    {
      success: true,
      data: {
        fxProvider: {
          configured: true,
          status: "built_in",
          name: HISTORICAL_FX_SOURCE_NAME,
        },
        gemini: {
          configured: geminiConfigured,
          status: geminiConfigured ? "configured" : "not_configured",
        },
        taxEngine: {
          configured: true,
          status: "built_in",
        },
      },
    },
    { status: 200 }
  );
}
