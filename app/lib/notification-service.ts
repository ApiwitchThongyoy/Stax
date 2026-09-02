import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "./drizzle-db";
import { notifications, userSettings } from "../db/schema";
import { isNull } from "drizzle-orm";

export type NotificationType =
  | "SYSTEM"
  | "STATEMENT_UPLOAD"
  | "STATEMENT_IMPORT"
  | "STATEMENT_DUPLICATE"
  | "ANALYSIS_COMPLETE"
  | "ACCOUNT_STATUS";

/**
 * Idempotent notification creation. Checks user_settings.notificationEnabled
 * before inserting and skips when a notification with the same
 * (userId, type, entityId) already exists, so a retried event never creates a
 * second notification for the same entity.
 *
 * Never throws — notification creation is best-effort only.
 */
export async function createNotification(params: {
  userId: string;
  title: string;
  message: string;
  type?: NotificationType;
  entityId?: string;
}): Promise<void> {
  try {
    const settings = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, params.userId))
      .limit(1);

    if (settings.length > 0 && !settings[0].notificationEnabled) {
      return;
    }

    const existing = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, params.userId),
          eq(notifications.type, params.type ?? "SYSTEM"),
          params.entityId !== undefined
            ? eq(notifications.entityId, params.entityId)
            : isNull(notifications.entityId)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      return;
    }

    const now = new Date().toISOString();
    await db
      .insert(notifications)
      .values({
        id: randomUUID(),
        userId: params.userId,
        title: params.title,
        message: params.message,
        type: params.type ?? "SYSTEM",
        entityId: params.entityId ?? null,
        isRead: false,
        createdAt: now,
      })
      .execute();
  } catch {
    // Notification creation is best-effort — never break the caller.
  }
}

export async function notifyStatementUploaded(
  userId: string,
  fileName: string,
  entityId?: string
): Promise<void> {
  await createNotification({
    userId,
    title: "Statement อัปโหลดสำเร็จ",
    message: `ไฟล์ "${fileName}" ได้รับการอัปโหลดเรียบร้อย`,
    type: "STATEMENT_UPLOAD",
    entityId,
  });
}

export async function notifyStatementImported(
  userId: string,
  fileName: string,
  transactionCount: number,
  entityId?: string
): Promise<void> {
  await createNotification({
    userId,
    title: "นำเข้า Statement สำเร็จ",
    message: `นำเข้า ${transactionCount} รายการจาก "${fileName}" เรียบร้อย`,
    type: "STATEMENT_IMPORT",
    entityId,
  });
}

export async function notifyStatementDuplicate(
  userId: string,
  fileName: string,
  entityId?: string
): Promise<void> {
  await createNotification({
    userId,
    title: "Statement ซ้ำ",
    message: `ไฟล์ "${fileName}" เคยถูกนำเข้าแล้ว ข้ามการนำเข้า`,
    type: "STATEMENT_DUPLICATE",
    entityId,
  });
}

export async function notifyAnalysisComplete(
  userId: string,
  fileName: string,
  entityId?: string
): Promise<void> {
  await createNotification({
    userId,
    title: "วิเคราะห์ Statement สำเร็จ",
    message: `การวิเคราะห์ "${fileName}" ด้วย Gemini เสร็จสมบูรณ์`,
    type: "ANALYSIS_COMPLETE",
    entityId,
  });
}

export async function notifyAccountStatusChanged(
  userId: string,
  newStatus: string
): Promise<void> {
  const isSuspended = newStatus === "SUSPENDED";
  await createNotification({
    userId,
    title: isSuspended ? "บัญชีถูกระงับ" : "บัญชีเปิดใช้งาน",
    message: isSuspended
      ? "บัญชีของคุณถูกระงับโดยผู้ดูแลระบบ กรุณาติดต่อผู้ดูแลระบบ"
      : "บัญชีของคุณถูกเปิดใช้งานแล้ว",
    type: "ACCOUNT_STATUS",
  });
}
