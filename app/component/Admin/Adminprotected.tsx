import { Navigate, Outlet, useLocation } from "react-router";

// Layout guard สำหรับ route ฝั่งแอดมิน — ใช้คู่กับ layout() ใน routes.ts
// ถ้ายังไม่ได้ login ผ่าน /admin/login จะเด้งกลับไปหน้า login ทันที
export default function AdminProtectedRoute() {
  const location = useLocation();
  const isAdminLoggedIn = sessionStorage.getItem("stax_admin_session") === "true";

  if (!isAdminLoggedIn) {
    // จำ path ที่ตั้งใจจะเข้า ไว้เด้งกลับมาหลัง login สำเร็จ
    return (
      <Navigate to="/admin/login" replace state={{ from: location.pathname }} />
    );
  }

  return <Outlet />;
}