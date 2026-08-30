import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import StaxLogo from "../component/Login/StaxLogo";
import { useAuth } from "./auth";
import {
  clearAdminSession,
  clearAllSessions,
  isSuspendedResponse,
} from "./session";

interface SuspendedAccountContextValue {
  accountStatus: AccountStatus;
  suspended: boolean;
  markSuspended: () => void;
  reactivated: boolean;
  markReactivated: () => void;
  resetSuspended: () => void;
}

export type AccountStatus = "normal" | "suspended" | "reactivated";

/**
 * Public/auth routes where the suspended overlay must never render. Entering
 * any of these also clears stale suspended state and any leftover user session
 * so the state cannot leak back later (e.g. after navigating to /register and
 * then returning to a protected area).
 */
const PUBLIC_AUTH_PATHS: string[] = [
  "/",
  "/login",
  "/register",
  "/admin/login",
  "/reset-password",
  "/verify-email",
];

function isPublicAuthPath(pathname: string): boolean {
  return PUBLIC_AUTH_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );
}

const SuspendedAccountContext =
  createContext<SuspendedAccountContextValue | undefined>(undefined);

export function SuspendedAccountProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [accountStatus, setAccountStatus] =
    useState<AccountStatus>("normal");
  const location = useLocation();
  const { logout, user } = useAuth();
  const prevUserIdRef = useRef<string | null>(user?.id ?? null);

  const markSuspended = useCallback(
    () => setAccountStatus("suspended"),
    []
  );
  const markReactivated = useCallback(
    () => setAccountStatus("reactivated"),
    []
  );
  const resetSuspended = useCallback(() => setAccountStatus("normal"), []);

  const isPublic = isPublicAuthPath(location.pathname);

  // When entering a public/auth route, never show the overlay/dialog and clear
  // any stale account-status state together with the leftover user session so
  // it cannot resurface on the public page or leak back later.
  useEffect(() => {
    if (isPublic) {
      setAccountStatus("normal");
      logout();
      clearAdminSession();
    }
  }, [isPublic, logout]);

  // A fresh authenticated session must never inherit stale suspended/reactivated
  // state from a previous session. Successful login for an ACTIVE account is
  // the only way `user?.id` becomes non-null, so whenever it does, start each
  // new session in the "normal" state. Same-session transitions (suspended ->
  // reactivated while still authenticated, same userId) are left untouched so
  // reactivation detection and the welcome-back dialog keep working.
  useEffect(() => {
    const prevId = prevUserIdRef.current;
    prevUserIdRef.current = user?.id ?? null;
    if (user?.id && prevId !== user.id) {
      setAccountStatus("normal");
    }
  }, [user?.id]);

  const value = useMemo<SuspendedAccountContextValue>(() => {
    const safe = isPublic ? "normal" : accountStatus;
    return {
      accountStatus: safe,
      suspended: safe === "suspended",
      markSuspended,
      reactivated: safe === "reactivated",
      markReactivated,
      resetSuspended,
    };
  }, [isPublic, accountStatus, markSuspended, markReactivated, resetSuspended]);

  return (
    <SuspendedAccountContext.Provider value={value}>
      {children}
    </SuspendedAccountContext.Provider>
  );
}

export function useSuspendedAccount(): SuspendedAccountContextValue {
  const ctx = useContext(SuspendedAccountContext);
  if (!ctx) {
    throw new Error(
      "useSuspendedAccount ต้องถูกเรียกภายใต้ <SuspendedAccountProvider> เท่านั้น"
    );
  }
  return ctx;
}

/**
 * Helper for authenticated fetches. If the response is a 403 carrying the
 * backend's stable `ACCOUNT_SUSPENDED` code, it idempotently activates the
 * suspension overlay and returns true so the caller can stop processing the
 * (partial/error) response. Returns false for any other response.
 */
export async function flagSuspendedFromResponse(
  res: Response | undefined | null,
  markSuspended: () => void
): Promise<boolean> {
  const hit = await isSuspendedResponse(res);
  if (hit) {
    markSuspended();
  }
  return hit;
}

/**
 * Full-screen suspension overlay shown on top of the current dashboard.
 * The dashboard stays visible behind a dimmed/blurred scrim, all background
 * interaction is blocked, and the user can only return to the login screen.
 */
export function AppSuspendedOverlay() {
  const { accountStatus, resetSuspended } = useSuspendedAccount();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();

  if (accountStatus === "normal") {
    return null;
  }

  // Defensive fallback: never render the overlay over public auth routes
  // (e.g. any stale state that might momentarily persist).
  if (isPublicAuthPath(location.pathname)) {
    return null;
  }

  const isSuspended = accountStatus === "suspended";

  const handleSuspendedReturn = () => {
    // Client-side navigation on a user gesture — no <Navigate> during initial
    // SSR render, so it cannot cause the previous hydration white-screen.
    // Reset the global suspended state so the overlay unmounts immediately,
    // then clear auth sessions and send the user to the login page.
    resetSuspended();
    clearAllSessions();
    navigate("/login", { replace: true });
  };

  const handleReactivatedContinue = () => {
    resetSuspended();
    // If the authenticated session/token is still present, go to the dashboard
    // with the existing (DB-verified) session. If it was cleared earlier, send
    // the user to login to sign in normally. Never fabricate a session/token.
    const hasSession = !!user?.accessToken;
    navigate(hasSession ? "/dashboard" : "/login", { replace: true });
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby={
        isSuspended ? "suspended-title" : "reactivated-title"
      }
    >
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-6 pt-7 flex flex-col items-center text-center">
          <div
            className={
              isSuspended
                ? "w-14 h-14 rounded-full bg-red-50 flex items-center justify-center mb-4"
                : "w-14 h-14 rounded-full bg-emerald-50 flex items-center justify-center mb-4"
            }
          >
            {isSuspended ? (
              <ShieldAlert className="w-7 h-7 text-red-500" />
            ) : (
              <CheckCircle2 className="w-7 h-7 text-emerald-500" />
            )}
          </div>
          <h2
            id={isSuspended ? "suspended-title" : "reactivated-title"}
            className="text-lg font-semibold text-gray-800"
          >
            {isSuspended ? "บัญชีนี้ถูกระงับ" : "ยินดีต้อนรับกลับมา"}
          </h2>
          <p className="text-sm text-gray-500 mt-2 leading-relaxed">
            {isSuspended
              ? "บัญชีของคุณถูกระงับ โปรดติดต่อผู้ดูแลระบบที่ [email]"
              : "บัญชีของคุณได้รับการเปิดใช้งานอีกครั้งแล้ว"}
          </p>
        </div>

        <div className="px-6 pb-7 pt-5">
          <button
            type="button"
            onClick={isSuspended ? handleSuspendedReturn : handleReactivatedContinue}
            className="w-full bg-blue-900 hover:bg-blue-950 text-white text-sm font-medium py-2.5 rounded-lg flex items-center justify-center gap-2 transition cursor-pointer"
          >
            {isSuspended ? "กลับสู่หน้าเข้าสู่ระบบ" : "ไปหน้าหลัก"}
          </button>
        </div>

        <div className="flex items-center justify-center gap-2 pb-6">
          <StaxLogo width="72px" transparent compact />
        </div>
      </div>
    </div>
  );
}
