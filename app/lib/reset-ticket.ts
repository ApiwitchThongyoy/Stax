// Short-lived "reset tickets": the bridge between verifying a password-reset OTP
// and actually choosing a new password.
//
// WHY A TICKET
// Verifying the code and setting the new password are two acts a user performs
// minutes apart, across two HTTP requests, and the plaintext code must not be
// trusted again after verification (it may have been shoulder-surfed, and the
// client is not a trusted party). So verification mints a signed ticket and the
// reset route exchanges it for the new password.
//
// THE TICKET IS DELIBERATELY NARROW
//   * 5-minute lifetime: a stolen ticket is useless almost immediately.
//   * audience "stax-password-reset": a different audience from the access token,
//     so a ticket can NEVER be replayed as an access token (jwt.verify rejects a
//     wrong audience) and an access token can never be replayed as a ticket.
//   * purpose is asserted on use, so a ticket minted for a different flow is
//     refused even if its audience matched.
//   * it embeds the OTP row id, which ties the ticket to the exact code that was
//     verified — so requesting a fresh code (which replaces the row) invalidates
//     any ticket minted from the previous one.
//   * it carries NO email, NO password material and NO code.
//   * it is single-use on the SERVER, not just the signature. A valid signature
//     only proves the ticket was minted here; it does not prove nobody else
//     already spent it. The server therefore keeps hashResetTicket(ticket) on the
//     OTP row and clears it in one conditional UPDATE (see the reset route), so a
//     replayed ticket is refused even though its signature is still valid.
//     Without that, a captured ticket would let its holder set a *different*
//     password for the next 5 minutes — the signature check alone cannot stop it.
//
// It is signed with the same JWT_SECRET as the access token, which is fine: the
// audience + purpose scoping is what keeps the two token classes apart, and the
// ticket is useless without ALSO passing the server-side checks in the reset
// route (session status, ticket still unspent, code still owned by the user).
//
// THE TWO TOKEN CLASSES ARE SEPARATED IN BOTH DIRECTIONS, ON PURPOSE.
// A ticket is signed with RESET_TICKET_AUDIENCE and carries no email/role, so
// verifyAuth refuses it on both counts. That redundancy is deliberate: today the
// access verifier would also reject a ticket simply because it lacks email and
// role, but relying on that alone would be protection by accident — a future
// change that added those claims to a ticket would silently open a path where a
// 5-minute reset ticket authenticates as a session. So the access token also
// carries ACCESS_TOKEN_AUDIENCE and verifyAuth asserts it.

import { createHash, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";

/** Deliberately very short: the user is on the "choose a password" screen. */
export const RESET_TICKET_TTL_SECONDS = 5 * 60;

/** Distinct audience so a ticket can never be replayed as an access token. */
export const RESET_TICKET_AUDIENCE = "stax-password-reset";

export const RESET_TICKET_PURPOSE = "PASSWORD_RESET";

export interface ResetTicketClaims {
  userId: string;
  otpId: string;
  purpose: string;
}

function secret(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.JWT_SECRET;
  if (typeof value !== "string" || value.length < 16) {
    throw new Error("JWT_SECRET must be configured before a reset ticket can be signed");
  }
  return value;
}

/** Mint a ticket bound to one verified OTP row. */
export function signResetTicket(
  claims: ResetTicketClaims,
  env: NodeJS.ProcessEnv = process.env
): string {
  return jwt.sign(claims, secret(env), {
    expiresIn: RESET_TICKET_TTL_SECONDS,
    audience: RESET_TICKET_AUDIENCE,
  });
}

/**
 * Verify a ticket and return its claims, or null.
 *
 * Null covers every failure (bad signature, wrong audience, wrong purpose,
 * expired, malformed) so the caller has a single "no" path and cannot
 * accidentally treat one failure mode as more trustworthy than another.
 */
export function verifyResetTicket(
  ticket: unknown,
  env: NodeJS.ProcessEnv = process.env
): ResetTicketClaims | null {
  if (typeof ticket !== "string" || ticket.length === 0) return null;
  try {
    const decoded = jwt.verify(ticket, secret(env), {
      audience: RESET_TICKET_AUDIENCE,
    });
    if (typeof decoded === "string" || decoded === null) return null;
    const payload = decoded as Record<string, unknown>;
    const { userId, otpId, purpose } = payload;
    if (typeof userId !== "string" || userId === "") return null;
    if (typeof otpId !== "string" || otpId === "") return null;
    // Defence in depth: even though this server is the only minter, refuse a
    // ticket whose purpose is not the reset flow.
    if (purpose !== RESET_TICKET_PURPOSE) return null;
    return { userId, otpId, purpose };
  } catch {
    return null;
  }
}

/**
 * Digest of a ticket, stored on the OTP row to mark the ticket as UNSPENT.
 *
 * The plaintext ticket is never stored — only this digest, exactly like the code
 * itself, so a stolen database snapshot cannot be used to complete a reset.
 */
export function hashResetTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

/**
 * Constant-time digest comparison, for callers that compare a presented ticket
 * against a stored hash without a conditional UPDATE.
 *
 * The reset route prefers the atomic conditional UPDATE instead — it is stronger,
 * because it also consumes the claim — so this exists for read-only checks
 * (e.g. verification probes) that must not leak timing.
 */
export function resetTicketHashMatches(ticket: string, hash: string): boolean {
  const presented = Buffer.from(hashResetTicket(ticket), "utf8");
  const stored = Buffer.from(hash, "utf8");
  // length() leaks only the digest's own length, which is fixed at 64 hex chars
  // and never secret.
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}
