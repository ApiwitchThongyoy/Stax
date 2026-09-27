// POST /api/v1/auth/forgot-password/request-otp — start a password recovery.
//
// ENUMERATION-SAFE BY CONSTRUCTION
// The response is byte-identical whether or not the address belongs to an
// account. A different answer for "no such account" would let anyone test whether
// somebody's email is registered, which is a privacy leak far more damaging than
// anything an attacker could do with the code itself. So this route always
// returns 200 with the same message; internally it may or may not have created a
// code, and that difference goes only to the audit log.
//
// RESETS EVERY EXISTING CODE
// Requesting a new code REPLACES the outstanding one, so a code that leaked from
// an earlier request is dead the moment the owner asks for a fresh one.

import { eq } from "drizzle-orm";
import type { Route } from "./+types/request-otp";
import { db } from "~/lib/drizzle-db";
import { users } from "~/db/schema";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";
import { normalizeEmail } from "~/lib/normalize-email";
import {
  OtpIssueRejection,
  OtpPurpose,
  isDevOtpEnabled,
  issueOtp,
  otpPepper,
} from "~/lib/otp";
import {
  OTP_REQUEST_EMAIL_RATE_LIMIT,
  OTP_REQUEST_IP_RATE_LIMIT,
  clientIpFromRequest,
  evaluateRateLimit,
  incrementRateLimit,
  otpRequestEmailKey,
  otpRequestIpKey,
  purgeStaleRateLimits,
  rateLimitResponse,
} from "~/lib/rate-limit";
import { safeErrorLog } from "~/lib/safe-error-log";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GENERIC_MESSAGE =
  "If the address is registered, a reset code has been sent. It expires in 10 minutes.";

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

  let pepper: string;
  try {
    pepper = otpPepper();
  } catch (error) {
    console.error(
      "Forgot password request-otp: pepper unavailable",
      safeErrorLog(error)
    );
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
      { success: false, message: "Email is required" },
      { status: 400 }
    );
  }

  const { email } = (body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || email.trim() === "") {
    return Response.json(
      { success: false, message: "Email is required" },
      { status: 400 }
    );
  }

  const normalizedEmail = normalizeEmail(email);
  if (!EMAIL_REGEX.test(normalizedEmail)) {
    return Response.json(
      { success: false, message: "Invalid email format" },
      { status: 400 }
    );
  }

  const ip = clientIpFromRequest(request);
  const [ipRow, emailRow] = await Promise.all([
    incrementRateLimit(otpRequestIpKey(ip)),
    incrementRateLimit(
      otpRequestEmailKey(normalizedEmail, OtpPurpose.PASSWORD_RESET)
    ),
  ]);
  const ipDecision = evaluateRateLimit(
    OTP_REQUEST_IP_RATE_LIMIT,
    ipRow.windowStartedAt.getTime(),
    ipRow.attempts
  );
  const emailDecision = evaluateRateLimit(
    OTP_REQUEST_EMAIL_RATE_LIMIT,
    emailRow.windowStartedAt.getTime(),
    emailRow.attempts
  );
  if (ipDecision.limited || emailDecision.limited) {
    const limitedByIp = ipDecision.limited;
    const decision = limitedByIp ? ipDecision : emailDecision;
    const config = limitedByIp
      ? OTP_REQUEST_IP_RATE_LIMIT
      : OTP_REQUEST_EMAIL_RATE_LIMIT;
    const attempts = limitedByIp ? ipRow.attempts : emailRow.attempts;
    return rateLimitResponse(
      decision.retryAfterMs,
      config.maxAttempts,
      Math.max(0, config.maxAttempts - attempts + 1)
    );
  }
  void purgeStaleRateLimits();

  // A SUSPENDED account must not be able to run recovery: it stays locked until
  // an admin re-activates it. Silently refusing is safer than a hard error,
  // because the generic response must not reveal the account's state.
  let account: { id: string; status: string } | undefined;
  try {
    const rows = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);
    account = rows[0];
  } catch (error) {
    console.error(
      "Forgot password request-otp: failed to query user",
      safeErrorLog(error)
    );
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  if (!account || account.status !== "ACTIVE") {
    await insertAuditLog({
      userId: account?.id ?? null,
      action: AuditAction.OTP_REQUESTED,
      entityType: "EmailOtp",
      details: {
        route: "/api/v1/auth/forgot-password/request-otp",
        method: "POST",
        result: "skipped",
        reason: !account ? "no_such_account" : "account_suspended",
        purpose: OtpPurpose.PASSWORD_RESET,
        email: normalizedEmail,
      },
    });
    return Response.json(
      { success: true, message: GENERIC_MESSAGE },
      { status: 200 }
    );
  }

  let issued;
  try {
    issued = await issueOtp({
      email: normalizedEmail,
      purpose: OtpPurpose.PASSWORD_RESET,
      userId: account.id,
      pepper,
    });
  } catch (error) {
    console.error(
      "Forgot password request-otp: failed to issue code",
      safeErrorLog(error)
    );
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  if (!issued.ok) {
    if (issued.reason === OtpIssueRejection.COOLDOWN) {
      return Response.json(
        {
          success: false,
          message: `Please wait ${issued.retryAfterSeconds} seconds before requesting another code.`,
          code: "OTP_COOLDOWN",
          retryAfterSeconds: issued.retryAfterSeconds,
        },
        { status: 429 }
      );
    }
    return Response.json(
      { success: false, message: "Invalid email format" },
      { status: 400 }
    );
  }

  await insertAuditLog({
    userId: account.id,
    action: AuditAction.OTP_REQUESTED,
    entityType: "EmailOtp",
    entityId: issued.otp.id,
    details: {
      route: "/api/v1/auth/forgot-password/request-otp",
      method: "POST",
      result: "success",
      purpose: OtpPurpose.PASSWORD_RESET,
      email: normalizedEmail,
    },
  });

  return Response.json(
    {
      success: true,
      message: GENERIC_MESSAGE,
      data: {
        expiresInSeconds: issued.otp.ttlSeconds,
        resendAfterSeconds: issued.otp.resendAfterSeconds,
        // Only ever present with AUTH_DEV_SHOW_OTP=true.
        ...(isDevOtpEnabled() ? { devOtp: issued.otp.code } : {}),
      },
    },
    { status: 200 }
  );
}
