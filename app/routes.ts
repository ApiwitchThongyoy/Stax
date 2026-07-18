import { type RouteConfig, index, route, layout } from "@react-router/dev/routes";

export default [
  index("routes/Login.tsx"),
  route("login", "routes/Login.tsx", { id: "login-page" }),
  route("register", "routes/Register.tsx"),

  // Route ที่ต้อง login ก่อนถึงจะเข้าได้ ทั้งหมดอยู่ใต้นี้
  layout("routes/ProtectedLayout.tsx", [
    route("dashboard", "routes/Dashboard.tsx"),
    // เพิ่ม route หน้าอื่นที่ต้อง login ตรงนี้ได้เลย เช่น:
    // route("accounting", "routes/Accounting.tsx"),
    // route("users", "routes/UsersPage.tsx"),
  ]),
] satisfies RouteConfig;