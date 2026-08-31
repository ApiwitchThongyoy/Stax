import { useMemo, useState, useEffect, useCallback } from "react";
import { useLocation } from "react-router";
import {
  LayoutDashboard,
  Users,
  FileSearch,
  Settings,
  HelpCircle,
  Bell,
  LogOut,
  Search,
  ShieldCheck,
  ShieldAlert,
  UploadCloud,
  Wifi,
  WifiOff,
  Clock,
  FileText,
  LogIn,
  Ban,
  CheckCircle2,
  ChevronRight,
  ChevronUp,
  Loader2,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  type TooltipValueType,
} from "recharts";
import StaxLogo from "../Login/StaxLogo";
import { useNavigate } from "react-router";
import { readAdminSession } from "../../lib/admin-auth";
import { clearAdminSession, clearAllSessions, isSuspendedResponse } from "../../lib/session";
import { usePresenceHeartbeat } from "../../lib/usePresenceHeartbeat";
import { useAdminUsersPolling, type AdminUsersApiRow } from "../../lib/useAdminUsersPolling";
import { useTheme } from "../../lib/useTheme";
import ThemeToggle from "../ThemeToggle";

type AdminSection = "overview" | "users" | "audit" | "settings";

type UserStatus = "active" | "suspended";

interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  rawRole: string;
  status: UserStatus;
  joinedAt: string;
  lastSeenAt: string | null;
  lastLoginAt: string | null;
  filesUploaded: number;
}

const ONLINE_WINDOW_MS = 60_000;

function isUserOnline(u: Pick<AdminUserRow, "status" | "lastSeenAt">): boolean {
  if (u.status !== "active") return false;
  if (!u.lastSeenAt) return false;
  const last = new Date(u.lastSeenAt).getTime();
  if (Number.isNaN(last)) return false;
  return Date.now() - last <= ONLINE_WINDOW_MS;
}

interface UploadLogEntry {
  id: string;
  fileName: string;
  uploadedBy: string;
  sizeKb: number;
  status: "สำเร็จ" | "ล้มเหลว" | "กำลังตรวจสอบ";
  uploadedAt: string;
}

interface AccessLogEntry {
  id: string;
  user: string;
  action: string;
  ipAddress: string;
  device: string;
  timestamp: string;
}

interface IntervalUploadStat {
  day: string;
  date: string;
  files: number;
  sizeMb: number;
}

interface AdminStatsPayload {
  userCounts?: { total: number; active: number; suspended: number };
  documents?: {
    total: number;
    last7Days: number;
    perDay?: { date: string; files: number }[];
  };
  uploadStatus?: { available: boolean; reason?: string };
}

const adminNavItems: { id: AdminSection; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "แดชบอร์ดผู้ดูแลระบบ", icon: LayoutDashboard },
  { id: "users", label: "จัดการผู้ใช้งาน", icon: Users },
  { id: "audit", label: "ตรวจสอบเอกสาร & กิจกรรม", icon: FileSearch },
];

const THAI_MONTHS_ABBR = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "ผู้ดูแลระบบ",
  USER: "ผู้ใช้งานทั่วไป",
};

function formatShortDay(date: string): string {
  if (!date) return "";
  const parts = date.split("-").map(Number);
  if (parts.length !== 3 || parts.some((d) => Number.isNaN(d))) return date;
  const [, m, d] = parts;
  return `${d} ${THAI_MONTHS_ABBR[m - 1] ?? ""}`;
}

