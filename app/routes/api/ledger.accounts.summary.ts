import { safeErrorLog } from "~/lib/safe-error-log";
import type { Route } from "./+types/ledger.accounts.summary";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { getAccountCategorySummary, seedDefaultChartOfAccounts } from "~/lib/ledger-service";
import type { AccountType } from "~/lib/general-ledger";

const ACCOUNT_TYPES: AccountType[] = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

function isValidIsoDate(value: string): boolean {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

/**
 * Batch ledger summary for ALL accounts of one account class. One request (no
 * per-account N+1) returns each account's opening/movement/closing/lineCount
 * plus per-currency totals, always scoped to the authenticated user and always
 * computed from POSTED lines only (SKIPPED entries never move a total).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  const url = new URL(request.url);
  const rawType = (url.searchParams.get("type") ?? "").trim().toUpperCase();
  if (!ACCOUNT_TYPES.includes(rawType as AccountType)) {
    return Response.json(
      { success: false, message: `type must be one of: ${ACCOUNT_TYPES.join(", ")}` },
      { status: 400 }
    );
  }
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  if ((from !== undefined && !isValidIsoDate(from)) || (to !== undefined && !isValidIsoDate(to)) || (from && to && from > to)) {
    return Response.json(
      { success: false, message: "from/to must be ISO dates (yyyy-mm-dd)" },
      { status: 400 }
    );
  }

  try {
    await seedDefaultChartOfAccounts(auth.userId);
    const data = await getAccountCategorySummary(auth.userId, rawType as AccountType, from, to);
    return Response.json({ success: true, data }, { status: 200 });
  } catch (error) {
    console.error("Ledger accounts-summary GET: failed", safeErrorLog(error));
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
