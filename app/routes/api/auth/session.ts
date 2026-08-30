import type { Route } from "./+types/session";
import {
  verifyAuth,
  authErrorResponse,
  isAuthError,
} from "~/lib/auth-middleware";

/**
 * Lightweight account/session status endpoint used by the authenticated USER
 * dashboard's periodic polling. Resolves the authoritative user record from the
 * database via verifyAuth (never the JWT alone). When the account is SUSPENDED,
 * verifyAuth returns 403 + code "ACCOUNT_SUSPENDED", which this route forwards
 * so the client can activate the suspension overlay. No password_hash or
 * unnecessary user fields are ever exposed.
 */
export async function loader({ request }: Route.LoaderArgs) {
  if (request.method !== "GET") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405 }
    );
  }

  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  return Response.json(
    {
      success: true,
      data: {
        userId: auth.userId,
        role: auth.role,
        status: "ACTIVE",
      },
    },
    { status: 200 }
  );
}
