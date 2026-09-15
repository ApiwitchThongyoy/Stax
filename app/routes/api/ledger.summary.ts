import type { Route } from "./+types/ledger.summary";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { getLedgerSummary, seedDefaultChartOfAccounts } from "~/lib/ledger-service";

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
    await seedDefaultChartOfAccounts(auth.userId);
    const summary = await getLedgerSummary(auth.userId);
    return Response.json({ success: true, data: summary }, { status: 200 });
  } catch (error) {
    console.error("Ledger summary GET: failed", error);
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