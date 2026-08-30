import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { readAdminSession } from "../../lib/admin-auth";
import { clearAllSessions } from "../../lib/session";

// Layout guard สำหรับ route ฝั่งแอดมิน — ใช้คู่กับ layout() ใน routes.ts
// ตรวจ accessToken (JWT) + role ADMIN ที่ backend คืนมาตอน login ผ่าน /admin/login
// ใช้ client-side navigate (ไม่ใช่ <Navigate>) หลัง mount เพื่อกัน SSR/StaticRouter
// hydration mismatch ที่อาจทำให้จอขาวตอนออกจากระบบ
export default function AdminProtectedRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const adminSession = readAdminSession();

  useEffect(() => {
    if (!adminSession) {
      // หลัง logout ทั้ง admin และ user session ต้องถูกกวาดทิ้ง เพื่อไม่ให้
      // หลงเหลือ session ฝั่งผู้ใช้งานค้างอยู่เบื้องหลังหน้า admin/login
      clearAllSessions();
      // จำ path ที่ตั้งใจจะเข้า ไว้เด้งกลับมาหลัง login สำเร็จ
      navigate("/admin/login", {
        replace: true,
        state: { from: location.pathname },
      });
    }
  }, [adminSession, navigate, location.pathname]);

  return <Outlet />;
}
