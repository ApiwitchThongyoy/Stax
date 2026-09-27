// POST /api/v1/auth/forgot-password/reset — set a new password using a ticket.
//
// THE ONE PLACE A PASSWORD CHANGES. Everything here is written to be boring and
// all-or-nothing:
//
//   1. verifyResetTicket     — signature + audience + purpose + 5-min expiry.
//   2. SELECT ... FOR UPDATE  — serialise against a second concurrent reset.
//   3. re-check the code row — still unconsumed, not expired, not burned. The
//      ticket alone is NOT sufficient authority.
//   4. re-check the account  — still exists, still ACTIVE.
//   5. set the new hash.
//   6. consume the code row.
//   7. revoke EVERY refresh session for the user (this is the important part).
//   8. audit.
//
// WHY EVERY SESSION DIES ON RESET
// A password reset is the remedy for "somebody else has my account". If it left
// existing sessions alive, the attacker simply rides the session they already
// hold and the reset achieves nothing. So step 7 revokes all refresh sessions —
// every device, every browser, every tab must sign in again with the new
// password. The already-issued access tokens keep working until their 15-minute
// expiry, which is the accepted, bounded window; they are not revocable in this
// architecture.
//
// PASSWORD RULES (unchanged from registration, deliberately)
// 8+ characters, and at least one lowercase, one uppercase and one digit. The
// new password is NOT compared against the old one: allowing reuse is fine here
// because the reset is already gated on proven email ownership.
//
// REPLAY
// Step 6 consumes the code, and step 3 refuses a consumed row, so a captured
// ticket is strictly single-use even if two resets race. The FOR UPDATE lock in
// step 2 is what makes that guarantee real rather than hopeful.

import { and, eq, isNotNull } from "drizzle-orm";
import bcrypt from "bcryptjs";
import type { Route } from "./+types/reset";
import { db } from "~/lib/drizzle-db";
import { emailOtps, users } from "~/db/schema";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";
import {
  RESET_TICKET_PURPOSE,
  hashResetTicket,
  resetTicketHashMatches,
  verifyResetTicket,
} from "~/lib/reset-ticket";
import { OTP_MAX_VERIFY_ATTEMPTS, OtpPurpose } from "~/lib/otp";
import {
  BCRYPT_ROUNDS,
  checkPasswordPolicy,
} from "~/lib/password-policy";
import {
  RevokeReason,
  buildClearRefreshCookieHeader,
  refreshCookieIsSecure,
  revokeAllUserSessions,
} from "~/lib/refresh-session";
import { safeErrorLog } from "~/lib/safe-error-log";

