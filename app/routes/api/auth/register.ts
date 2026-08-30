import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/register";
import { db } from "~/lib/drizzle-db";
import { users } from "~/db/schema";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";

// Same email format used by login.ts.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 10;
// Minimal guard consistent with the project's test credential convention
// (e.g. "W2UserB!234"). No stricter project requirement is currently defined.
const PASSWORD_MIN_LENGTH = 8;

export async function loader(_: Route.LoaderArgs) {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, message: "Email and password are required" },
      { status: 400 }
    );
  }

  const { email, password } = (body ?? {}) as Record<string, unknown>;

  if (typeof email !== "string" || typeof password !== "string") {
    return Response.json(
      { success: false, message: "Email and password are required" },
      { status: 400 }
    );
  }

  const normalizedEmail = email.trim().toLowerCase();

  if (!normalizedEmail) {
    return Response.json(
      { success: false, message: "Email is required" },
      { status: 400 }
    );
  }

  if (!EMAIL_REGEX.test(normalizedEmail)) {
    return Response.json(
      { success: false, message: "Invalid email format" },
      { status: 400 }
    );
  }

  if (!password) {
    return Response.json(
      { success: false, message: "Password is required" },
      { status: 400 }
    );
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    return Response.json(
      {
        success: false,
        message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
      },
      { status: 400 }
    );
  }

  // Never accept role/status from the client. Hard-coded to safe defaults.
  const role = "USER";
  const status = "ACTIVE";

  let existing;
  try {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);
    existing = rows[0];
  } catch (error) {
    console.error("Register: failed to query user", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  if (existing) {
    await insertAuditLog({
      userId: null,
      action: AuditAction.REGISTER_FAILED,
      entityType: "User",
      details: {
        route: "/api/v1/auth/register",
        method: "POST",
        result: "failed",
        reason: "email_already_exists",
        email: normalizedEmail,
      },
    });
    return Response.json(
      {
        success: false,
        message: "Email already exists",
        code: "EMAIL_ALREADY_EXISTS",
      },
      { status: 409 }
    );
  }

  let passwordHash: string;
  try {
    passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  } catch (error) {
    console.error("Register: failed to hash password", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  const id = randomUUID();

  try {
    await db
      .insert(users)
      .values({
        id,
        email: normalizedEmail,
        passwordHash,
        role,
        status,
      })
      .execute();
  } catch (error) {
    console.error("Register: failed to insert user", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  await insertAuditLog({
    userId: id,
    action: AuditAction.REGISTER_SUCCESS,
    entityType: "User",
    entityId: id,
    details: {
      route: "/api/v1/auth/register",
      method: "POST",
      result: "success",
      role,
    },
  });

  return Response.json(
    {
      success: true,
      message: "Registration successful",
      data: {
        user: {
          id,
          email: normalizedEmail,
          role,
          status,
        },
      },
    },
    { status: 201 }
  );
}
