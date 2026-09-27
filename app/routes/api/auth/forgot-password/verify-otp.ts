// POST /api/v1/auth/forgot-password/verify-otp — exchange a code for a
// short-lived reset ticket.
//
// WHY A TICKET INSTEAD OF RESETTING DIRECTLY
// Verifying the code and choosing the new password are two separate acts a user
// does minutes apart, and the browser cannot keep the plaintext code in a place
// the user cannot tamper with. So verification mints a signed, SHORT-LIVED ticket
// (5 minutes) that carries only { userId, otpId, purpose } and nothing sensitive,
// and the reset route re-validates the ticket AND re-checks that the underlying
// OTP row is still unconsumed and unexpired before touching the password.
//
// BINDING THE TICKET TO THE CODE ROW
// The ticket embeds the OTP row id and the reset route consumes that exact row.
// So a ticket cannot be used after the owner requests a fresh code (which
// replaces the row), and a code cannot be replayed after its ticket was spent
// (the row is consumed at reset time).
//
// The code is verified here and NEVER again, and the attempt counter is
// incremented on every failure, so a 6-digit space cannot be ground down:
// OTP_MAX_VERIFY_ATTEMPTS wrong guesses burn the code outright.

import type { Route } from "./+types/verify-otp";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "~/lib/drizzle-db";
import { emailOtps } from "~/db/schema";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";
import { normalizeEmail } from "~/lib/normalize-email";
import {
  RESET_TICKET_TTL_SECONDS,
  hashResetTicket,
  signResetTicket,
} from "~/lib/reset-ticket";
import {
  OTP_VERIFY_IP_RATE_LIMIT,
  clientIpFromRequest,
  evaluateRateLimit,
  incrementRateLimit,
  otpVerifyIpKey,
  purgeStaleRateLimits,
  rateLimitResponse,
} from "~/lib/rate-limit";
import {
  OTP_MAX_VERIFY_ATTEMPTS,
  OtpPurpose,
  findOutstandingOtp,
  isValidOtpFormat,
  otpAttemptOutcome,
  otpPepper,
  recordFailedOtpAttempt,
} from "~/lib/otp";
import { safeErrorLog } from "~/lib/safe-error-log";

/**
 * One message for every rejection.
 *
 * Distinguishing "wrong code" from "expired code" from "no code issued" would
 * tell an attacker how far their guess got and whether the address exists at all.
 * The specific reason goes to the audit log for the operator instead.
 */
const GENERIC_MESSAGE = "The reset code is invalid or has expired.";

