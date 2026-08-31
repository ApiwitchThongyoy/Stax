import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../lib/auth";
import { clearAllSessions } from "../lib/session";
import { canUseUserPortal } from "../lib/portal-access";
import { useSuspendedAccount } from "../lib/suspended-account";
import { useAccountStatusPolling } from "../lib/useAccountStatusPolling";

export default function ProtectedLayout() {
  const { isAuthenticated, user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { markSuspended, markReactivated } = useSuspendedAccount();
  const [mounted, setMounted] = useState(false);

  // Authoritative suspended-account poll for the authenticated USER session.
  // Mounted here at the protected shell so it runs for EVERY protected route
  // (dashboard tabs, settings, ledger, archive) regardless of the active tab.
  // Exactly one instance; Dashboard must NOT start a second one.
  console.log("[ACCOUNT_STATUS] ProtectedLayout mounted", {
    isAuthenticated,
    hasToken: !!user?.accessToken,
  });
  useAccountStatusPolling({
    enabled: !!user?.accessToken && isAuthenticated,
    accessToken: user?.accessToken ?? null,
    onSuspended: () => {
      console.log("[ACCOUNT_STATUS] markSuspended called");
      markSuspended();
    },
    onActive: () => {
      console.log("[ACCOUNT_STATUS] markReactivated called");
      markReactivated();
    },
  });

  useEffect(() => {
    setMounted(true);
  }, []);

  // Redirect client-side after mount/hydration instead of rendering <Navigate>.
  // Rendering <Navigate> during the initial (SSR/StaticRouter) render of an
  // auth-dependent guard causes a hydration/navigation mismatch that can blank
  // the screen after logout. Reacting in an effect keeps the server and the
  // first client render identical.
  useEffect(() => {
    // ไม่มี session ฝั่งผู้ใช้ (logout แล้ว หรือยังไม่ login) -> กลับไปหน้า login
    // ทางที่ถูกต้องเสมอ เพื่อให้ protected route ไม่รั่วหลัง logout
    if (!isAuthenticated) {
      navigate("/login", { replace: true, state: { from: location.pathname } });
      return;
    }

    // Defense in depth: the normal USER portal only allows role USER. Even if a
    // stale/manual ADMIN (or other non-USER) session somehow exists, clear it
    // and redirect to the USER login — never render the Dashboard for it.
    if (user && !canUseUserPortal(user.role)) {
      clearAllSessions();
      logout();
      navigate("/login", { replace: true });
      return;
    }

    // มี session ในเครื่องแล้ว -> validate กับ backend หนึ่งครั้งต่อ entry
    // เพื่อกันกรณี token หมดอายุ/ถูกเพิกถอน (401) ให้กวาด session แล้วเด้งไป
    // /login. 403 + ACCOUNT_SUSPENDED ถูกจัดการต่อโดย useAccountStatusPolling
    // ที่ dashboard ซึ่งเปิด overlay แบบเดิม (ไม่ทำลาย flow เดิม)
    const token = user?.accessToken;
    if (!token) return;
    let alive = true;
    fetch("/api/v1/auth/session", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!alive) return;
        if (res.status === 401) {
          clearAllSessions();
          logout();
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isAuthenticated, user?.accessToken, logout, navigate, location.pathname]);

  // Authoritative guard: never render protected children when there is no
  // authenticated session. Once the session is cleared (logout/suspension) the
  // children unmount entirely, so Dashboard can never render a fallback
  // identity or previous user's state. `mounted` keeps the first client render
  // identical to the server render (which has no localStorage session) to avoid
  // a hydration mismatch.
  if (!isAuthenticated) return null;
  if (!mounted) return null;
  if (user && !canUseUserPortal(user.role)) return null;

  return <Outlet />;
}