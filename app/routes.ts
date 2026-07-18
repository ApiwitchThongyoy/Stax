import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/Login.tsx"),
  route("login", "routes/Login.tsx", { id: "login-page" }),
  route("register", "routes/Register.tsx"),
  route("dashboard", "routes/DashboardUser.tsx"), // เพิ่มบรรทัดนี้
] satisfies RouteConfig;