export async function loader(_: Route.LoaderArgs) {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

function rejectVerify(): Response {
  return Response.json(
    { success: false, message: GENERIC_MESSAGE, code: "OTP_INVALID" },
    { status: 400 }
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
  if (!jwtSecret || jwtSecret.length < 16) {
    // The same secret backs the reset ticket; refuse before any OTP work rather
    // than after verifying a code we could not hand a ticket back for.
    console.error("Forgot password verify-otp: JWT_SECRET is missing/too short");
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  let pepper: string;
  try {
    pepper = otpPepper();
  } catch (error) {
    console.error(
      "Forgot password verify-otp: pepper unavailable",
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
      { success: false, message: "Email and code are required" },
      { status: 400 }
    );
  }

  const { email, otp } = (body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || email.trim() === "" || otp === undefined) {
    return Response.json(
      { success: false, message: "Email and code are required" },
      { status: 400 }
    );
  }

  const normalizedEmail = normalizeEmail(email);

  const ip = clientIpFromRequest(request);
  const ipRow = await incrementRateLimit(otpVerifyIpKey(ip));
  const ipDecision = evaluateRateLimit(
    OTP_VERIFY_IP_RATE_LIMIT,
    ipRow.windowStartedAt.getTime(),
    ipRow.attempts
  );
  if (ipDecision.limited) {
    return rateLimitResponse(
      ipDecision.retryAfterMs,
      OTP_VERIFY_IP_RATE_LIMIT.maxAttempts,
      Math.max(0, OTP_VERIFY_IP_RATE_LIMIT.maxAttempts - ipRow.attempts)
    );
  }
  void purgeStaleRateLimits();

  // Only a syntactically valid code is even looked up, so the DB is not hit once
  // per guess against a malformed value.
  if (!isValidOtpFormat(otp)) {
    await insertAuditLog({
      userId: null,
      action: AuditAction.OTP_VERIFY_FAILED,
      entityType: "EmailOtp",
      details: {
        route: "/api/v1/auth/forgot-password/verify-otp",
        method: "POST",
        result: "failed",
        reason: "malformed_code",
        purpose: OtpPurpose.PASSWORD_RESET,
        email: normalizedEmail,
      },
    });
    return rejectVerify();
  }

  const row = await findOutstandingOtp(normalizedEmail, OtpPurpose.PASSWORD_RESET);
  if (!row) {
    await insertAuditLog({
      userId: null,
      action: AuditAction.OTP_VERIFY_FAILED,
      entityType: "EmailOtp",
      details: {
        route: "/api/v1/auth/forgot-password/verify-otp",
        method: "POST",
        result: "failed",
        reason: "no_outstanding_code",
        purpose: OtpPurpose.PASSWORD_RESET,
        email: normalizedEmail,
      },
    });
    return rejectVerify();
  }

  // A PASSWORD_RESET code is always issued against an existing account, so
  // userId is non-null by construction. Refuse the orphaned case explicitly
  // rather than minting a ticket for "userId: null" — a ticket must never be able
  // to name a missing user.
  if (row.userId === null || row.userId === "") {
    await insertAuditLog({
      userId: null,
      action: AuditAction.OTP_VERIFY_FAILED,
      entityType: "EmailOtp",
      entityId: row.id,
      details: {
        route: "/api/v1/auth/forgot-password/verify-otp",
        method: "POST",
        result: "failed",
        reason: "code_not_bound_to_user",
        purpose: OtpPurpose.PASSWORD_RESET,
        email: normalizedEmail,
      },
    });
    return rejectVerify();
  }

  const now = new Date();
  const outcome = otpAttemptOutcome(
    row,
    otp,
    now,
    pepper,
    normalizedEmail,
    OtpPurpose.PASSWORD_RESET
  );

  if (outcome !== null) {
    // Count the miss BEFORE responding, and burn the code once the cap is hit.
    // This is the brute-force bound: 5 guesses per issued code, not per session.
    const attempts = await recordFailedOtpAttempt(row.id).catch((error) => {
      console.error(
        "Forgot password verify-otp: failed to record attempt",
        safeErrorLog(error)
      );
      return OTP_MAX_VERIFY_ATTEMPTS;
    });
    await insertAuditLog({
      userId: row.userId,
      action: AuditAction.OTP_VERIFY_FAILED,
      entityType: "EmailOtp",
      entityId: row.id,
      details: {
        route: "/api/v1/auth/forgot-password/verify-otp",
        method: "POST",
        result: "failed",
        reason: outcome,
        purpose: OtpPurpose.PASSWORD_RESET,
        attempts,
        codeBurned: attempts >= OTP_MAX_VERIFY_ATTEMPTS,
        email: normalizedEmail,
      },
    });
    return rejectVerify();
  }

  // Verified. Sign the ticket FIRST, then claim the code with it in one
  // conditional UPDATE, so the claim and the ticket are never out of step:
  //
  //   * the UPDATE requires consumed_at IS NULL, so a second verification of the
  //     same code (or a concurrent one) updates 0 rows and is refused — a
  //     captured code can mint at most one ticket, ever;
  //   * it stores hashResetTicket(ticket) on the row, which is the ticket's
  //     single-use claim consumed by /forgot-password/reset. The signature alone
  //     cannot do this job: it only proves the ticket was minted here, not that
  //     nobody already spent it.
  let ticket: string;
  try {
    ticket = signResetTicket({
      userId: row.userId,
      otpId: row.id,
      purpose: OtpPurpose.PASSWORD_RESET,
    });
  } catch (error) {
    console.error(
      "Forgot password verify-otp: failed to sign ticket",
      safeErrorLog(error)
    );
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  const ticketHash = hashResetTicket(ticket);
  try {
    // The connection is threaded explicitly because drizzle-db.ts uses
    // max: 1 — querying the global `db` inside this transaction would queue
    // forever behind the very connection holding it.
    const claimed = await db.transaction(async (tx) => {
      const updated = await tx
        .update(emailOtps)
        .set({ consumedAt: now, resetTicketHash: ticketHash })
        .where(
          and(
            eq(emailOtps.id, row.id),
            eq(emailOtps.purpose, OtpPurpose.PASSWORD_RESET),
            isNull(emailOtps.consumedAt)
          )
        )
        .returning({ id: emailOtps.id });
      return updated.length;
    });

    if (claimed !== 1) {
      // Lost the race: somebody else verified (or burned) this code while the
      // request was in flight. Report it exactly like a wrong code rather than
      // revealing that the code itself was valid.
      await insertAuditLog({
        userId: row.userId,
        action: AuditAction.OTP_VERIFY_FAILED,
        entityType: "EmailOtp",
        entityId: row.id,
        details: {
          route: "/api/v1/auth/forgot-password/verify-otp",
          method: "POST",
          result: "failed",
          reason: "code_already_consumed",
          purpose: OtpPurpose.PASSWORD_RESET,
          email: normalizedEmail,
        },
      });
      return rejectVerify();
    }
  } catch (error) {
    console.error(
      "Forgot password verify-otp: failed to consume code",
      safeErrorLog(error)
    );
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  return Response.json(
    {
      success: true,
      message: "Code verified. Please choose a new password.",
      data: {
        resetTicket: ticket,
        expiresInSeconds: RESET_TICKET_TTL_SECONDS,
      },
    },
    { status: 200 }
  );
}
