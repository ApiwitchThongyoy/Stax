import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import type { Route } from "./+types/register";
import { db } from "~/lib/drizzle-db";
import { emailOtps, users } from "~/db/schema";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";
import { seedDefaultChartOfAccounts } from "~/lib/ledger-service";
import { normalizeEmail } from "~/lib/normalize-email";
import { BCRYPT_ROUNDS, checkPasswordPolicy } from "~/lib/password-policy";
import {
  OTP_MAX_VERIFY_ATTEMPTS,
  OtpPurpose,
  findOutstandingOtp,
  isValidOtpFormat,
  otpAttemptOutcome,
  otpPepper,
  recordFailedOtpAttempt,
} from "~/lib/otp";
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

  const { email, password, otp } = (body ?? {}) as Record<string, unknown>;

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

  // Registration is a TWO-STEP flow: a code must have been issued for this
  // address (via /auth/register/request-otp) before the account may be created.
  // Reject a missing/malformed code EARLY and cheaply, before any bcrypt work.
  if (otp === undefined || otp === null) {
    return Response.json(
      {
        success: false,
        message: "A verification code is required. Please request one first.",
        code: "OTP_REQUIRED",
      },
      { status: 400 }
    );
  }
  if (!isValidOtpFormat(otp)) {
    return Response.json(
      {
        success: false,
        message: "The verification code is invalid or has expired.",
        code: "OTP_INVALID",
      },
      { status: 400 }
    );
  }

  const passwordPolicy = checkPasswordPolicy(password);
  if (!passwordPolicy.ok) {
    return Response.json(
      { success: false, message: passwordPolicy.message },
      { status: 400 }
    );
  }

  // Never accept role/status from the client. Hard-coded to safe defaults.
  const role = "USER";
  const status = "ACTIVE";

  // Rate-limit policy (PostgreSQL-backed, fail-open). A registration attempt
  // is counted once the payload is well-formed — i.e. NOT for malformed/invalid
  // payloads (cheap 400s), but YES for every valid-looking attempt including
  // duplicates. The budget key is per-IP ONLY (the email is deliberately NOT
  // part of it: an ip+email key lets one attacker rotate emails from a single
  // IP and get a fresh bucket per email, bypassing the cap). The pre-check /
  // INSERT duplicate path and the concurrent-race 23505 path all land on the
  // same per-IP budget, so a scripted mass-register run trips the 429 FIRST.
  const registerIp = clientIpFromRequest(request);
  const registerKey = registerIpKey(registerIp);
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

  // ---- Verify the emailed code -------------------------------------------------
  //
  // This is the step that makes an account provably tied to a mailbox. It runs
  // AFTER the duplicate-email check (so the existing 409 contract is untouched)
  // and BEFORE the user row is created, so a wrong code can never leave a
  // half-registered account behind.
  //
  // The pepper is fetched before any comparison; a deployment without a usable
  // JWT_SECRET fails loudly with a 500 rather than silently verifying against an
  // unpeppered hash.
  let pepper: string;
  try {
    pepper = otpPepper();
  } catch (error) {
    console.error("Register: OTP pepper unavailable", safeErrorLog(error));
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  const otpRow = await findOutstandingOtp(normalizedEmail, OtpPurpose.REGISTER);
  if (!otpRow) {
    await insertAuditLog({
      userId: null,
      action: AuditAction.OTP_VERIFY_FAILED,
      entityType: "EmailOtp",
      details: {
        route: "/api/v1/auth/register",
        method: "POST",
        result: "failed",
        reason: "no_outstanding_code",
        purpose: OtpPurpose.REGISTER,
        email: normalizedEmail,
      },
    });
    return Response.json(
      {
        success: false,
        message: "The verification code is invalid or has expired.",
        code: "OTP_INVALID",
      },
      { status: 400 }
    );
  }

  const otpNow = new Date();
  const otpOutcome = otpAttemptOutcome(
    otpRow,
    otp,
    otpNow,
    pepper,
    normalizedEmail,
    OtpPurpose.REGISTER
  );

  if (otpOutcome !== null) {
    // Count the miss before answering, and burn the code at the cap. This is the
    // bound that makes a 1,000,000-value space safe: 5 guesses per issued code.
    const attempts = await recordFailedOtpAttempt(otpRow.id).catch((error) => {
      console.error("Register: failed to record OTP attempt", safeErrorLog(error));
      return OTP_MAX_VERIFY_ATTEMPTS;
    });
    await insertAuditLog({
      userId: null,
      action: AuditAction.OTP_VERIFY_FAILED,
      entityType: "EmailOtp",
      entityId: otpRow.id,
      details: {
        route: "/api/v1/auth/register",
        method: "POST",
        result: "failed",
        reason: otpOutcome,
        purpose: OtpPurpose.REGISTER,
        attempts,
        codeBurned: attempts >= OTP_MAX_VERIFY_ATTEMPTS,
        email: normalizedEmail,
      },
    });
    return Response.json(
      {
        success: false,
        message: "The verification code is invalid or has expired.",
        code: "OTP_INVALID",
      },
      { status: 400 }
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
    // The user row and the code's consumption commit TOGETHER. Two reasons:
    //   * A consumed code with no account would burn the user's signup attempt and
    //     force them to request another one.
    //   * An account created while the code stays valid would let the same code
    //     be replayed for a second registration.
    // The code row is re-checked under FOR UPDATE so a second concurrent
    // registration with the same code cannot slip a row in between our earlier
    // hash comparison and this insert.
    await db.transaction(async (tx) => {
      const codeRows = await tx
        .select({ id: emailOtps.id, consumedAt: emailOtps.consumedAt })
        .from(emailOtps)
        .where(
          and(
            eq(emailOtps.id, otpRow.id),
            eq(emailOtps.purpose, OtpPurpose.REGISTER),
            isNull(emailOtps.consumedAt)
          )
        )
        .limit(1)
        .for("update");

      if (codeRows.length === 0) {
        // Another request consumed it first. Throwing rolls back so this request
        // creates no account either.
        throw new Error("verification code already consumed");
      }

      await tx
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

      // userId is stamped on consumption so the audit trail can tie the code to the
      // account it created (it is NULL while a registration is still pending).
      await tx
        .update(emailOtps)
        .set({ consumedAt: now, userId: id })
        .where(eq(emailOtps.id, otpRow.id))
        .execute();
    });
  } catch (error) {
    // The code was consumed by a concurrent registration while this one was
    // hashing the password. The transaction rolled back, so no account was
    // created by this request — report it as a spent code, not a server fault.
    if (error instanceof Error && error.message === "verification code already consumed") {
      await insertAuditLog({
        userId: null,
        action: AuditAction.OTP_VERIFY_FAILED,
        entityType: "EmailOtp",
        entityId: otpRow.id,
        details: {
          route: "/api/v1/auth/register",
          method: "POST",
          result: "failed",
          reason: "code_already_consumed",
          purpose: OtpPurpose.REGISTER,
          email: normalizedEmail,
        },
      });
      return Response.json(
        {
          success: false,
          message: "The verification code is invalid or has expired.",
          code: "OTP_INVALID",
        },
        { status: 400 }
      );
    }

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
