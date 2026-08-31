// Pure, DB-free helpers for Statement duplicate detection. Kept separate from
// statement-storage.ts (which opens a DB connection at import time) so unit
// tests can import this module without any database configuration.
import { createHash } from "node:crypto";

/**
 * Deterministic SHA-256 content hash of the uploaded PDF bytes. Used as the
 * user-scoped duplicate-detection key. Same bytes always yield the same hash;
 * different bytes yield a (practically) different hash.
 */
export function computeContentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

export const STATEMENT_ALREADY_IMPORTED = "STATEMENT_ALREADY_IMPORTED";

/**
 * Assemble the duplicate-detection response payload. `existingDocumentId` is
 * the current user's own previously-imported document id (never another user's);
 * it may be null when the duplicate was caught by the DB-unique-race path.
 */
export function buildDuplicatePayload(existingDocumentId: string | null): {
  duplicate: true;
  code: typeof STATEMENT_ALREADY_IMPORTED;
  message: string;
  existingDocumentId: string | null;
} {
  return {
    duplicate: true,
    code: STATEMENT_ALREADY_IMPORTED,
    message: "Statement นี้เคยถูกนำเข้าแล้ว",
    existingDocumentId,
  };
}
