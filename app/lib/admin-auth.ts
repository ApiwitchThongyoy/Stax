const ADMIN_SESSION_KEY = "stax_admin_session";

export interface AdminSessionUser {
  id: string;
  email: string;
  role: string;
}

export interface AdminSession {
  accessToken: string;
  user: AdminSessionUser;
}

function isTokenExpired(token: string): boolean {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return true;
    const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64)) as { exp?: unknown };
    if (typeof payload.exp !== "number") return false;
    return payload.exp * 1000 <= Date.now();
  } catch {
    return true;
  }
}

export function saveAdminSession(session: AdminSession): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
}

export function readAdminSession(): AdminSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(ADMIN_SESSION_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<AdminSession> | null;
    const accessToken = parsed?.accessToken;
    const role = parsed?.user?.role;

    if (typeof accessToken !== "string" || accessToken === "") return null;
    if (role !== "ADMIN") return null;
    if (isTokenExpired(accessToken)) return null;

    return {
      accessToken,
      user: {
        id: parsed?.user?.id ?? "",
        email: parsed?.user?.email ?? "",
        role,
      },
    };
  } catch {
    return null;
  }
}
