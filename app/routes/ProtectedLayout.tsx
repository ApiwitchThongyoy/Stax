import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../lib/auth";
import { clearAllSessions } from "../lib/session";
import { canUseUserPortal } from "../lib/portal-access";
import { useSuspendedAccount } from "../lib/suspended-account";
import { useAccountStatusPolling } from "../lib/useAccountStatusPolling";
import { clearsSession, probeSession } from "../lib/session-probe";
import { needsRefresh } from "../lib/session-refresh";
import { useSessionRefresh } from "../lib/useSessionRefresh";

export default function ProtectedLayout() {
  const { isAuthenticated, user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { markSuspended, markReactivated } = useSuspendedAccount();
  const [mounted, setMounted] = useState(false);

  // Silent renewal for the whole protected subtree. The access token only lives
  // 15 minutes, so without this a user working through a long report would be
  // bounced to the login screen mid-task. Mounted at the shell so there is
  // exactly one renewal loop per tab no matter which tab of the Dashboard is
  // active. Mounted BEFORE the probe below on purpose: the probe runs against
  // whatever token is in state, and a renewal that lands first turns a would-be
  // 401 into a no-op.
  useSessionRefresh({ enabled: !!user?.accessToken && isAuthenticated });

  // Authoritative suspended-account poll for the authenticated USER session.
  // Mounted here at the protected shell so it runs for EVERY protected route
  // (dashboard tabs, settings, ledger, archive) regardless of the active tab.
  // Exactly one instance; Dashboard must NOT start a second one.
  // onUnauthorized fires only for a CONFIRMED 401 — never for a transient
  // network/5xx failure, so idling or backgrounding the tab cannot sign the
  // user out.
  useAccountStatusPolling({
    enabled: !!user?.accessToken && isAuthenticated,
    accessToken: user?.accessToken ?? null,
    onSuspended: () => {
      markSuspended();
    },
    onActive: () => {
      markReactivated();
    },
    onUnauthorized: () => {
      clearAllSessions();
      logout();
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
    // เพื่อกันกรณี token หมดอายุ/ถูกเพิกถอน (401 ที่ยืนยันแล้ว) ให้กวาด session
    // แล้วเด้งไป /login.  403 + ACCOUNT_SUSPENDED ถูกจัดการต่อโดย
    // useAccountStatusPolling ที่ dashboard ซึ่งเปิด overlay แบบเดิม
    // (ไม่ทำลาย flow เดิม)
    //
    // สำคัญ: เคยมีการล้าง session จาก transient error (เครือข่ายล่ม/5xx) ทำให้
    // ผู้ใช้ที่แค่ปล่อยหน้าค้างไว้หรือสลับแท็บเหมือนถูก logout — ตอนนี้เฉพาะ
    // 401 ที่ยืนยันซ้ำแล้วเท่านั้นที่ล้าง auth state; transient ไม่แตะ session
    const token = user?.accessToken;
    if (!token) return;
    let alive = true;

    // Do NOT probe a token that is already expired (or about to be). The renewal
    // loop above owns that case: probing an expired token necessarily returns
    // 401, which the confirmation logic would then treat as a genuine rejection
    // and sign the user out — even though a refresh was in flight and about to
    // succeed. That race would produce exactly the bug this work set out to
    // remove: a page reload with an expired token logging the user out.
    // `needsRefresh` covers the near-expiry case as well, so the probe always
    // runs against a comfortably valid token.
    if (needsRefresh(token)) return;

    void probeSession({ token }).then((outcome) => {
      if (!alive) return;
      if (clearsSession(outcome)) {
        clearAllSessions();
        logout();
      }
    });
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