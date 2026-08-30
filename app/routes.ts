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

  route("api/v1/auth/login", "routes/api/auth/login.ts"),
  route("api/v1/auth/register", "routes/api/auth/register.ts"),
  route("api/v1/auth/session", "routes/api/auth/session.ts"),
  route("api/v1/auth/heartbeat", "routes/api/auth/heartbeat.ts"),

  route("api/v1/settings", "routes/api/settings.ts"),

  route("api/v1/notifications", "routes/api/notifications.ts"),
  route("api/v1/notifications/:id/read", "routes/api/notifications.$id.read.ts"),

  route("api/v1/capital-ledgers", "routes/api/capital-ledgers.ts"),
  route("api/v1/capital-ledgers/:id", "routes/api/capital-ledgers.$id.ts"),

  route("api/v1/statements/upload", "routes/api/statements/upload.ts"),

  route("api/v1/admin/users", "routes/api/admin/users.ts"),
  route("api/v1/admin/users/:id", "routes/api/admin/users.$id.ts"),
  route("api/v1/admin/stats", "routes/api/admin/stats.ts"),
  route("api/v1/admin/audit-logs", "routes/api/admin/audit-logs.ts"),
  route("api/v1/admin/documents", "routes/api/admin/documents.ts"),
] satisfies RouteConfig;