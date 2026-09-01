// Pure, DB-free helpers for serving stored Statement PDFs on download.
//
// Kept separate from statement-storage.ts (which opens a DB connection at
// import time) so unit tests can import this module without any database
// configuration. Also keeps the security-critical path containment + header
// safety logic easy to reason about in isolation.
import path from "node:path";

// Persistent storage root for uploaded statement PDFs. Files live on the
// filesystem only — PostgreSQL keeps metadata/path rows (documents table).
export const STATEMENTS_DIR = path.resolve(process.cwd(), "storage", "statements");

/**
 * Header-safe filename for Content-Disposition on download.
 *
 * The stored `original_name` is already sanitized, but we re-sanitize here so no
 * double quote, CR/LF, path separator, or control character can ever reach the
 * HTTP header. Returns a bare filename (base name only) guaranteed safe to embed
 * between double quotes in a Content-Disposition header.
 */
export function sanitizeDownloadFilename(name: string): string {
  const base = path.basename(name ?? "");
  // Strip anything that could break out of a double-quoted header param:
  // quotes, CR/LF (header injection), control chars, and path separators.
  const cleaned = base
    .replace(/[\x00-\x1f\x7f"\\/]/g, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "statement.pdf";
  }
  return cleaned.slice(0, 200);
}

/**
 * Resolve a stored file path and verify it stays STRICTLY inside `baseDir`
 * (defaults to STATEMENTS_DIR).
 *
 * Used before serving a download so a corrupted/malicious `file_path` row can
 * never cause arbitrary filesystem paths to be read. Returns the resolved path
 * when safe, or null when the value is empty / outside the base dir / a
 * traversal attempt. Never trusts a path coming from request params — only from
 * the caller's own DB row, and still bounded to `baseDir`.
 */
export function safeResolveStoredPath(
  filePath: string | null | undefined,
  baseDir: string = STATEMENTS_DIR
): string | null {
  if (!filePath || typeof filePath !== "string") {
    return null;
  }
  const root = path.resolve(baseDir);
  const resolved = path.resolve(filePath);
  // Strict containment: a path equal to the root itself is a directory, not a
  // valid document file.
  if (resolved === root) {
    return null;
  }
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}
