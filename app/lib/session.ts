const STORAGE_KEY = "stax_auth_user";
const ADMIN_SESSION_KEY = "stax_admin_session";

export function clearUserSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export function clearAdminSession(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(ADMIN_SESSION_KEY);
}

export function clearAllSessions(): void {
  clearUserSession();
  clearAdminSession();
}

/**
 * Detect a 403 response whose body carries the stable ACCOUNT_SUSPENDED code
 * produced by the backend (verifyAuth or login). Returns true only in that
 * specific case so the UI can clear the session and route the user to login.
 */
export async function isSuspendedResponse(
  res: Response | undefined | null
): Promise<boolean> {
  if (!res || res.status !== 403) return false;
  try {
    const data = (await res.clone().json()) as { code?: unknown } | null;
    return data?.code === "ACCOUNT_SUSPENDED";
  } catch {
    return false;
  }
}
