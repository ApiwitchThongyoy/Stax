import { eq, and } from "drizzle-orm";
import type { Route } from "./+types/documents.$id.download";
import { db } from "~/lib/drizzle-db";
import { documents } from "~/db/schema";
import {
  verifyAuth,
  authErrorResponse,
  isAuthError,
} from "~/lib/auth-middleware";
import {
  getStorageDriver,
} from "~/lib/storage/storage-driver";
import {
  sanitizeDownloadFilename,
} from "~/lib/storage/statement-storage";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PDF_MIME_TYPE = "application/pdf";

function safeNotFound(): Response {
  return Response.json(
    { success: false, message: "Document not found" },
    { status: 404 }
  );
}

function internalError(): Response {
  return Response.json(
    { success: false, message: "Internal server error" },
    { status: 500 }
  );
}

/**
 * Server-authoritative Statement download.
 *
 * GET /api/v1/documents/:id/download
 *
 * Serves the actual stored PDF bytes for one of the AUTHENTICATED user's OWN
 * documents. The document is looked up by (id, auth.userId) so another user can
 * never request it; a miss returns the same safe 404 as a genuinely-missing
 * document, so we never reveal whether a document with that id belongs to
 * someone else.
 *
 * Storage:
 *   - bytes come from the active storage driver (private Supabase Storage in
 *     production, the filesystem store in local dev/tests),
 *   - the object key is taken only from the caller's own DB row, never from
 *     params, and is bounded/validated by the driver,
 *   - the object key is never returned in any response,
 *   - a missing/unsafe object returns a safe 404 without recreating metadata,
 *   - a download failure returns a sanitized 404/500 with no internal details.
 *
 * Security:
 *   - service-role credentials are never exposed and no unsigned URLs are ever
 *     generated — the server fetches the object,
 *   - the original filename is re-sanitized before use in Content-Disposition.
 */
export async function action() {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

export async function loader({ request, params }: Route.LoaderArgs) {
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

  const { id } = params;
  if (!id || !UUID_REGEX.test(id)) {
    return Response.json(
      { success: false, message: "Invalid document id" },
      { status: 400 }
    );
  }

  // Load the caller's OWN document metadata (incl. server file path). If it is
  // absent for THIS user we return a safe 404 without revealing whether another
  // user holds a document with that id.
  let ownDoc;
  try {
    const rows = await db
      .select({
        filePath: documents.filePath,
        originalName: documents.originalName,
        mimeType: documents.mimeType,
      })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, auth.userId)))
      .limit(1)
      .execute();
    ownDoc = rows[0] ?? null;
  } catch (error) {
    console.error("DocumentDownload: failed to query document", error);
    return internalError();
  }

  if (!ownDoc) {
    // Safe 404 — indistinguishable from "does not exist".
    return safeNotFound();
  }

  // Fetch the object through the active storage driver. The key comes from the
  // caller's own DB row only; drivers validate/contain it, so a corrupted or
  // malicious value can never be used to reach anything else.
  let bytes: Uint8Array | null;
  try {
    bytes = await getStorageDriver().readPdf(ownDoc.filePath);
  } catch (error) {
    console.warn(
      `DocumentDownload: stored object unavailable, documentId=${id}`
    );
    if (error instanceof Error) console.warn("DocumentDownload:", error.message);
    return internalError();
  }

  if (!bytes) {
    // Missing object or rejected key — same safe 404, no metadata rewrite.
    console.warn(
      `DocumentDownload: stored object missing/unusable, documentId=${id}`
    );
    return safeNotFound();
  }

  const headers = new Headers();
  headers.set("Content-Type", ownDoc.mimeType || PDF_MIME_TYPE);
  headers.set(
    "Content-Disposition",
    `attachment; filename="${sanitizeDownloadFilename(ownDoc.originalName)}"`
  );
  headers.set("Content-Length", String(bytes.byteLength));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "private, no-store");

  // Buffer.from copies into a regular ArrayBuffer so the Response body typing is
  // satisfied on the server regardless of the Uint8Array's buffer type.
  return new Response(Buffer.from(bytes), { headers });
}
