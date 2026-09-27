// The ONE definition of STAX's password rule, shared by every place a password is
// set or changed.
//
// WHY A SHARED MODULE
// Registration and password reset each have their own route, and they originally
// grew their own inline checks. That is how password rules drift: the reset flow
// ended up demanding an uppercase letter and a digit while registration accepted
// any 8 characters — so a user could sign up with a weak-ish password and then be
// unable to reset to anything resembling the password they already use, which is a
// confusing, self-inflicted lockout. One definition removes the possibility.
//
// The rule itself is deliberately unchanged from the long-standing registration
// rule (8+ characters). It is NOT tightened here: existing accounts were created
// under it, and silently requiring more of a password on the *reset* path would
// strand those users mid-recovery. Password strength is an argument for a
// future migration, not something to change inside a security fix.

/** Minimum password length. Matches the historical registration rule. */
export const PASSWORD_MIN_LENGTH = 8;

/** bcrypt cost factor used for every stored credential in this app. */
export const BCRYPT_ROUNDS = 10;

export type PasswordPolicyResult = { ok: true } | { ok: false; message: string };

/**
 * Pure password check. Returns the user-facing message on failure so both routes
 * report the identical text.
 */
export function checkPasswordPolicy(password: unknown): PasswordPolicyResult {
  if (typeof password !== "string" || password.length === 0) {
    return { ok: false, message: "Password is required" };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    };
  }
  return { ok: true };
}
