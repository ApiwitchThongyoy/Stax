import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/register";
import { db } from "~/lib/drizzle-db";
import { users } from "~/db/schema";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";
import { seedDefaultChartOfAccounts } from "~/lib/ledger-service";
import { normalizeEmail } from "~/lib/normalize-email";
import {
  REGISTER_IP_RATE_LIMIT,
  clientIpFromRequest,
  evaluateRateLimit,
  incrementRateLimit,
  registerIpKey,
  purgeStaleRateLimits,
  rateLimitResponse,
} from "~/lib/rate-limit";
import { safeErrorLog } from "~/lib/safe-error-log";

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

  const normalizedEmail = normalizeEmail(email);

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

  // Rate-limit policy (PostgreSQL-backed, fail-open). A registration attempt
  // is counted once the payload is well-formed — i.e. NOT for malformed/invalid
  // payloads (cheap 400s), but YES for every valid-looking attempt including
  // duplicates. The pre-check/INSERT duplicate path and the concurrent-race
  // 23505 path all land on the same per-IP-per-email budget, so a scripted
  // mass-register run trips the 429 FIRST (before hitting the unique race
  // repeatedly). The email is embedded in the key so a legit shared-IP user
  // creating a handful of accounts is unaffected by another user's spam.
  const registerIp = clientIpFromRequest(request);
  const registerKey = registerIpKey(registerIp, normalizedEmail);
  const registerRow = await incrementRateLimit(registerKey);
  const registerDecision = evaluateRateLimit(
    REGISTER_IP_RATE_LIMIT,
    registerRow.windowStartedAt.getTime(),
    registerRow.attempts
  );
  if (registerDecision.limited) {
    return rateLimitResponse(
      registerDecision.retryAfterMs,
      REGISTER_IP_RATE_LIMIT.maxAttempts,
      Math.max(0, REGISTER_IP_RATE_LIMIT.maxAttempts - registerRow.attempts)
    );
  }
  void purgeStaleRateLimits();

  let existing;
  try {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);
    existing = rows[0];
  } catch (error) {
    console.error("Register: failed to query user", safeErrorLog(error));
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
    console.error("Register: failed to hash password", safeErrorLog(error));
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  const id = randomUUID();
  const now = new Date();

  try {
    await db
      .insert(users)
      .values({
        id,
        email: normalizedEmail,
        passwordHash,
        role,
        status,
        createdAt: now,
      })
      .execute();
  } catch (error) {
    // Concurrent registration race: the pre-check above can pass for two
    // requests at once, and the DB's unique constraint (User_email_unique) is
    // the single source of truth. Turn that race into the SAME 409 the
    // pre-check returns (it already had its register attempt counted against
    // the rate budget, so it is throttled just like a normal duplicate).
    // concurrent-race 23505 usually surfaces UNWRAPPED (a postgres library
    // PostgresError with `.code`) but the drizzle postgres-js driver wraps the
    // driver error in a DrizzleQueryError that carries the original on `.cause`.
    // Check both so the race always resolves to 409, never 500.
    const uniqueViolation =
      typeof error === "object" &&
      error !== null &&
      ((error as { code?: unknown }).code === "23505" ||
        (error as { cause?: { code?: unknown } }).cause?.code === "23505");
    if (uniqueViolation) {
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
    console.error("Register: failed to insert user", safeErrorLog(error));
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  // Seed the default chart of accounts for the new user. Best-effort and
  // non-blocking: a CoA seeding failure must never turn a successful
  // registration into a 500, and the idempotent seeder re-runs safely later.
  try {
    await seedDefaultChartOfAccounts(id);
  } catch (error) {
    console.error("Register: failed to seed chart of accounts", safeErrorLog(error));
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
