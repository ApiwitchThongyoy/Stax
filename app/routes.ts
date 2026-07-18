import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/Login.tsx"),
  route("login", "routes/Login.tsx", { id: "login-page" }), // ใส่ id กันชนกับ index
  route("register", "routes/Register.tsx"),
] satisfies RouteConfig;