import { type RouteConfig, index, route, layout } from "@react-router/dev/routes";

export default [
  index("routes/Login.tsx"),
  route("login", "routes/Login.tsx", { id: "login-page" }),
  route("register", "routes/Register.tsx"),

  layout("routes/ProtectedLayout.tsx", [
    route("dashboard", "routes/Dashboard.tsx"),
  ]),

  // ---- เพิ่มใหม่: ฝั่ง admin ----
  route("admin/login", "component/Admin/Adminloginpage.tsx"),
  layout("component/Admin/Adminprotected.tsx", [
    route("admin/dashboard", "component/Admin/Admindashboard.tsx"),
  ]),
] satisfies RouteConfig;