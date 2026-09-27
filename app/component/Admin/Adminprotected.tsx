import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { readAdminSession, type AdminSession } from "../../lib/admin-auth";
import { clearAllSessions } from "../../lib/session";
import {
  needsRefresh,
  refreshAdminAccessToken,
  readJwtExpiry,
} from "../../lib/session-refresh";

// Layout guard สำหรับ route ฝั่งแอดมิน — ใช้คู่กับ layout() ใน routes.ts
// ตรวจ accessToken (JWT) + role ADMIN ที่ backend คืนมาตอน login ผ่าน /admin/login
// ใช้ client-side navigate (ไม่ใช่ <Navigate>) หลัง mount เพื่อกัน SSR/StaticRouter
// hydration mismatch ที่อาจทำให้จอขาวตอนออกจากระบบ
//
// การต่ออายุ (silent refresh): access token มีอายุสั้น (15 นาที) และแอดมิน
// login ผ่าน /api/v1/auth/login เหมือนผู้ใช้ทั่วไป เพราะฉะนั้นเบราว์เซอร์จะมี
// refresh cookie (HttpOnly) ให้เรียก /api/v1/auth/refresh เงียบ ๆ ได้
// ก่อนหน้านี้ผู้ดูแลระบบจะถูกด���นไปหน้า admin/login ทุกครั้งที่ token หมดอายุ
//
// หมายเหตุเรื่องความปลอดภัย: refresh จะคืน role ของเจ้าของ cookie มาด้วย
// ถ้าคืน role ที่ไม่ใช่ ADMIN (เช่นผู้ใช้ทั่วไปล็อกอินในแท็บเดียวกัน) โค้ดจะ
// ไม่เขียนทับ session ฝั่งแอดมิน เพื่อไม่ให้ token ของ USER หลุดเข้าเส้นทางแอดมิน
export default function AdminProtectedRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  // Held in state (not read straight from storage on every render) so a renewal
  // actually re-renders this guard. Before this the layout read storage once and
  // could never observe a rotated token.
  const [adminSession, setAdminSession] = useState<AdminSession | null>(() =>
    readAdminSession()
  );

  const signOutAndRedirect = useCallback(() => {
    // หลัง logout ทั้ง admin และ user session ต้องถูกกวาดทิ้ง เพื่อไม่ให้
    // หลงเหลือ session ฝั่งผู้ใช้งานค้างอยู่เบื้องหลังหน้า admin/login
    clearAllSessions();
    setAdminSession(null);
    // จำ path ที่ตั้งใจจะเข้า ไว้เด้งกลับมาหลัง login สำเร็จ
    navigate("/admin/login", {
      replace: true,
      state: { from: location.pathname },
    });
  }, [navigate, location.pathname]);

  useEffect(() => {
    if (!adminSession) {
      signOutAndRedirect();
    }
  }, [adminSession, signOutAndRedirect]);

  // --- silent renewal ------------------------------------------------------
  useEffect(() => {
    if (!adminSession) return;

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (token: string) => {
      if (timer !== null) clearTimeout(timer);
      const exp = readJwtExpiry(token);
      // ตื่น 60 วินาทีก่อนหมดอายุ; ถ้าอ่าน exp ไม่ได้ให้ลองอีก 5 นาทีแทน
      const delay = exp === null ? 5 * 60_000 : Math.max(exp - Date.now() - 60_000, 5_000);
      timer = setTimeout(() => void run(false), delay);
    };

    const run = async (force: boolean) => {
      const result = await refreshAdminAccessToken(force);
      if (!alive) return;
      if (result.ok) {
        setAdminSession(readAdminSession());
        schedule(result.user.accessToken);
        return;
      }
      if (result.reason === "rejected") {
        signOutAndRedirect();
        return;
      }
      // network -> session intact, retry soon
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void run(false), 30_000);
    };

    if (needsRefresh(adminSession.accessToken)) {
      void run(true);
    } else {
      schedule(adminSession.accessToken);
    }

    // แท็บที่ถูกพักไว้นาน ๆ จะกลับมาพร้อม token ที่หมดอายุแล้ว
    const onWake = () => {
      if (document.visibilityState === "hidden" || document.hidden) return;
      const current = readAdminSession();
      if (current && needsRefresh(current.accessToken)) void run(true);
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);

    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [adminSession, signOutAndRedirect]);

  return <Outlet />;
}
