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

const FORBIDDEN_KEYS = [
  "password",
  "password_hash",
  "passwordHash",
  "jwt",
  "token",
  "DATABASE_URL",
  "secret",
  "JWT_SECRET",
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
}
