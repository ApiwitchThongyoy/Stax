/** Canonical email used for both registration and login lookups. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
