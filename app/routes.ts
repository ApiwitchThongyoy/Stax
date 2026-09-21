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
  route("api/v1/cash-summary", "routes/api/cash-summary.ts"),

  route("api/v1/corporate-actions", "routes/api/corporate-actions.ts"),
  route("api/v1/corporate-actions/:id", "routes/api/corporate-actions.$id.ts"),

  route("api/v1/accounts", "routes/api/accounts.ts"),
  route("api/v1/journal", "routes/api/journal.ts"),
  route("api/v1/journal/:id", "routes/api/journal.$id.ts"),
  route("api/v1/journal/:id/reverse", "routes/api/journal.$id.reverse.ts"),
  route("api/v1/ledger/accounts/:accountId", "routes/api/ledger.$accountId.ts"),
  route("api/v1/ledger/accounts/summary", "routes/api/ledger.accounts.summary.ts"),
  route("api/v1/ledger/summary", "routes/api/ledger.summary.ts"),
  route("api/v1/cost-basis", "routes/api/cost-basis.ts"),
  route("api/v1/portfolio/:symbol", "routes/api/portfolio.$symbol.ts"),
  route("api/v1/trading-journal", "routes/api/trading-journal.ts"),
  route(
    "api/v1/trading-journal/:transactionId/note",
    "routes/api/trading-journal.$transactionId.note.ts"
  ),

  route("api/v1/stock-prices", "routes/api/stock-prices.ts"),
  route("api/v1/stock-prices/refresh", "routes/api/stock-prices/refresh.ts"),
  route("api/v1/reports/trial-balance", "routes/api/reports/trial-balance.ts"),
  route("api/v1/reports/income-statement", "routes/api/reports/income-statement.ts"),
  route("api/v1/reports/balance-sheet", "routes/api/reports/balance-sheet.ts"),
  route("api/v1/reports/monthly-closing", "routes/api/reports/monthly-closing.ts"),

  route("api/v1/statements/upload", "routes/api/statements/upload.ts"),
  route("api/v1/statements/preview", "routes/api/statements/preview.ts"),

  route("api/v1/documents", "routes/api/documents.ts"),
  route("api/v1/documents/:id", "routes/api/documents.$id.ts"),
  route(
    "api/v1/documents/:id/download",
    "routes/api/documents.$id.download.ts"
  ),
  route(
    "api/v1/documents/:id/transactions",
    "routes/api/documents.$id.transactions.ts"
  ),

  route("api/v1/exchange-rates", "routes/api/exchange-rates.ts"),
  route("api/v1/exchange-rates/status", "routes/api/exchange-rates/status.ts"),

  route("api/v1/admin/users", "routes/api/admin/users.ts"),
  route("api/v1/admin/users/:id", "routes/api/admin/users.$id.ts"),
  route("api/v1/admin/stats", "routes/api/admin/stats.ts"),
  route("api/v1/admin/audit-logs", "routes/api/admin/audit-logs.ts"),
  route("api/v1/admin/documents", "routes/api/admin/documents.ts"),
] satisfies RouteConfig;