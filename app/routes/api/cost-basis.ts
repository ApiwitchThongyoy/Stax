import type { Route } from "./+types/cost-basis";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { db } from "~/lib/drizzle-db";
import { costBasisState } from "~/db/schema";
import { eq } from "drizzle-orm";

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
    const rows = await db
      .select({
        symbol: costBasisState.symbol,
        quantity: costBasisState.quantity,
        avgCost: costBasisState.avgCost,
        updatedAt: costBasisState.updatedAt,
      })
      .from(costBasisState)
      .where(eq(costBasisState.userId, auth.userId))
      .orderBy(costBasisState.symbol)
      .execute();
    return Response.json({ success: true, data: rows }, { status: 200 });
  } catch (error) {
    console.error("Cost basis GET: failed", error);
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