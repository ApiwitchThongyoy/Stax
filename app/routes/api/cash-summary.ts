import type { Route } from "./+types/cash-summary";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import {
  getCashSummary,
  type CashSummaryOptions,
} from "~/lib/cash-summary";

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

const ISO_MONTH = /^\d{4}-\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function resolveOptions(url: URL): { opts: CashSummaryOptions } | { error: string } {
  const month = url.searchParams.get("month") ?? undefined;
  const asOf = url.searchParams.get("asOf") ?? undefined;
  const withDetail = url.searchParams.get("withDetail") === "1";

  if (month !== undefined && !ISO_MONTH.test(month)) {
    return { error: "month must be YYYY-MM" };
  }
  if (asOf !== undefined && !ISO_DATE.test(asOf)) {
    return { error: "asOf must be YYYY-MM-DD" };
  }
  if (month !== undefined && asOf !== undefined) {
    return { error: "month and asOf cannot be combined" };
  }

  const opts: CashSummaryOptions = {};
  if (month !== undefined) opts.month = month;
  if (asOf !== undefined) opts.asOf = asOf;
  if (withDetail) opts.withDetail = true;
  return { opts };
}

export async function loader({ request }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  const url = new URL(request.url);
  const resolved = resolveOptions(url);
  if ("error" in resolved) {
    return Response.json(
      { success: false, message: resolved.error },
      { status: 400 }
    );
  }

  try {
    const summary = await getCashSummary(auth.userId, resolved.opts);
    return Response.json({ success: true, data: summary }, { status: 200 });
  } catch (error) {
    console.error("Cash summary GET: failed", error);
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