export async function loader(_: Route.LoaderArgs) {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
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
      { success: false, message: "Reset ticket and password are required" },
      { status: 400 }
    );
  }

  const { resetTicket, newPassword } = (body ?? {}) as Record<string, unknown>;
  if (typeof resetTicket !== "string" || resetTicket.length === 0) {
    return Response.json(
      { success: false, message: "Reset ticket and password are required" },
      { status: 400 }
    );
  }

  // Shape-check the password BEFORE verifying the ticket so a malformed password
  // never looks like a valid-ticket-but-rejected combination. The rule is the
  // shared one, identical to registration, so a user who could sign up with a
  // given password can also reset back to that style.
  const policy = checkPasswordPolicy(newPassword);
  if (!policy.ok) {
    return Response.json(
      { success: false, message: policy.message },
      { status: 400 }
    );
  }
  // checkPasswordPolicy is the single source of the rule, but it cannot narrow the
  // type for the compiler — assert the shape it just validated.
  const newPasswordString: string = newPassword as string;

  // Single rejection for every ticket problem: expired, forged, wrong audience.
  const claims = verifyResetTicket(resetTicket);
  if (!claims) {
    return Response.json(
      {
        success: false,
        message: "Your reset link is invalid or has expired. Please request a new code.",
        code: "RESET_TICKET_INVALID",
      },
      { status: 400 }
    );
  }
  if (claims.purpose !== RESET_TICKET_PURPOSE) {
    return Response.json(
      {
        success: false,
        message: "Your reset link is invalid or has expired. Please request a new code.",
        code: "RESET_TICKET_INVALID",
      },
      { status: 400 }
    );
  }

  const now = new Date();
  const passwordHash = await bcrypt.hash(newPasswordString, BCRYPT_ROUNDS);
  // Computed once, outside the transaction: the digest is a pure function of the
  // presented ticket, so there is nothing to gain by recomputing it per statement.
  const ticketHash = hashResetTicket(resetTicket);

  let revokedSessionCount = 0;
  try {
    // One transaction for the whole authoritative sequence. A password change
    // that commits without the matching ticket-claim would be replayable, and a
    // ticket spent without the password change would lock the user out — so both
    // must succeed or neither does.
    const result = await db.transaction(async (tx) => {
      // FOR UPDATE: a second reset carrying the same ticket blocks here until this
      // one commits, then finds the ticket already spent and is refused.
      //
      // The row is addressed by its OWN id (carried in the ticket) and must belong
      // to the same user. There is deliberately no email predicate: the ticket
      // never carried one, so binding on the id + userId pair is both sufficient
      // and strictly narrower than re-deriving an email we would have to trust.
      //
      // consumed_at IS NOT NULL is expected here, not contradictory: verification
      // already spent the code. What still has to hold is reset_ticket_hash — the
      // ticket's own single-use claim.
      const codeRows = await tx
        .select({
          id: emailOtps.id,
          userId: emailOtps.userId,
          expiresAt: emailOtps.expiresAt,
          consumedAt: emailOtps.consumedAt,
          resetTicketHash: emailOtps.resetTicketHash,
          attempts: emailOtps.attempts,
        })
        .from(emailOtps)
        .where(
          and(
            eq(emailOtps.id, claims.otpId),
            eq(emailOtps.purpose, OtpPurpose.PASSWORD_RESET),
            isNotNull(emailOtps.consumedAt)
          )
        )
        .limit(1)
        .for("update");

      const codeRow = codeRows[0];
      if (!codeRow) return { kind: "code_gone" } as const;
      // The ticket named a user; the code row must belong to that same user.
      if (codeRow.userId === null || codeRow.userId !== claims.userId) {
        return { kind: "code_gone" } as const;
      }
      if (codeRow.expiresAt.getTime() <= now.getTime()) {
        return { kind: "code_expired" } as const;
      }
      if (codeRow.attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
        return { kind: "code_gone" } as const;
      }
      // The signature already passed; this is the claim check. A ticket whose
      // hash is absent was either never minted by verification or was already
      // spent, and the two are deliberately indistinguishable.
      if (
        codeRow.resetTicketHash === null ||
        !resetTicketHashMatches(resetTicket, codeRow.resetTicketHash)
      ) {
        return { kind: "code_gone" } as const;
      }

      const userRows = await tx
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.id, claims.userId))
        .limit(1)
        .for("update");
      const user = userRows[0];
      if (!user) return { kind: "no_user" } as const;
      if (user.status !== "ACTIVE") {
        return { kind: "user_suspended" } as const;
      }

      // The users table has no updated_at column (mirroring the pre-existing
      // schema); last_login_at is deliberately NOT touched, since the user has
      // not signed in yet — reset is not a login.
      await tx
        .update(users)
        .set({ passwordHash })
        .where(eq(users.id, user.id));

      // Spend the ticket. This is the atomic single-use gate: the hash is
      // cleared as a CONDITIONAL update, so a concurrent replay of the same
      // ticket matches 0 rows and never reaches the password write above.
      const spent = await tx
        .update(emailOtps)
        .set({ resetTicketHash: null })
        .where(
          and(
            eq(emailOtps.id, codeRow.id),
            eq(emailOtps.resetTicketHash, ticketHash)
          )
        )
        .returning({ id: emailOtps.id });
      if (spent.length !== 1) {
        return { kind: "code_gone" } as const;
      }

      return { kind: "ok" as const, userId: user.id };
    });

    if (result.kind !== "ok") {
      // Every post-ticket rejection is deliberately indistinguishable to the
      // caller. Telling an attacker "the code was fine but the account is
      // suspended" leaks account state to whoever holds a valid ticket.
      await insertAuditLog({
        userId: claims.userId,
        action: AuditAction.PASSWORD_RESET_SUCCESS,
        entityType: "User",
        entityId: claims.userId,
        details: {
          route: "/api/v1/auth/forgot-password/reset",
          method: "POST",
          result: "failed",
          reason: result.kind,
        },
      });
      return Response.json(
        {
          success: false,
          message: "Your reset link is invalid or has expired. Please request a new code.",
          code: "RESET_TICKET_INVALID",
        },
        { status: 400 }
      );
    }

    // Outside the transaction on purpose: this is a single idempotent UPDATE and
    // it must NOT be able to roll back the password change. If it fails, the
    // password is still reset and the old sessions are still individually
    // invalidated by their own 15-minute access-token expiry.
    revokedSessionCount = await revokeAllUserSessions(
      result.userId,
      RevokeReason.PASSWORD_RESET
    );
  } catch (error) {
    console.error(
      "Forgot password reset: transaction failed",
      safeErrorLog(error)
    );
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  await insertAuditLog({
    userId: claims.userId,
    action: AuditAction.PASSWORD_RESET_SUCCESS,
    entityType: "User",
    entityId: claims.userId,
    details: {
      route: "/api/v1/auth/forgot-password/reset",
      method: "POST",
      result: "success",
      revokedSessionCount,
    },
  });

  // The browser may itself be holding a session created before the reset; clear
  // the cookie so the UI cannot loop on a dead token. Attributes must match the
  // ones used when setting it or the browser keeps the original.
  const clearCookie = buildClearRefreshCookieHeader(
    refreshCookieIsSecure(request.headers.get("host"))
  );

  return Response.json(
    {
      success: true,
      message:
        "Your password has been reset. Please sign in with your new password on all devices.",
      data: { sessionsRevoked: revokedSessionCount },
    },
    { status: 200, headers: { "Set-Cookie": clearCookie } }
  );
}
