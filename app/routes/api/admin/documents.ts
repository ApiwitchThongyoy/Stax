import { desc, sql } from "drizzle-orm";
import type { Route } from "./+types/documents";
import { db } from "~/lib/drizzle-db";
import { documents, users } from "~/db/schema";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";

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

  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;

  try {
    const rows = await db
      .select({
        id: documents.id,
        originalName: documents.originalName,
        mimeType: documents.mimeType,
        fileSize: documents.fileSize,
        createdAt: documents.createdAt,
        userEmail: users.email,
      })
      .from(documents)
      .leftJoin(users, sql`${users.id} = ${documents.userId}`)
      .orderBy(desc(documents.createdAt))
      .limit(limit)
      .execute();

    return Response.json({ success: true, data: rows }, { status: 200 });
  } catch (error) {
    console.error("AdminDocuments GET: failed to query", error);
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
