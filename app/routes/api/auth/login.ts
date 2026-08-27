import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/login";
import { db } from "../../../lib/drizzle-db";
import { users } from "~/db/schema";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCESS_TOKEN_EXPIRY = "1h";

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

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.error("Login: JWT_SECRET is not set");
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
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

  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    email.trim() === "" ||
    password === ""
  ) {
    return Response.json(
      { success: false, message: "Email and password are required" },
      { status: 400 }
    );
  }

  const normalizedEmail = email.trim();

  if (!EMAIL_REGEX.test(normalizedEmail)) {
    return Response.json(
      { success: false, message: "Invalid email format" },
      { status: 400 }
    );
  }

  let user;
  try {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);
    user = rows[0];
  } catch (error) {
    console.error("Login: failed to query user", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  if (!user) {
    await insertAuditLog({
      userId: null,
      action: AuditAction.LOGIN_FAILED,
      entityType: "User",
      details: {
        route: "/api/v1/auth/login",
        method: "POST",
        result: "failed",
        reason: "user_not_found",
        email: normalizedEmail,
      },
    });
    return Response.json(
      { success: false, message: "Invalid email or password" },
      { status: 401 }
    );
  }

  let passwordMatches = false;
  try {
    passwordMatches = await bcrypt.compare(password, user.passwordHash);
  } catch (error) {
    console.error("Login: failed to compare password", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  if (!passwordMatches) {
    await insertAuditLog({
      userId: user.id,
      action: AuditAction.LOGIN_FAILED,
      entityType: "User",
      entityId: user.id,
      details: {
        route: "/api/v1/auth/login",
        method: "POST",
        result: "failed",
        reason: "invalid_password",
      },
    });
    return Response.json(
      { success: false, message: "Invalid email or password" },
      { status: 401 }
    );
  }

  let accessToken: string;
  try {
    accessToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      jwtSecret,
      { expiresIn: ACCESS_TOKEN_EXPIRY }
    );
  } catch (error) {
    console.error("Login: failed to sign access token", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  await insertAuditLog({
    userId: user.id,
    action:
      user.role === "ADMIN"
        ? AuditAction.ADMIN_LOGIN_SUCCESS
        : AuditAction.LOGIN_SUCCESS,
    entityType: "User",
    entityId: user.id,
    details: {
      route: "/api/v1/auth/login",
      method: "POST",
      result: "success",
      role: user.role,
    },
  });

  return Response.json(
    {
      success: true,
      message: "Login successful",
      data: {
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
        },
      },
    },
    { status: 200 }
  );
}
