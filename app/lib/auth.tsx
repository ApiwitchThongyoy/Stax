import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import {
  canUseUserPortal,
  ADMIN_USER_PORTAL_DENIED_MESSAGE,
} from "./portal-access";
import { clearAllSessions } from "./session";

const STORAGE_KEY = "stax_auth_user";

interface AuthUser {
  id: string;
  email: string;
  role: string;
  accessToken: string;
}

interface LoginResult {
  success: boolean;
  error?: string;
}

interface RegisterResult {
  success: boolean;
  error?: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => void;
  register: (email: string, password: string) => Promise<RegisterResult>;
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

  const logout = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  }, []);

  const register = useCallback(
    async (email: string, password: string): Promise<RegisterResult> => {
      const trimmedEmail = email.trim();

      if (!trimmedEmail || !password) {
        return { success: false, error: "กรุณากรอกอีเมลและรหัสผ่านให้ครบถ้วน" };
      }

      let response: Response;
      try {
        response = await fetch("/api/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: trimmedEmail, password }),
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

      if (response.status === 400) {
        return {
          success: false,
          error: data.message || "ข้อมูลการลงทะเบียนไม่ถูกต้อง",
        };
      }

      if (!response.ok) {
        return { success: false, error: "ลงทะเบียนไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" };
      }

      return { success: true };
    },
    []
  );

  const value: AuthContextValue = {
    user,
    isAuthenticated: !!user,
    login,
    logout,
    register,
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