import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "../drizzle-db";
import { documents } from "../../db/schema";
import { computeContentHash } from "../statement-hash";
import {
  STATEMENTS_DIR,
  sanitizeDownloadFilename,
  safeResolveStoredPath,
} from "./statement-path";
import {
  buildObjectKey,
  getStorageDriver,
} from "./storage-driver";

// No size limit existed in the previous system; 20 MB is a safe default for statement PDFs.
export const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024;

const PDF_MIME_TYPE = "application/pdf";
const PDF_MAGIC = "%PDF-";
const MAX_ORIGINAL_NAME_LENGTH = 200;

export interface StatementSaveInput {
  userId: string;
  file: File;
}

export interface StoredStatementMeta {
  id: string;
  userId: string;
  originalName: string;
  contentHash: string;
  filePath: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
  bytes: Uint8Array;
}

export type SaveStatementResult =
  | { ok: true; document: StoredStatementMeta }
  | { ok: false; status: number; message: string };

// Never trust the client filename for storage paths. Keep a sanitized copy
// of the original name for display purposes in the documents table only.
export function sanitizeOriginalName(name: string): string {
  const base = path.basename(name ?? "");
  const cleaned = base.replace(/[\x00-\x1f\x7f/\\]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "statement.pdf";
  }
  return cleaned.slice(0, MAX_ORIGINAL_NAME_LENGTH);
}

/**
 * Header-safe filename + strict path containment for downloads.
 *
 * Implemented in the DB-free `./statement-path` module; re-exported here for the
 * routes that consume them so download logic stays cherry-picked, testable
 * without a database, and out of the storage write path.
 */
export { sanitizeDownloadFilename, safeResolveStoredPath, STATEMENTS_DIR };

export function validatePdfFile(file: File): { ok: true } | { ok: false; message: string } {
  if (!file || typeof file.size !== "number" || file.size <= 0) {
    return { ok: false, message: "File is empty or missing" };
  }

  if (file.size > MAX_PDF_SIZE_BYTES) {
    return {
      ok: false,
      message: `File exceeds maximum allowed size of ${MAX_PDF_SIZE_BYTES} bytes`,
    };
  }

  const lowerName = (file.name ?? "").toLowerCase();
  if (!lowerName.endsWith(".pdf")) {
    return { ok: false, message: "Only .pdf files are supported" };
  }

  if (file.type && file.type !== PDF_MIME_TYPE) {
    return { ok: false, message: "Only application/pdf files are supported" };
  }

  return { ok: true };
}

// MIME type from the client is not trusted on its own — verify the %PDF- magic bytes.
async function hasPdfMagicBytes(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, PDF_MAGIC.length).arrayBuffer());
  const decoded = Buffer.from(head).toString("latin1");
  return decoded === PDF_MAGIC;
}

/**
 * Look up whether this user has ALREADY imported a document with the same
 * content hash. Scoped strictly to `userId` so cross-user data is never
 * compared. Returns the user's own existing document id, or null.
 *
 * A DB partial unique index (documents_user_content_hash_key) backs this with
 * a hard guarantee for new hashed imports; existing NULL-hash historical rows
 * are excluded from it.
 */
export async function findExistingDocumentByHash(
  userId: string,
  contentHash: string
): Promise<{ id: string } | null> {
  const { eq, and } = await import("drizzle-orm");
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(eq(documents.userId, userId), eq(documents.contentHash, contentHash))
    )
    .limit(1)
    .execute();
  return rows[0] ?? null;
}

export async function saveStatementPdf(
  input: StatementSaveInput
): Promise<SaveStatementResult> {
  const { userId, file } = input;

  if (!userId) {
    return { ok: false, status: 400, message: "userId is required" };
  }

  const validation = validatePdfFile(file);
  if (!validation.ok) {
    return { ok: false, status: 400, message: validation.message };
  }

  try {
    if (!(await hasPdfMagicBytes(file))) {
      return { ok: false, status: 400, message: "File content is not a valid PDF" };
    }

    // SHA-256 of the file bytes, computed BEFORE storage so dedup can never
    // assign the hash to an object that was not actually persisted.
    const buffer = Buffer.from(await file.arrayBuffer());
    const contentHash = computeContentHash(new Uint8Array(buffer));

    // The document id is generated BEFORE storage so the object key is fully
    // server-side and deterministic: statements/<userId>/<documentId>.pdf.
    // Never derived from a client-supplied path.
    const documentId = randomUUID();
    const objectKey = buildObjectKey(userId, documentId);

    const driver = getStorageDriver();
    const stored = await driver.storePdf({ key: objectKey, bytes: buffer });
    if (!stored.ok) {
      return { ok: false, status: stored.status, message: stored.message };
    }

    const now = new Date().toISOString();
    const originalName = sanitizeOriginalName(file.name);

    try {
      await db
        .insert(documents)
        .values({
          id: documentId,
          userId,
          originalName,
          contentHash,
          filePath: objectKey,
          mimeType: PDF_MIME_TYPE,
          fileSize: file.size,
          createdAt: now,
          updatedAt: now,
        })
        .execute();
    } catch (error) {
      // The object was persisted but the DB insert failed — best-effort object
      // cleanup so no orphaned/unreferenced PDF is left behind. A concurrent
      // duplicate (postgres 23505) is rethrown so the route can report it as a
      // duplicate rather than a server failure.
      try {
        await driver.deletePdf(objectKey);
      } catch {
        // best-effort only
      }
      throw error;
    }

    return {
      ok: true,
      document: {
        id: documentId,
        userId,
        originalName,
        contentHash,
        filePath: objectKey,
        mimeType: PDF_MIME_TYPE,
        fileSize: file.size,
        createdAt: now,
        bytes: new Uint8Array(buffer),
      },
    };
  } catch (error) {
    if ((error as { code?: unknown })?.code === "23505") {
      throw error;
    }
    console.error("saveStatementPdf: failed to store document", error);
    return { ok: false, status: 500, message: "Internal server error" };
  }
}

/**
 * Remove the stored Statement PDF object for a deleted document, safely.
 *
 * Delegates to the active storage driver (Supabase Storage in production, the
 * filesystem store in local dev/tests). ENOENT / not-found is tolerated (the
 * object may already be absent) — this is best-effort cleanup that MUST NOT
 * fail the request. Returns `true` when removal succeeded or the object was
 * already gone, `false` on any other error (caller logs a warning).
 */
export async function deleteStoredFile(filePath: string): Promise<boolean> {
  if (!filePath || typeof filePath !== "string") {
    console.warn("deleteStoredFile: empty or invalid stored path");
    return true;
  }
  try {
    return await getStorageDriver().deletePdf(filePath);
  } catch (error) {
    console.warn("deleteStoredFile: failed to remove object", error);
    return false;
  }
}
