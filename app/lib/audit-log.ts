import { randomUUID } from "node:crypto";
import { db } from "./drizzle-db";
import { auditLogs } from "../db/schema";

export interface AuditLogInput {
  userId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
}

export const AuditAction = {
  REGISTER_SUCCESS: "REGISTER_SUCCESS",
  REGISTER_FAILED: "REGISTER_FAILED",
  LOGIN_SUCCESS: "LOGIN_SUCCESS",
  LOGIN_FAILED: "LOGIN_FAILED",
  STATEMENT_UPLOAD: "STATEMENT_UPLOAD",
  STATEMENT_IMPORT: "STATEMENT_IMPORT",
  STATEMENT_DELETE: "STATEMENT_DELETE",
  GEMINI_PARSE: "GEMINI_PARSE",
  GEMINI_PARSE_FAILED: "GEMINI_PARSE_FAILED",
  CAPITAL_TRANSACTION_CREATE: "CAPITAL_TRANSACTION_CREATE",
  CAPITAL_TRANSACTION_UPDATE: "CAPITAL_TRANSACTION_UPDATE",
  CAPITAL_TRANSACTION_DELETE: "CAPITAL_TRANSACTION_DELETE",
  ADMIN_LOGIN_SUCCESS: "ADMIN_LOGIN_SUCCESS",
  ADMIN_USER_LIST_VIEW: "ADMIN_USER_LIST_VIEW",
  ADMIN_USER_STATUS_UPDATE: "ADMIN_USER_STATUS_UPDATE",
  ADMIN_UNAUTHORIZED_ACCESS: "ADMIN_UNAUTHORIZED_ACCESS",
  SETTINGS_UPDATE: "SETTINGS_UPDATE",
  NOTIFICATION_LIST_VIEW: "NOTIFICATION_LIST_VIEW",
  NOTIFICATION_MARK_READ: "NOTIFICATION_MARK_READ",
  NOTIFICATION_READ_ALL: "NOTIFICATION_READ_ALL",
} as const;

const FORBIDDEN_KEYS = [
  "password",
  "password_hash",
  "passwordHash",
  "jwt",
  "token",
  "authorization",
  "api_key",
  "apikey",
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "secret",
  "JWT_SECRET",
  "pdf",
  "statement_text",
  "statementtext",
  "file_content",
  "filecontent",
];

function sanitizeDetails(
  details: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!details || typeof details !== "object") return null;

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const lowerKey = key.toLowerCase();
    if (FORBIDDEN_KEYS.some((fk) => lowerKey.includes(fk.toLowerCase()))) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export async function insertAuditLog(input: AuditLogInput): Promise<void> {
  const id = randomUUID();
  const now = new Date().toISOString();

  try {
    await db
      .insert(auditLogs)
      .values({
        id,
        userId: input.userId ?? null,
        action: input.action,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        details: sanitizeDetails(input.details),
        createdAt: now,
      })
      .execute();
  } catch (error) {
    // Best-effort by design: an audit write failure must never turn a successful
    // login/import/delete into a 500, nor trigger error/cleanup paths. Log and
    // move on — the audit trail is observability, not a source of truth.
    console.error("insertAuditLog: failed to persist audit entry", error);
  }
}