function displayNameFromEmail(email: string): string {
  const prefix = email.split("@")[0] || "ผู้ใช้งาน";
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

function rowToAdminUserRow(u: AdminUsersApiRow): AdminUserRow {
  return {
    id: u.id,
    name: displayNameFromEmail(u.email),
    email: u.email,
    role: ROLE_LABEL[u.role] ?? u.role,
    rawRole: u.role,
    status: u.status === "SUSPENDED" ? "suspended" : "active",
    joinedAt: "",
    lastSeenAt: u.lastSeenAt ?? null,
    lastLoginAt: u.lastLoginAt ?? null,
    filesUploaded: u.documentCount ?? 0,
  };
}

function uploadStatusBadge(status: UploadLogEntry["status"]) {
  switch (status) {
    case "สำเร็จ":
      return "bg-emerald-50 text-emerald-600";
    case "ล้มเหลว":
      return "bg-red-50 text-red-600";
    case "กำลังตรวจสอบ":
      return "bg-amber-50 text-amber-600";
    default:
      return "bg-gray-50 text-gray-500";
  }
}

function accessActionBadge(action: string) {
  if (action.includes("ล้มเหลว"))
    return { cls: "bg-red-50 text-red-600", Icon: ShieldAlert };
  if (action.includes("ออกจากระบบ"))
    return { cls: "bg-gray-100 text-gray-500", Icon: LogOut };
  if (action.includes("เปลี่ยน"))
    return { cls: "bg-blue-50 text-blue-700", Icon: ShieldCheck };
  if (action.includes("ADMIN_") || action === "LOGIN_SUCCESS")
    return { cls: "bg-emerald-50 text-emerald-600", Icon: LogIn };
  return { cls: "bg-emerald-50 text-emerald-600", Icon: LogIn };
}

// ----- Helpers -----

interface AdminDashboardProps {
  userEmail?: string;
}

export default function AdminDashboard({ userEmail }: AdminDashboardProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();

  const [activeSection, setActiveSection] = useState<AdminSection>("overview");
  const [userSearch, setUserSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | UserStatus>("all");
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [stats, setStats] = useState<AdminStatsPayload | null>(null);
  const [uploadLog, setUploadLog] = useState<UploadLogEntry[]>([]);
  const [accessLog, setAccessLog] = useState<AccessLogEntry[]>([]);
  const [barData, setBarData] = useState<IntervalUploadStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [showAllUploads, setShowAllUploads] = useState(false);
  const [showAllAccessLogs, setShowAllAccessLogs] = useState(false);

  const emailFromLogin = (location.state as { email?: string } | null)?.email;
  const resolvedEmail = userEmail || emailFromLogin || "admin@stax.com";
  const emailPrefix = resolvedEmail.split("@")[0] || "ผู้ดูแลระบบ";
  const displayName = emailPrefix.charAt(0).toUpperCase() + emailPrefix.slice(1);
  const adminSession = readAdminSession();
  const adminToken = adminSession?.accessToken ?? null;

  // ADMIN presence: while the admin dashboard is active, keep this admin's
  // last_seen_at fresh (heartbeat) so THEY show as ONLINE in the user table.
  usePresenceHeartbeat({
    enabled: !!adminToken,
    accessToken: adminToken,
  });

  // Admin user list presence: refresh ONLINE/OFFLINE automatically every 5s
  // without a manual page refresh. Stops on logout/unmount; detects suspension.
  useAdminUsersPolling({
    enabled: !!adminToken,
    accessToken: adminToken,
    onUsers: (rows) => {
      setUsers((prev) => {
        if (prev.length === 0) {
          return rows.map(rowToAdminUserRow);
        }
        const byId = new Map(rows.map((r) => [r.id, r]));
        return prev.map((u) => {
          const fresh = byId.get(u.id);
          if (!fresh) return u;
          return {
            ...u,
            status: fresh.status === "SUSPENDED" ? "suspended" : "active",
            lastSeenAt: fresh.lastSeenAt ?? null,
            lastLoginAt: fresh.lastLoginAt ?? null,
          };
        });
      });
    },
    onSuspended: () => {
      clearAdminSession();
      navigate("/admin/login", {
        replace: true,
        state: { suspended: true },
      });
    },
  });

  const handleLogout = () => {
    clearAllSessions();
    navigate("/admin/login", { replace: true });
  };

  const loadData = useCallback(async () => {
    const session = readAdminSession();
    if (!session?.accessToken) {
      setLoadError("ไม่พบ session ผู้ดูแลระบบ กรุณาเข้าสู่ระบบใหม่");
      setLoading(false);
      return;
    }
    const token = session.accessToken;
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const [userRes, statsRes, docRes, auditRes] = await Promise.all([
        fetch("/api/v1/admin/users", { headers }),
        fetch("/api/v1/admin/stats", { headers }),
        fetch("/api/v1/admin/documents", { headers }),
        fetch("/api/v1/admin/audit-logs?limit=100", { headers }),
      ]);

      for (const res of [userRes, statsRes, docRes, auditRes]) {
        if (await isSuspendedResponse(res)) {
          clearAdminSession();
          navigate("/admin/login", {
            replace: true,
            state: { suspended: true },
          });
          setLoading(false);
          return;
        }
      }

      const userJson = await userRes.json().catch(() => null);
      const statsJson = await statsRes.json().catch(() => null);
      const docJson = await docRes.json().catch(() => null);
      const auditJson = await auditRes.json().catch(() => null);

      const apiUsers = (userJson?.data ?? []) as {
        id: string;
        email: string;
        role: string;
        status: string;
        documentCount?: number;
        lastSeenAt?: string | null;
        lastLoginAt?: string | null;
      }[];

      void setUsers(
        apiUsers.map((u) => ({
          id: u.id,
          name: displayNameFromEmail(u.email),
          email: u.email,
          role: ROLE_LABEL[u.role] ?? u.role,
          rawRole: u.role,
          status: u.status === "SUSPENDED" ? "suspended" : "active",
          joinedAt: "",
          lastSeenAt: u.lastSeenAt ?? null,
          lastLoginAt: u.lastLoginAt ?? null,
          filesUploaded: u.documentCount ?? 0,
        }))
      );

      void setStats(statsJson?.data ?? null);

      const apiDocs = (docJson?.data ?? []) as {
        id: string;
        originalName: string;
        fileSize: number;
        createdAt: string;
        userEmail: string;
      }[];
      // documents table has no status field -> every upload is shown as "สำเร็จ" (stored on disk)
      void setUploadLog(
        apiDocs.map((d) => ({
          id: d.id,
          fileName: d.originalName,
          uploadedBy: d.userEmail || "ไม่ทราบ",
          sizeKb: Math.round(d.fileSize / 1024),
          status: "สำเร็จ" as const,
          uploadedAt: d.createdAt,
        }))
      );

      const apiAudit = (auditJson?.data ?? []) as {
        id: string;
        action: string;
        entityType: string | null;
        entityId: string | null;
        details: Record<string, unknown> | null;
        createdAt: string;
        userEmail: string | null;
      }[];
      void setAccessLog(
        apiAudit.map((a) => ({
          id: a.id,
          user: a.userEmail || "—",
          action: String(a.action ?? ""),
          ipAddress: "",
          device:
            a.entityType || a.entityId
              ? `${a.entityType ?? ""}${a.entityId ? ` · ${a.entityId}` : ""}`
              : "",
          timestamp: a.createdAt,
        }))
      );

      const perDay = (statsJson?.data?.documents?.perDay ?? []) as {
        date: string;
        files: number;
      }[];
      void setBarData(
        perDay.map((d) => ({
          day: formatShortDay(d.date),
          date: d.date,
          files: d.files,
          sizeMb: 0,
        }))
      );

      setLoading(false);
    } catch {
      setLoadError("ไม่สามารถโหลดข้อมูลจากเซิร์ฟเวอร์ได้ กรุณาลองใหม่ภายหลัง");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const toggleUserStatus = async (id: string) => {
    const session = readAdminSession();
    if (!session?.accessToken) return;
    const current = users.find((u) => u.id === id);
    if (!current) return;
    const nextStatus = current.status === "active" ? "SUSPENDED" : "ACTIVE";
    // Only role USER accounts may be suspended/reactivated. The backend enforces
    // this authoritatively; this guard is extra safety so an ADMIN row can never
    // be toggled from the UI even if a stale button were somehow invoked.
    if (current.rawRole !== "USER") return;

    setTogglingId(id);
    try {
      const res = await fetch(`/api/v1/admin/users/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (res.ok) {
        setUsers((prev) =>
          prev.map((u) =>
            u.id === id
              ? { ...u, status: nextStatus === "SUSPENDED" ? "suspended" : "active" }
              : u
          )
        );
        loadData();
      }
    } finally {
      setTogglingId(null);
    }
  };

  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      const matchesSearch =
        userSearch.trim() === "" ||
        (u.name && u.name.toLowerCase().includes(userSearch.toLowerCase())) ||
        (u.email && u.email.toLowerCase().includes(userSearch.toLowerCase()));
      const matchesStatus = statusFilter === "all" || u.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [users, userSearch, statusFilter]);

  const totalUsers = stats?.userCounts?.total ?? users.length;
  const activeUsers = stats?.userCounts?.active ?? 0;
  const suspendedUsers = stats?.userCounts?.suspended ?? 0;
  const totalUploadsThisWeek = stats?.documents?.last7Days ?? uploadLog.length;
  const failedUploads: number | null = null;
  const connectedApis: number | null = null;
  const apiTotal: number | null = null;

  const visibleUploads = showAllUploads ? uploadLog : uploadLog.slice(0, 4);
  const visibleAccessLogs = showAllAccessLogs ? accessLog : accessLog.slice(0, 4);

  const uploadStatusBreakdown: { name: string; value: number }[] = [];

  const totalFilesThisPeriod = barData.reduce((sum, d) => sum + d.files, 0);

  const sectionTitle: Record<AdminSection, { heading: string; sub: string }> = {
    overview: {
      heading: "ภาพรวมระบบ",
      sub: "สรุปสถิติผู้ใช้งาน ปริมาณการอัปโหลด และสถานะการเชื่อมต่อ API ภายนอกแบบเรียลไทม์",
    },
    users: {
      heading: "จัดการผู้ใช้งาน",
      sub: "ค้นหา ตรวจสอบรายชื่อ และเปิด-ปิดการใช้งานบัญชีผู้ใช้ทั่วไป",
    },
    audit: {
      heading: "ตรวจสอบเอกสารและกิจกรรม",
      sub: "ติดตามประวัติการอัปโหลดไฟล์และประวัติการเข้าใช้งานเพื่อความปลอดภัยของระบบ",
    },
    settings: {
      heading: "ตั้งค่าระบบ",
      sub: "จัดการบัญชีผู้ดูแลระบบและดูคู่มือการใช้งาน",
    },
  };

  return (
    <div
      className={`h-screen w-full bg-gray-50 flex overflow-hidden ${
        theme === "dark" ? "dark" : ""
      }`}
    >
      {/* Sidebar */}
      <aside className="hidden md:flex w-64 shrink-0 flex-col bg-white border-r border-gray-100">
        <div className="flex items-center gap-2.5 px-5 py-5 border-b border-gray-100">
          <div className="w-8 h-8 shrink-0">
            <StaxLogo width="32px" transparent compact />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-800 leading-none">STAX</p>
            <p className="text-[10px] text-gray-400 mt-0.5">แผงควบคุมผู้ดูแลระบบ</p>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {adminNavItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveSection(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                activeSection === item.id
                  ? "bg-blue-900 text-white"
                  : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="px-3 py-4 border-t border-gray-100 space-y-1">
          <button
            type="button"
            onClick={() => setActiveSection("settings")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
              activeSection === "settings"
                ? "bg-blue-900 text-white"
                : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            <Settings className="w-4 h-4" />
            ตั้งค่าระบบ
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition"
          >
            <HelpCircle className="w-4 h-4" />
            ความช่วยเหลือ
          </button>

          <div className="flex items-center gap-2.5 px-3 pt-3 mt-2 border-t border-gray-100">
            <div className="w-8 h-8 rounded-full bg-blue-900 flex items-center justify-center text-white text-xs font-semibold shrink-0">
              {displayName.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-gray-800 truncate">{displayName}</p>
              <p className="text-[11px] text-gray-400 truncate">{resolvedEmail}</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center justify-between px-6 py-4 bg-white border-b border-gray-100">
          <div>
            <h1 className="text-base font-semibold text-gray-800">
              {sectionTitle[activeSection].heading}
            </h1>
            <p className="text-xs text-gray-400 mt-0.5">{sectionTitle[activeSection].sub}</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              className="w-9 h-9 rounded-lg flex items-center justify-center text-gray-400 hover:bg-gray-50 transition"
              aria-label="การแจ้งเตือน"
            >
              <Bell className="w-4 h-4" />
            </button>
            <button
              type="button"
              className="w-9 h-9 rounded-lg flex items-center justify-center text-gray-400 hover:bg-gray-50 transition"
              aria-label="ตั้งค่า"
            >
              <Settings className="w-4 h-4" />
            </button>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
        </header>

        {/* Scrollable body */}
        <main className="flex-1 overflow-y-auto p-6 space-y-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-24">
              <Loader2 className="w-6 h-6 animate-spin text-blue-900" />
              <p className="text-sm text-gray-500 mt-3">กำลังโหลดข้อมูล...</p>
            </div>
          ) : loadError ? (
            <div className="bg-white rounded-xl border border-gray-100 p-6 text-center">
              <p className="text-sm font-medium text-red-600">{loadError}</p>
              <button
                type="button"
                onClick={() => {
                  setLoadError("");
                  setLoading(true);
                  loadData();
                }}
                className="mt-4 text-xs text-blue-900 font-medium underline"
              >
                ลองอีกครั้ง
              </button>
            </div>
          ) : (
          <>
          {activeSection === "overview" && (
            <>
              {/* Stat cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-white rounded-xl border border-gray-100 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-gray-400">ผู้ใช้งานทั้งหมด</span>
                    <Users className="w-4 h-4 text-gray-300" />
                  </div>
                  <p className="text-xl font-semibold text-gray-800">{totalUsers}</p>
                  <p className="text-[11px] text-gray-400 mt-3">
                    <span className="text-emerald-500 font-medium">{activeUsers} ใช้งานอยู่</span>
                    {"  ·  "}
                    <span className="text-red-500 font-medium">{suspendedUsers} ถูกระงับ</span>
                  </p>
                </div>

                <div className="bg-white rounded-xl border border-gray-100 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-gray-400">ไฟล์ที่อัปโหลด (7 วันล่าสุด)</span>
                    <UploadCloud className="w-4 h-4 text-gray-300" />
                  </div>
                  <p className="text-xl font-semibold text-gray-800">{totalUploadsThisWeek}</p>
                  <p className="text-[11px] text-gray-400 mt-3">
                    <span className="text-gray-400">สถานะการตรวจสอบ: NOT AVAILABLE</span>
                  </p>
                </div>

                <div className="bg-white rounded-xl border border-gray-100 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-gray-400">สถานะ API ภายนอก</span>
                    <Wifi className="w-4 h-4 text-gray-300" />
                  </div>
                  <p className="text-xl font-semibold text-gray-800">
                    {connectedApis === null || apiTotal === null ? "NOT AVAILABLE" : `${connectedApis}/${apiTotal} เชื่อมต่อปกติ`}
                  </p>
                  <p className="text-[11px] text-gray-400 mt-3">
                    BOT API ยังไม่ได้เชื่อมต่อกับ backend
                  </p>
                </div>
              </div>

              {/* Charts: upload volume trend + status breakdown */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2 bg-white rounded-xl border border-gray-100 p-5">
                  <div className="flex items-center justify-between mb-1">
                    <h2 className="text-sm font-semibold text-gray-800">
                      ปริมาณการอัปโหลดไฟล์รายวัน
                    </h2>
                    <span className="text-xs text-gray-400">
                      รวม {totalFilesThisPeriod} ไฟล์ · 7 วันล่าสุด
                    </span>
                  </div>
                  <div className="h-64 mt-3">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={barData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                        <XAxis
                          dataKey="day"
                          tick={{ fontSize: 11, fill: "#9ca3af" }}
                          axisLine={{ stroke: "#e5e7eb" }}
                          tickLine={false}
                        />
                        <YAxis
                          allowDecimals={false}
                          tick={{ fontSize: 11, fill: "#9ca3af" }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          cursor={{ fill: "#f9fafb" }}
                          contentStyle={{
                            borderRadius: 8,
                            border: "1px solid #e5e7eb",
                            fontSize: 12,
                          }}
                          formatter={(value: TooltipValueType | undefined, name) =>
                            name === "files" ? [`${String(value)} ไฟล์`, "จำนวนไฟล์"] : [`${String(value)} MB`, "ขนาดรวม"]
                          }
                          labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ""}
                        />
                        <Bar dataKey="files" fill="#1e3a8a" radius={[4, 4, 0, 0]} maxBarSize={28} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="bg-white rounded-xl border border-gray-100 p-5">
                  <h2 className="text-sm font-semibold text-gray-800 mb-1">
                    สถานะไฟล์ที่อัปโหลด
                  </h2>
                  <p className="text-xs text-gray-400 mb-2">แบ่งตามผลการตรวจสอบล่าสุด</p>
                  <div className="h-52 flex flex-col items-center justify-center">
                    <div className="flex items-center gap-2 text-sm text-gray-400">
                      <WifiOff className="w-4 h-4" />
                      <span>NOT AVAILABLE</span>
                    </div>
                    <p className="text-[11px] text-gray-400 mt-2 text-center max-w-[220px]">
                      ตาราง documents ไม่มีฟิลด์สถานะการตรวจสอบไฟล์
                    </p>
                  </div>
                </div>
              </div>

              {/* API connections list */}
              <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                  <h2 className="text-sm font-semibold text-gray-800">การเชื่อมต่อ API ภายนอก</h2>
                </div>
                <div className="px-5 py-8 flex flex-col items-center justify-center text-center">
                  <WifiOff className="w-7 h-7 text-gray-300 mb-2" />
                  <p className="text-sm font-medium text-gray-600">NOT AVAILABLE</p>
                  <p className="text-xs text-gray-400 mt-1 max-w-[320px]">
                    การเชื่อมต่อ API ภายนอก (BOT API, Tax Engine ฯลฯ) ยังไม่ถูกนำมาเชื่อมต่อกับ backend
                  </p>
                </div>
              </div>
            </>
          )}

          {activeSection === "users" && (
            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-4 border-b border-gray-100">
                <h2 className="text-sm font-semibold text-gray-800">รายชื่อผู้ใช้งาน</h2>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-gray-300 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={userSearch}
                      onChange={(e) => setUserSearch(e.target.value)}
                      placeholder="ค้นหาชื่อหรืออีเมล"
                      className="pl-8 pr-3 py-2 text-xs rounded-lg border border-gray-200 focus:outline-none focus:border-blue-900 text-gray-700 w-48"
                    />
                  </div>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as "all" | UserStatus)}
                    className="text-xs rounded-lg border border-gray-200 px-2.5 py-2 text-gray-600 focus:outline-none focus:border-blue-900"
                  >
                    <option value="all">ทุกสถานะ</option>
                    <option value="active">ใช้งานอยู่</option>
                    <option value="suspended">ถูกระงับ</option>
                  </select>
                </div>
              </div>

              {filteredUsers.length === 0 ? (
                <div className="px-5 py-12 text-center">
                  <Users className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                  <p className="text-sm font-medium text-gray-600">ไม่พบผู้ใช้งานที่ตรงกับเงื่อนไข</p>
                  <p className="text-xs text-gray-400 mt-1">ลองเปลี่ยนคำค้นหาหรือตัวกรองสถานะ</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                        <th className="px-5 py-3 font-medium">ผู้ใช้งาน</th>
                        <th className="px-5 py-3 font-medium">บทบาท</th>
                        <th className="px-5 py-3 font-medium">เข้าร่วมเมื่อ</th>
                        <th className="px-5 py-3 font-medium">สถานะการออนไลน์</th>
                        <th className="px-5 py-3 font-medium">ไฟล์ที่อัปโหลด</th>
                        <th className="px-5 py-3 font-medium">สถานะบัญชี</th>
                        <th className="px-5 py-3 font-medium text-right">จัดการ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredUsers.map((u) => (
                        <tr
                          key={u.id}
                          className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60 transition"
                        >
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-2.5">
                              <div className="w-7 h-7 rounded-full bg-blue-50 text-blue-900 text-xs font-semibold flex items-center justify-center shrink-0">
                                {u.name.charAt(0)}
                              </div>
                              <div className="min-w-0">
                                <p className="text-gray-800 font-medium truncate">{u.name}</p>
                                <p className="text-xs text-gray-400 truncate">{u.email}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-3.5 text-gray-500 whitespace-nowrap">{u.role}</td>
                          <td className="px-5 py-3.5 text-gray-400 whitespace-nowrap text-xs">NOT AVAILABLE</td>
                          <td className="px-5 py-3.5 whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              <span
                                className={`inline-block w-2 h-2 rounded-full ${
                                  isUserOnline(u)
                                    ? "bg-emerald-500"
                                    : "bg-gray-300"
                                }`}
                              />
                              <span
                                className={`text-xs font-medium ${
                                  isUserOnline(u)
                                    ? "text-emerald-600"
                                    : "text-gray-400"
                                }`}
                              >
                                {isUserOnline(u) ? "ออนไลน์" : "ออฟไลน์"}
                              </span>
                            </div>
                            {u.lastSeenAt && (
                              <div className="text-[11px] text-gray-400 mt-1">
                                เห็นล่าสุด{" "}
                                {new Date(u.lastSeenAt).toLocaleTimeString("th-TH", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </div>
                            )}
                          </td>
                          <td className="px-5 py-3.5 text-gray-500">{u.filesUploaded}</td>
                          <td className="px-5 py-3.5">
                            <span
                              className={`text-xs font-medium px-2 py-1 rounded-md ${
                                u.status === "active"
                                  ? "bg-emerald-50 text-emerald-600"
                                  : "bg-red-50 text-red-600"
                              }`}
                            >
                              {u.status === "active" ? "เปิดใช้งาน" : "ถูกระงับ"}
                            </span>
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center justify-end">
                              {u.rawRole === "ADMIN" ? (
                                <span
                                  className="inline-flex items-center gap-1.5 text-[11px] text-gray-400 font-medium px-2.5 py-1.5 rounded-lg cursor-default"
                                  title="ไม่สามารถระงับหรือเปิดใช้งานบัญชีผู้ดูแลระบบได้"
                                >
                                  <ShieldCheck className="w-3.5 h-3.5" />
                                  ผู้ดูแลระบบ
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => toggleUserStatus(u.id)}
                                  disabled={togglingId === u.id}
                                  className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border transition disabled:opacity-50 ${
                                    u.status === "active"
                                      ? "border-red-100 text-red-600 hover:bg-red-50"
                                      : "border-emerald-100 text-emerald-600 hover:bg-emerald-50"
                                  }`}
                                >
                                {togglingId === u.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : u.status === "active" ? (
                                  <>
                                    <Ban className="w-3.5 h-3.5" />
                                    ระงับบัญชี
                                  </>
                                ) : (
                                  <>
                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                    เปิดใช้งาน
                                  </>
                                )}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeSection === "audit" && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Upload history */}
              <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                  <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-gray-400" />
                    ประวัติการอัปโหลดไฟล์
                  </h2>
                </div>
                <div className="divide-y divide-gray-50">
                  {visibleUploads.map((entry) => (
                    <div key={entry.id} className="px-5 py-3.5 hover:bg-gray-50/60 transition">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-800 truncate">{entry.fileName}</p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            โดย {entry.uploadedBy} · {entry.sizeKb.toLocaleString()} KB
                          </p>
                        </div>
                        <span
                          className={`text-xs font-medium px-2 py-1 rounded-md shrink-0 ${uploadStatusBadge(
                            entry.status
                          )}`}
                        >
                          {entry.status}
                        </span>
                      </div>
                      <p className="text-[11px] text-gray-400 mt-1.5 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {entry.uploadedAt}
                      </p>
                    </div>
                  ))}
                </div>
                {uploadLog.length > 4 && (
                  <div className="px-5 py-3 text-center border-t border-gray-100">
                    <button
                      type="button"
                      onClick={() => setShowAllUploads((p) => !p)}
                      className="inline-flex items-center gap-1 text-xs text-blue-800 font-medium hover:underline"
                    >
                      {showAllUploads ? "ย่อรายการ" : "ดูประวัติทั้งหมด"}
                      {showAllUploads ? (
                        <ChevronUp className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                )}
              </div>

              {/* Access log */}
              <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                  <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-gray-400" />
                    ประวัติการเข้าใช้งานระบบ
                  </h2>
                </div>
                <div className="divide-y divide-gray-50">
                  {visibleAccessLogs.map((entry) => {
                    const badge = accessActionBadge(entry.action);
                    return (
                      <div key={entry.id} className="px-5 py-3.5 hover:bg-gray-50/60 transition">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">{entry.user}</p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {entry.device} · {entry.ipAddress}
                            </p>
                          </div>
                          <span
                            className={`flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-md shrink-0 ${badge.cls}`}
                          >
                            <badge.Icon className="w-3.5 h-3.5" />
                            {entry.action}
                          </span>
                        </div>
                        <p className="text-[11px] text-gray-400 mt-1.5 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {entry.timestamp}
                        </p>
                      </div>
                    );
                  })}
                </div>
                {accessLog.length > 4 && (
                  <div className="px-5 py-3 text-center border-t border-gray-100">
                    <button
                      type="button"
                      onClick={() => setShowAllAccessLogs((p) => !p)}
                      className="inline-flex items-center gap-1 text-xs text-blue-800 font-medium hover:underline"
                    >
                      {showAllAccessLogs ? "ย่อรายการ" : "ดูประวัติทั้งหมด"}
                      {showAllAccessLogs ? (
                        <ChevronUp className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeSection === "settings" && (
            <div className="space-y-6">
              <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-100">
                  <h2 className="text-sm font-semibold text-gray-800">
                    บัญชีผู้ดูแลระบบ
                  </h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    จัดการเซสชันผู้ดูแลระบบของคุณ
                  </p>
                </div>
                <div className="px-5 py-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-9 h-9 rounded-full bg-blue-900 flex items-center justify-center text-white text-xs font-semibold shrink-0">
                        {displayName.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">
                          {displayName}
                        </p>
                        <p className="text-xs text-gray-400 truncate">
                          {resolvedEmail}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="flex items-center gap-1.5 text-sm font-medium text-red-600 hover:text-red-700 transition px-2 py-1.5 rounded-lg hover:bg-red-50/60 shrink-0"
                    >
                      <LogOut className="w-4 h-4" />
                      ออกจากระบบ
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 mt-3">
                    การออกจากระบบจะสิ้นสุดเซสชันและนำคุณกลับไปยังหน้าเข้าสู่ระบบผู้ดูแลระบบ
                  </p>
                </div>
              </div>

              <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-100">
                  <h2 className="text-sm font-semibold text-gray-800">
                    คู่มือการใช้งานสำหรับผู้ดูแลระบบ
                  </h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    ภาพรวมฟีเจอร์หลักของระบบ
                  </p>
                </div>
                <div className="divide-y divide-gray-50">
                  <div className="flex items-start gap-3 px-5 py-4">
                    <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                      <Users className="w-4 h-4 text-blue-800" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800">
                        จัดการผู้ใช้งาน
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        ไปที่เมนู "จัดการผู้ใช้งาน" เพื่อค้นหา ตรวจสอบ
                        และเปิด-ปิดการใช้งานบัญชีผู้ใช้ทั่วไป
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 px-5 py-4">
                    <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                      <FileSearch className="w-4 h-4 text-blue-800" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800">
                        ตรวจสอบเอกสารและกิจกรรม
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        ไปที่เมนู "ตรวจสอบเอกสาร & กิจกรรม"
                        เพื่อติดตามประวัติการอัปโหลดไฟล์และการเข้าใช้งานระบบ
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 px-5 py-4">
                    <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                      <ShieldCheck className="w-4 h-4 text-blue-800" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800">
                        สลับธีมสว่าง/มืด
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        ใช้ปุ่มพระจันทร์/พระอาทิตย์ที่มุมขวาบนเพื่อสลับธีม
                        โดยใช้การตั้งค่าเดียวกันกับฝั่งผู้ใช้งาน
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
          </>
          )}

          {/* Footer */}
          <div className="text-center text-xs text-gray-400 pt-4 space-y-1">
            <p>© 2026 STAX Financial Management. All Rights Reserved.</p>
          </div>
        </main>
      </div>
    </div>
  );
}