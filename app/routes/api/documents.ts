import type { Route } from "./+types/documents";
import { eq, desc } from "drizzle-orm";
import { db } from "~/lib/drizzle-db";
import { documents } from "~/db/schema";
import {
  verifyAuth,
  authErrorResponse,
  isAuthError,
} from "~/lib/auth-middleware";

/**
 * User-scoped Statement archive list.
 *
 * Returns ONLY the authenticated user's own document metadata (safe fields),
 * never another user's rows. The `file_path` (server filesystem path) is
 * intentionally omitted — the frontend does not need it.
 */
export async function action() {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
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
        id: documents.id,
        originalName: documents.originalName,
        mimeType: documents.mimeType,
        fileSize: documents.fileSize,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(eq(documents.userId, auth.userId))
      .orderBy(desc(documents.createdAt))
      .execute();

    return Response.json({ success: true, data: rows }, { status: 200 });
  } catch (error) {
    console.error("Documents GET: failed to query", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
