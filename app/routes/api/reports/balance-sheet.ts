import type { Route } from "./+types/balance-sheet";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { getBalanceSheet, seedDefaultChartOfAccounts } from "~/lib/ledger-service";

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

function isValidIsoDate(value: string): boolean {
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  return true;
}

export async function loader({ request }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  const url = new URL(request.url);
  const to = url.searchParams.get("to") ?? undefined;
  if (to && !isValidIsoDate(to)) {
    return Response.json(
      { success: false, message: "to must be an ISO date (yyyy-mm-dd)" },
      { status: 400 }
    );
  }

  try {
    await seedDefaultChartOfAccounts(auth.userId);
    const report = await getBalanceSheet(auth.userId, to);
    return Response.json({ success: true, data: report }, { status: 200 });
  } catch (error) {
    console.error("Balance sheet GET: failed", error);
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