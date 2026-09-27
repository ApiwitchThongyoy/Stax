import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import {
  canUseUserPortal,
  ADMIN_USER_PORTAL_DENIED_MESSAGE,
} from "./portal-access";
import { clearAllSessions } from "./session";
import { endSessionOnServer, type SessionUser } from "./session-refresh";

const STORAGE_KEY = "stax_auth_user";

interface AuthUser extends SessionUser {}

interface LoginResult {
  success: boolean;
  error?: string;
}

interface RegisterResult {
  success: boolean;
  error?: string;
}

/** Which flow an OTP belongs to. Sent to the server so codes cannot cross over. */
export type OtpPurpose = "register" | "password-reset";

interface RequestOtpResult {
  success: boolean;
  error?: string;
  /**
   * The six-digit code, but ONLY when the server is running with
   * AUTH_DEV_SHOW_OTP=true (never in production, and never on real accounts).
   * The UI shows it as an explicit development-only banner.
   */
  devOtp?: string;
  /** Seconds until another code may be requested (HTTP 429 / Retry-After). */
  retryAfterSeconds?: number;
  /** True when the code is on its way but delivery is not configured here. */
  awaitingDelivery?: boolean;
}

interface ResetPasswordResult {
  success: boolean;
  error?: string;
  /** The session is gone, so the caller must send the user back to the login page. */
  signedOut?: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => void;
  /**
   * Adopt a session returned by POST /api/v1/auth/refresh. Kept separate from
   * `login` because renewal is silent: it must not touch the login UI, and it
   * must never be able to promote an ADMIN into the USER portal the way an
   * explicit login can.
   */
  applyRefreshedSession: (user: SessionUser) => void;
  /** Drop local auth state ONLY, with no server call. For renewal failures. */
  clearSession: () => void;
  register: (email: string, password: string, otp: string) => Promise<RegisterResult>;
  requestOtp: (email: string, purpose: OtpPurpose) => Promise<RequestOtpResult>;
  resetPassword: (email: string, otp: string, newPassword: string) => Promise<ResetPasswordResult>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function readStoredUser(): AuthUser | null {
  if (typeof window === "undefined") return null; // SSR guard
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

function loginRateLimitMessage(response: Response): string {
  const retryAfterSeconds = Number(response.headers.get("Retry-After"));

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    const retryMinutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    return `มีการพยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณาลองใหม่อีกครั้งในประมาณ ${retryMinutes} นาที`;
  }

  return "มีการพยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => readStoredUser());

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const trimmedEmail = email.trim();

      if (!trimmedEmail || !password) {
        return { success: false, error: "กรุณากรอกอีเมลและรหัสผ่านให้ครบถ้วน" };
      }

      let response: Response;
      try {
        response = await fetch("/api/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: trimmedEmail, password }),
        });
      } catch {
        return { success: false, error: "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง" };
      }

      let data: {
        success?: boolean;
        data?: {
          accessToken?: string;
          user?: { id?: string; email?: string; role?: string };
        };
      };
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (response.status === 429) {
        return { success: false, error: loginRateLimitMessage(response) };
      }

