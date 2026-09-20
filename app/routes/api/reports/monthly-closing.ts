import type { Route } from "./+types/monthly-closing";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { getMonthlyClosing, seedDefaultChartOfAccounts } from "~/lib/ledger-service";

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
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  if ((from && !isValidIsoDate(from)) || (to && !isValidIsoDate(to))) {
    return Response.json(
      { success: false, message: "from/to must be ISO dates (yyyy-mm-dd)" },
      { status: 400 }
    );
  }

  // The monthly-closing numbers are as-of snapshots: `from`/`to` only choose
  // which months are REPORTED; every month's opening is still computed from
  // the full prior history, so the figures equal a plain book-closing run.
  try {
    await seedDefaultChartOfAccounts(auth.userId);
    const report = await getMonthlyClosing(auth.userId, from, to);
    return Response.json({ success: true, data: report }, { status: 200 });
  } catch (error) {
    console.error("Monthly closing GET: failed", error);
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