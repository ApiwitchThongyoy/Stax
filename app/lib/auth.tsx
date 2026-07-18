import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

const STORAGE_KEY = "stax_auth_user";
const USERS_KEY = "stax_registered_users";

interface AuthUser {
  email: string;
}

interface RegisteredUser {
  email: string;
  password: string;
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
  login: (email: string, password: string) => LoginResult;
  logout: () => void;
  register: (email: string, password: string) => RegisterResult;
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

function readRegisteredUsers(): RegisteredUser[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(USERS_KEY);
    return raw ? (JSON.parse(raw) as RegisteredUser[]) : [];
  } catch {
    return [];
  }
}

function saveRegisteredUsers(users: RegisteredUser[]) {
  window.localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => readStoredUser());

  const login = useCallback((email: string, password: string): LoginResult => {
    const trimmedEmail = email.trim();

    if (!trimmedEmail || !password) {
      return { success: false, error: "กรุณากรอกอีเมลและรหัสผ่านให้ครบถ้วน" };
    }

    // TODO: ตรงนี้คือจุดที่ควรเรียก API login จริง (ตรวจรหัสผ่าน, รับ token ฯลฯ)
    // ตอนนี้ mock ไว้ก่อนด้วยการเช็คกับรายชื่อผู้ใช้ที่ลงทะเบียนไว้ใน localStorage
    const users = readRegisteredUsers();
    const match = users.find(
      (u) =>
        u.email.toLowerCase() === trimmedEmail.toLowerCase() &&
        u.password === password
    );

    if (!match) {
      return { success: false, error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" };
    }

    const nextUser: AuthUser = { email: match.email };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextUser));
    setUser(nextUser);
    return { success: true };
  }, []);

  const logout = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  }, []);

  const register = useCallback((email: string, password: string): RegisterResult => {
    const trimmedEmail = email.trim();

    if (!trimmedEmail || !password) {
      return { success: false, error: "กรุณากรอกอีเมลและรหัสผ่านให้ครบถ้วน" };
    }

    // TODO: ตรงนี้คือจุดที่ควรเรียก API สมัครสมาชิกจริง
    // ตอนนี้ mock ไว้ก่อนด้วยการเก็บลง localStorage
    const users = readRegisteredUsers();
    const alreadyExists = users.some(
      (u) => u.email.toLowerCase() === trimmedEmail.toLowerCase()
    );

    if (alreadyExists) {
      return { success: false, error: "อีเมลนี้ถูกลงทะเบียนไว้แล้ว" };
    }

    users.push({ email: trimmedEmail, password });
    saveRegisteredUsers(users);
    return { success: true };
  }, []);

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