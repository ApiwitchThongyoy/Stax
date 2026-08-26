import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "../drizzle-db";
import { documents } from "../../db/schema";

// Persistent storage root for uploaded statement PDFs.
// Files live on the filesystem only — PostgreSQL keeps metadata/path rows (documents table).
export const STATEMENTS_DIR = path.resolve(process.cwd(), "storage", "statements");

// No size limit existed in the previous system; 20 MB is a safe default for statement PDFs.
export const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024;

const PDF_MIME_TYPE = "application/pdf";
const PDF_EXTENSION = ".pdf";
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
  filePath: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
}

export type SaveStatementResult =
  | { ok: true; document: StoredStatementMeta }
  | { ok: false; status: number; message: string };

function ensureStatementsDir(): void {
  mkdirSync(STATEMENTS_DIR, { recursive: true });
}

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
  if (!lowerName.endsWith(PDF_EXTENSION)) {
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

    ensureStatementsDir();

    // Stored under a random UUID name to prevent path traversal, collisions,
    // and overwriting other users' files. Original name is kept in the DB.
    const storedFileName = `${randomUUID()}${PDF_EXTENSION}`;
    const destination = path.join(STATEMENTS_DIR, storedFileName);

    if (!path.resolve(destination).startsWith(STATEMENTS_DIR)) {
      return { ok: false, status: 400, message: "Invalid storage path" };
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(destination, buffer);

    const now = new Date().toISOString();
    const documentId = randomUUID();

    await db
      .insert(documents)
      .values({
        id: documentId,
        userId,
        originalName: sanitizeOriginalName(file.name),
        filePath: destination,
        mimeType: PDF_MIME_TYPE,
        fileSize: file.size,
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    return {
      ok: true,
      document: {
        id: documentId,
        userId,
        originalName: sanitizeOriginalName(file.name),
        filePath: destination,
        mimeType: PDF_MIME_TYPE,
        fileSize: file.size,
        createdAt: now,
      },
    };
  } catch (error) {
    console.error("saveStatementPdf: failed to store document", error);
    return { ok: false, status: 500, message: "Internal server error" };
  }
}
