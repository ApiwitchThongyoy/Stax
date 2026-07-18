import { Navigate, Outlet, useLocation } from "react-router";
import { useAuth } from "../lib/auth";

export default function ProtectedLayout() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    // จำ path ที่ผู้ใช้ตั้งใจจะเข้า ไว้ใน state เพื่อเด้งกลับมาหลัง login สำเร็จ
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname }}
      />
    );
  }

  return <Outlet />;
}