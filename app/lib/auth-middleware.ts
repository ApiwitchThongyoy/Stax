import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "./drizzle-db";
import { users } from "../db/schema";

export interface AuthPayload {
  userId: string;
  email: string;
  role: string;
}

export interface AuthError {
  status: number;
  message: string;
}

/**
 * Verify the caller's JWT and resolve the authoritative user record from the
 * database. The userId/role reported back come from the stored user, never from
 * the client-supplied token body, and the account's current status is enforced
 * (only ACTIVE accounts may proceed).
 */
export async function verifyAuth(
  request: Request
): Promise<AuthPayload | AuthError> {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return { status: 500, message: "Internal server error" };
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { status: 401, message: "Missing or invalid authorization header" };
  }

  const token = authHeader.slice(7);
  if (!token) {
    return { status: 401, message: "Missing token" };
  }

  let decoded: { userId?: string; email?: string; role?: string };
  try {
    decoded = jwt.verify(token, jwtSecret) as {
      userId?: string;
      email?: string;
      role?: string;
    };
  } catch {
    return { status: 401, message: "Invalid or expired token" };
  }

  if (!decoded.userId || !decoded.email || !decoded.role) {
    return { status: 401, message: "Invalid token payload" };
  }

  let rows;
  try {
    rows = await db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, decoded.userId))
      .limit(1);
  } catch (error) {
    console.error("verifyAuth: failed to query user", error);
    return { status: 500, message: "Internal server error" };
  }

  const user = rows[0];
  if (!user || user.email !== decoded.email) {
    return { status: 401, message: "Invalid or expired token" };
  }

  if (user.status !== "ACTIVE") {
    return { status: 403, message: "Account is disabled" };
  }

  return { userId: user.id, email: user.email, role: user.role };
}
