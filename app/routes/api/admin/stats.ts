import { and, eq, gte, sql } from "drizzle-orm";
import type { Route } from "./+types/stats";
import { db } from "~/lib/drizzle-db";
import { users, documents } from "~/db/schema";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { isGeminiConfigured } from "~/lib/gemini-statement-parser";

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

  if (auth.role !== "ADMIN") {
    return Response.json(
      { success: false, message: "Forbidden" },
      { status: 403 }
    );
  }

  try {
    const userRows = await db
      .select({ status: users.status })
      .from(users)
      .execute();

    let total = 0;
    let active = 0;
    let suspended = 0;
    for (const u of userRows) {
      total++;
      if (u.status === "SUSPENDED") suspended++;
      else active++;
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const docTotalRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .execute();

    const doc7Rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .where(gte(documents.createdAt, sevenDaysAgo))
      .execute();

    const perDay = await db
      .select({
        date: sql<string>`to_char(${documents.createdAt}::date, 'YYYY-MM-DD')`,
        files: sql<number>`count(*)::int`,
      })
      .from(documents)
      .where(gte(documents.createdAt, sevenDaysAgo))
      .groupBy(sql`to_char(${documents.createdAt}::date, 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(${documents.createdAt}::date, 'YYYY-MM-DD')`)
      .execute();

    const fxProviderOk = true; // keyless built-in historical FX provider
    const geminiOk = isGeminiConfigured();
    const taxEngineOk = true;
    const connectedApis = [fxProviderOk, geminiOk, taxEngineOk].filter(Boolean).length;
    const totalApis = 3;

    return Response.json(
      {
        success: true,
        data: {
          userCounts: { total, active, suspended },
          documents: {
            total: docTotalRows[0]?.count ?? 0,
            last7Days: doc7Rows[0]?.count ?? 0,
            perDay: perDay.map((row) => ({
              date: row.date,
              files: row.files,
            })),
          },
          apiStatus: {
            connected: connectedApis,
            total: totalApis,
            fxProvider: { configured: fxProviderOk },
            gemini: { configured: geminiOk },
            taxEngine: { configured: taxEngineOk },
          },
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("AdminStats GET: failed to query", error);
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
