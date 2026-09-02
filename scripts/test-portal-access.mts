// BUG 4 regressions — ADMIN must not enter the normal USER portal.
//
// Two layers are tested:
//   1. Pure role gate (canUseUserPortal): only "USER" is allowed.
//   2. Static source wiring: the USER login flow + ProtectedLayout both enforce
//      the gate at the frontend, while the admin login page + admin route guard
//      keep the admin portal ADMIN-only in the other direction.
// No DB / no browser needed.
//
// Run:  npx tsx scripts/test-portal-access.mts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canUseUserPortal,
  ADMIN_USER_PORTAL_DENIED_MESSAGE,
  USER_PORTAL_ROLE,
} from "../app/lib/portal-access";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

console.log("\n=== BUG 4: USER-PORTAL ROLE GATE ===\n");

ok(canUseUserPortal("USER") === true, "role USER is allowed into the USER portal");
ok(canUseUserPortal("ADMIN") === false, "role ADMIN is NOT allowed into the USER portal");
ok(canUseUserPortal("SUPERADMIN") === false, "unknown role is NOT allowed");
ok(canUseUserPortal(undefined) === false, "missing role is NOT allowed");
ok(canUseUserPortal(null) === false, "null role is NOT allowed");
ok(USER_PORTAL_ROLE === "USER", "USER_PORTAL_ROLE constant is USER");
ok(
  ADMIN_USER_PORTAL_DENIED_MESSAGE ===
    "บัญชีผู้ดูแลระบบไม่สามารถเข้าสู่ระบบผ่านหน้าผู้ใช้งานทั่วไปได้",
  "admin-denied message matches the required Thai copy"
);

console.log("\n=== BUG 4: FRONTEND SOURCE WIRING ===\n");

const auth = read("app/lib/auth.tsx");
const protectedLayout = read("app/routes/ProtectedLayout.tsx");
const loginPage = read("app/component/Login/Login.tsx");
const adminLogin = read("app/component/Admin/Adminloginpage.tsx");
const adminProtected = read("app/component/Admin/Adminprotected.tsx");

// A. USER login flow must reject ADMIN.
ok(
  auth.includes("canUseUserPortal") &&
    auth.includes("ADMIN_USER_PORTAL_DENIED_MESSAGE") &&
    auth.includes("if (!canUseUserPortal(apiUser.role))"),
  "USER login flow guards the role via canUseUserPortal"
);
ok(
  auth.includes("error: ADMIN_USER_PORTAL_DENIED_MESSAGE"),
  "USER login flow returns the Thai admin-denied message on role rejection"
);
ok(
  auth.includes("clearAllSessions") && auth.includes("setUser(null)"),
  "USER login flow clears any accidental session state on role rejection"
);
ok(
  loginPage.includes("result.success") && loginPage.includes("errorMessage"),
  "Login page surfaces the login rejection instead of navigating to /dashboard"
);

// B. ProtectedLayout must not render the Dashboard for a non-USER session.
ok(
  protectedLayout.includes("canUseUserPortal"),
  "ProtectedLayout enforces the USER-role gate"
);
ok(
  protectedLayout.includes("clearAllSessions") &&
    protectedLayout.includes('navigate("/login"'),
  "ProtectedLayout clears the session and redirects to /login on role mismatch"
);

// C. Admin portal remains ADMIN-only (opposite direction already safe).
ok(
  adminLogin.includes("adminUser.role !== \"ADMIN\""),
  "Admin login page rejects a USER account from the admin portal"
);
ok(
  adminProtected.includes("readAdminSession") &&
    adminProtected.includes("navigate(\"/admin/login\""),
  "Admin route guard redirects non-admin sessions to the admin login"
);

console.log("\n=== BUG 2: SIDEBAR SHELL (viewport-constrained layout) ===\n");

const userDashboard = read("app/component/DashboardUser/Dashboard.tsx");
const adminDashboard = read("app/component/Admin/Admindashboard.tsx");

for (const [name, src] of [
  ["USER Dashboard", userDashboard],
  ["ADMIN Dashboard", adminDashboard],
] as const) {
  ok(
    src.includes("h-screen") && src.includes("overflow-hidden"),
    `${name} root is constrained to viewport height with overflow-hidden`
  );
  ok(
    src.includes("flex-1 min-w-0 flex flex-col overflow-hidden"),
    `${name} main column is h-constrained and does not grow with content`
  );
  ok(
    src.includes('flex-1 overflow-y-auto p-6 space-y-6"'),
    `${name} body scrolls vertically within the constrained shell`
  );
  ok(
    src.includes('shrink-0 flex-col') &&
      src.includes("border-r border-gray-100") &&
      src.includes("flex-1 px-3 py-4") &&
      src.includes("border-t border-gray-100"),
    `${name} sidebar is a non-scrolling flex column with anchored footer/profile`
  );
}

console.log("\n=== BUG 3: ADMIN UI DOES NOT OFFER SUSPEND FOR ADMIN ROWS ===\n");

ok(
  adminDashboard.includes('rawRole: u.role') &&
    adminDashboard.includes('rawRole'),
  "ADMIN dashboard tracks the raw role (not just the display label)"
);
ok(
  /u\.rawRole === "ADMIN"/.test(adminDashboard) &&
    adminDashboard.includes("ผู้ดูแลระบบ"),
  "ADMIN rows render a neutral 'ผู้ดูแลระบบ' label instead of a suspend button"
);
ok(
  adminDashboard.includes('current.rawRole !== "USER"') &&
    /\.map\(\(u\) =>\s+u\.id === id/.test(adminDashboard),
  "ADMIN dashboard guard refuses toggling any non-USER (ADMIN) row"
);

console.log(`\n================ SUMMARY ================`);
console.log(`PASS: ${passed}   FAIL: ${failed}`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