      if (response.status === 401) {
        return { success: false, error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" };
      }

      if (response.status === 403) {
        const suspendedMsg =
          (data as { message?: string } | undefined)?.message ||
          "บัญชีนี้ถูกระงับ โปรดติดต่อผู้ดูแลระบบที่ [email]";
        return { success: false, error: suspendedMsg };
      }

      if (!response.ok || !data.success || !data.data?.accessToken || !data.data?.user) {
        return { success: false, error: "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" };
      }

      const { accessToken, user: apiUser } = data.data;

      // The normal USER portal only allows role USER. If an ADMIN authenticates
      // here (shared /api/v1/auth/login endpoint), do NOT save any USER session
      // and clear any accidental/stale session state. Admin must use the admin
      // login page instead.
      if (!canUseUserPortal(apiUser.role)) {
        clearAllSessions();
        setUser(null);
        return {
          success: false,
          error: ADMIN_USER_PORTAL_DENIED_MESSAGE,
        };
      }

      const nextUser: AuthUser = {
        id: apiUser.id ?? "",
        email: apiUser.email ?? trimmedEmail,
        role: apiUser.role ?? "USER",
        accessToken,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextUser));
      setUser(nextUser);
      return { success: true };
    },
    []
  );

  // Clears the client session. This is the ONLY way local auth state is dropped
  // besides a server-CONFIRMED 401 (see lib/session-probe.ts): an explicit user
  // logout, the role guard, the suspension overlay, or a confirmed expired /
  // revoked token. There is no inactivity/idle path — leaving the page idle,
  // switching tabs or minimizing the browser never calls this. Server-side
  // authorization is unaffected: every API route still validates the JWT with
  // verifyAuth regardless of what is stored in localStorage.
  //
  // The explicit logout asks the server to revoke the session first. The refresh
  // cookie is HttpOnly and 30-day sliding, so without that call a signed-out user
  // on a shared machine would still hold a live session in the browser. The call
  // is best-effort and never blocks: the local state is dropped either way,
  // because a user who clicked "log out" must not be stranded by a flaky network.
  const clearSession = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  }, []);

  const logout = useCallback(() => {
    clearSession();
    void endSessionOnServer();
  }, [clearSession]);

  // Silent renewal. Unlike `login` this must not run the USER-portal role guard:
  // a refresh can only ever belong to whoever logged in, and bouncing a valid
  // ADMIN session to the login screen because it was renewed would be a bug.
  const applyRefreshedSession = useCallback((next: SessionUser) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setUser(next);
  }, []);

  const register = useCallback(
    async (email: string, password: string, otp: string): Promise<RegisterResult> => {
      const trimmedEmail = email.trim();
      const trimmedOtp = otp.trim();

      if (!trimmedEmail || !password) {
        return { success: false, error: "กรุณากรอกอีเมลและรหัสผ่านให้ครบถ้วน" };
      }

      if (!trimmedOtp) {
        return { success: false, error: "กรุณากรอกรหัสยืนยันที่ได้รับ" };
      }

      let response: Response;
      try {
        response = await fetch("/api/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: trimmedEmail, password, otp: trimmedOtp }),
        });
      } catch {
        return {
          success: false,
          error: "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง",
        };
      }

      let data: { code?: string; message?: string };
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (response.status === 409 && data.code === "EMAIL_ALREADY_EXISTS") {
        return { success: false, error: "อีเมลนี้ถูกลงทะเบียนไว้แล้ว" };
      }

      // A spent/expired/wrong code is a normal, recoverable outcome of this form
      // — the user can simply request a new one — so it gets the server's own
      // message rather than a generic failure.
      if (response.status === 400) {
        return {
          success: false,
          error: data.message || "ข้อมูลการลงทะเบียนไม่ถูกต้อง",
        };
      }

      if (response.status === 429) {
        return { success: false, error: loginRateLimitMessage(response) };
      }

      if (!response.ok) {
        return { success: false, error: "ลงทะเบียนไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" };
      }

      return { success: true };
    },
    []
  );

  /**
   * Ask the server for a one-time code for `email`.
   *
   * The endpoint answers identically whether or not the account exists (that is
   * the whole point of it — the form must not become an account-enumeration
   * oracle), so a "success" here does NOT tell the user an email is registered.
   * The registration and recovery screens therefore both show the same neutral
   * "if that address can receive a code, it is on its way" message.
   */
  const requestOtp = useCallback(
    async (email: string, purpose: OtpPurpose): Promise<RequestOtpResult> => {
      const trimmedEmail = email.trim();
      if (!trimmedEmail) {
        return { success: false, error: "กรุณากรอกอีเมลให้ถูกต้อง" };
      }

      const path =
        purpose === "register"
          ? "/api/v1/auth/register/request-otp"
          : "/api/v1/auth/forgot-password/request-otp";

      let response: Response;
      try {
        response = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: trimmedEmail }),
        });
      } catch {
        return {
          success: false,
          error: "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง",
        };
      }

      let data: {
        success?: boolean;
        message?: string;
        data?: { devOtp?: string; retryAfterSeconds?: number };
      };
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (response.status === 429) {
        const retryAfterSeconds = Number(response.headers.get("Retry-After"));
        return {
          success: false,
          error: loginRateLimitMessage(response),
          ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? { retryAfterSeconds }
            : {}),
        };
      }

      if (!response.ok || !data.success) {
        return {
          success: false,
          error: data.message || "ไม่สามารถส่งรหัสยืนยันได้ กรุณาลองใหม่อีกครั้ง",
        };
      }

      return {
        success: true,
        awaitingDelivery: true,
        ...(data.data?.devOtp ? { devOtp: data.data.devOtp } : {}),
        ...(typeof data.data?.retryAfterSeconds === "number"
          ? { retryAfterSeconds: data.data.retryAfterSeconds }
          : {}),
      };
    },
    []
  );

  /**
   * Finish a password reset: exchange the emailed code for a short ticket, then
   * set the new password with that ticket.
   *
   * The two steps are separate server calls on purpose. The code is a long-ish
   * lived secret that proves mailbox access, so it is burned the moment it is
   * exchanged; what continues to the actual password change is a ticket that
   * lasts minutes and carries no email, code or password. A stolen code is
   * therefore useless after one use, and the window in which the reset can be
   * completed is short.
   */
  const resetPassword = useCallback(
    async (
      email: string,
      otp: string,
      newPassword: string
    ): Promise<ResetPasswordResult> => {
      const trimmedEmail = email.trim();
      const trimmedOtp = otp.trim();
      if (!trimmedEmail || !trimmedOtp || !newPassword) {
        return { success: false, error: "กรุณากรอกข้อมูลให้ครบถ้วน" };
      }

      let response: Response;
      try {
        response = await fetch("/api/v1/auth/forgot-password/verify-otp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: trimmedEmail, otp: trimmedOtp }),
        });
      } catch {
        return {
          success: false,
          error: "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง",
        };
      }

      let verifyData: {
        success?: boolean;
        message?: string;
        data?: { resetTicket?: string };
      };
      try {
        verifyData = await response.json();
      } catch {
        verifyData = {};
      }

      if (!response.ok || !verifyData.success || !verifyData.data?.resetTicket) {
        return {
          success: false,
          error: verifyData.message || "รหัสยืนยันไม่ถูกต้องหรือหมดอายุ",
        };
      }

      let resetResponse: Response;
      try {
        resetResponse = await fetch("/api/v1/auth/forgot-password/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: trimmedEmail,
            resetTicket: verifyData.data.resetTicket,
            newPassword,
          }),
        });
      } catch {
        return {
          success: false,
          error: "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง",
        };
      }

      let resetData: { success?: boolean; message?: string; code?: string };
      try {
        resetData = await resetResponse.json();
      } catch {
        resetData = {};
      }

      if (!resetResponse.ok || !resetData.success) {
        return {
          success: false,
          error: resetData.message || "เปลี่ยนรหัสผ่านไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
        };
      }

      return { success: true, signedOut: true };
    },
    []
  );

  const value: AuthContextValue = {
    user,
    isAuthenticated: !!user,
    login,
    logout,
    applyRefreshedSession,
    clearSession,
    register,
    requestOtp,
    resetPassword,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth ต้องถูกเรียกภายใต้ <AuthProvider> เท่านั้น");
  }
  return ctx;
}
