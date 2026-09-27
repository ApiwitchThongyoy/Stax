// POST /api/v1/auth/register/request-otp — issue a registration code.
//
// REGISTRATION IS A TWO-STEP FLOW
// A code must be requested for an address BEFORE /auth/register will accept that
// address. The register route re-verifies the code server-side, so this endpoint
// only ever CREATES a pending code; it grants nothing on its own. That ordering is
// what makes "email ownership" a real check rather than a UI ornament — and it is
// also why an attacker cannot pre-verify a code for somebody else's address
// without having delivered a message to that address.
//
// ENUMERATION
// This endpoint answers 200 for ANY well-formed address, whether or not an
// account exists, and the response body is identical either way. That is
// deliberate: a differing answer for "already registered" would turn this into a
// free account-enumeration oracle, which is worth more to an attacker than any
// single guess against a 10-minute 6-digit code.
//
// THE ONE EXCEPTION — devOtp
// When AUTH_DEV_SHOW_OTP=true the response carries the generated code so a
// developer can complete the flow without a mail server. That is an explicit
// opt-in (see isDevOtpEnabled) and is deliberately NOT implemented by checking
// NODE_ENV: a staging box must not leak codes, and the flag lives server-side so
// the browser cannot influence it. With the flag off, no code is ever returned.

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

/** One body for every outcome, so the response cannot be used as an oracle. */
const GENERIC_MESSAGE =
  "If the address is valid, a verification code has been sent. It expires in 10 minutes.";

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
    // A missing/short JWT_SECRET must fail loudly, not silently issue an
    // unpeppered (brute-forceable) code.
    console.error("Register request-otp: pepper unavailable", safeErrorLog(error));
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

  // Two independent budgets: per-IP stops a spray across many addresses, and
  // per-email stops one address being used to burn a mail/OTP budget. Both are
  // evaluated BEFORE any DB work on the OTP table.
  const ip = clientIpFromRequest(request);
  const [ipRow, emailRow] = await Promise.all([
    incrementRateLimit(otpRequestIpKey(ip)),
    incrementRateLimit(
      otpRequestEmailKey(normalizedEmail, OtpPurpose.REGISTER)
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

  // Existing-account check is only used to decide whether a code is worth
  // issuing. It deliberately does NOT change the response, so it leaks nothing.
  let accountExists = false;
  try {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);
    accountExists = rows.length > 0;
  } catch (error) {
    console.error(
      "Register request-otp: failed to check existing account",
      safeErrorLog(error)
    );
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  if (accountExists) {
    // Nothing is issued: there is nothing left to verify. The caller still gets
    // the generic success so it cannot be used to probe for registered
    // addresses, and registration itself will report EMAIL_ALREADY_EXISTS.
    await insertAuditLog({
      userId: null,
      action: AuditAction.OTP_REQUESTED,
      entityType: "EmailOtp",
      details: {
        route: "/api/v1/auth/register/request-otp",
        method: "POST",
        result: "skipped",
        reason: "account_already_exists",
        purpose: OtpPurpose.REGISTER,
        email: normalizedEmail,
      },
    });
    return Response.json(
      { success: true, message: GENERIC_MESSAGE, data: { devOtp: undefined } },
      { status: 200 }
    );
  }

  let issued;
  try {
    issued = await issueOtp({
      email: normalizedEmail,
      purpose: OtpPurpose.REGISTER,
      userId: null,
      pepper,
    });
  } catch (error) {
    console.error("Register request-otp: failed to issue code", safeErrorLog(error));
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

  // NOTE: the code itself is deliberately absent from this audit row.
  await insertAuditLog({
    userId: null,
    action: AuditAction.OTP_REQUESTED,
    entityType: "EmailOtp",
    entityId: issued.otp.id,
    details: {
      route: "/api/v1/auth/register/request-otp",
      method: "POST",
      result: "success",
      purpose: OtpPurpose.REGISTER,
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
