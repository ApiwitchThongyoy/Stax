import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Route } from "./+types/settings";
import { db } from "~/lib/drizzle-db";
import { userSettings } from "~/db/schema";
import {
  verifyAuth,
  type AuthPayload,
  authErrorResponse,
} from "~/lib/auth-middleware";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";

const DEFAULT_SETTINGS = {
  notificationEnabled: true,
  emailNotificationEnabled: true,
};

const SUPPORTED_FIELDS = [
  "notificationEnabled",
  "emailNotificationEnabled",
] as const;

function isAuthError(
  result: unknown
): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

function toResponse(row: {
  id: string;
  userId: string;
  notificationEnabled: boolean;
  emailNotificationEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: row.id,
    userId: row.userId,
    notificationEnabled: row.notificationEnabled,
    emailNotificationEnabled: row.emailNotificationEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function getSettingsRow(userId: string): Promise<{
  id: string;
  userId: string;
  notificationEnabled: boolean;
  emailNotificationEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}> {
  const existing = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  const now = new Date().toISOString();
  const created = {
    id: randomUUID(),
    userId,
    notificationEnabled: DEFAULT_SETTINGS.notificationEnabled,
    emailNotificationEnabled: DEFAULT_SETTINGS.emailNotificationEnabled,
    createdAt: now,
    updatedAt: now,
  };

  await db
    .insert(userSettings)
    .values(created)
    .onConflictDoNothing({ target: userSettings.userId })
    .execute();

  const rows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  return rows[0];
}

export async function loader({ request }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  try {
    const row = await getSettingsRow(auth.userId);
    return Response.json({ success: true, data: toResponse(row) }, { status: 200 });
  } catch (error) {
    console.error("Settings GET: failed to query", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  if (request.method !== "PATCH") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405 }
    );
  }

  return handlePatch(request, auth);
}

async function handlePatch(
  request: Request,
  auth: AuthPayload
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, message: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const payload = (body ?? {}) as Record<string, unknown>;

  const keys = Object.keys(payload);
  if (keys.length === 0) {
    return Response.json(
      { success: false, message: "No settings fields provided" },
      { status: 400 }
    );
  }

  const invalidKey = keys.find(
    (k) => !(SUPPORTED_FIELDS as readonly string[]).includes(k)
  );
  if (invalidKey) {
    return Response.json(
      {
        success: false,
        message: `Unsupported setting field: ${invalidKey}`,
      },
      { status: 400 }
    );
  }

  const updates: Record<string, boolean> = {};
  for (const key of keys) {
    const value = payload[key];
    if (typeof value !== "boolean") {
      return Response.json(
        { success: false, message: `${key} must be a boolean` },
        { status: 400 }
      );
    }
    updates[key] = value;
  }

  try {
    const row = await getSettingsRow(auth.userId);
    const now = new Date().toISOString();

    await db
      .update(userSettings)
      .set({ ...updates, updatedAt: now })
      .where(eq(userSettings.id, row.id))
      .execute();

    await insertAuditLog({
      userId: auth.userId,
      action: AuditAction.SETTINGS_UPDATE,
      entityType: "user_settings",
      entityId: row.id,
      details: {
        route: "/api/v1/settings",
        method: "PATCH",
        result: "success",
        fields: keys,
      },
    });

    const updatedRows = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.id, row.id))
      .limit(1);

    return Response.json(
      { success: true, data: toResponse(updatedRows[0]) },
      { status: 200 }
    );
  } catch (error) {
    console.error("Settings PATCH: failed to update", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
