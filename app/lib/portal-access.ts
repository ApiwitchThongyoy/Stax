// Pure portal-access rules shared by the USER login flow and ProtectedLayout.
// Kept dependency-free so it can be tested without a browser/React.

/** The only role allowed into the normal USER portal. */
export const USER_PORTAL_ROLE = "USER";

/** Stable Thai message shown when an ADMIN tries the USER portal. */
export const ADMIN_USER_PORTAL_DENIED_MESSAGE =
  "บัญชีผู้ดูแลระบบไม่สามารถเข้าสู่ระบบผ่านหน้าผู้ใช้งานทั่วไปได้";

/**
 * Whether a role may use the normal USER portal. Only "USER" is allowed —
 * ADMIN (and any unknown role) is rejected, even if a stale/manual session
 * somehow carries it.
 */
export function canUseUserPortal(role: string | null | undefined): boolean {
  return role === USER_PORTAL_ROLE;
}
