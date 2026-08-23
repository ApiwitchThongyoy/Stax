import { Navigate, Outlet, useLocation } from "react-router";
import { readAdminSession } from "../../lib/admin-auth";

// Layout guard สำหรับ route ฝั่งแอดมิน — ใช้คู่กับ layout() ใน routes.ts
// ตรวจ accessToken (JWT) + role ADMIN ที่ backend คืนมาตอน login ผ่าน /admin/login
// ถ้ายังไม่ได้ login, token หมดอายุ หรือไม่ใช่ ADMIN จะเด้งกลับไปหน้า login ทันที
export default function AdminProtectedRoute() {
  const location = useLocation();
  const adminSession = readAdminSession();

  if (!adminSession) {
    // จำ path ที่ตั้งใจจะเข้า ไว้เด้งกลับมาหลัง login สำเร็จ
    return (
      <Navigate to="/admin/login" replace state={{ from: location.pathname }} />
    );
  }

  return <Outlet />;
}