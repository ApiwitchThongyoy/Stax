import { useMemo, useState } from "react";
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
} from "lucide-react";
import StaxLogo from "../Login/StaxLogo";
import { useNavigate } from "react-router";

type AdminSection = "overview" | "users" | "audit";

type UserStatus = "active" | "suspended";

interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  role: "ผู้ใช้งานทั่วไป" | "นักบัญชี" | "ผู้ดูแลระบบ";
  status: UserStatus;
  joinedAt: string; // yyyy-mm-dd
  lastActive: string; // human readable
  filesUploaded: number;
}

interface ApiConnectionStatus {
  id: string;
  name: string;
  description: string;
  status: "connected" | "degraded" | "down";
  latencyMs: number | null;
  lastChecked: string;
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
  action: "เข้าสู่ระบบ" | "ออกจากระบบ" | "เข้าสู่ระบบล้มเหลว" | "เปลี่ยนรหัสผ่าน";
  ipAddress: string;
  device: string;
  timestamp: string;
}

// ----- Mock data (แทนที่ด้วยข้อมูลจริงจาก API เมื่อเชื่อมต่อ) -----

const adminNavItems: { id: AdminSection; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "แดชบอร์ด", icon: LayoutDashboard },
  { id: "users", label: "จัดการผู้ใช้งาน", icon: Users },
  { id: "audit", label: "ตรวจสอบเอกสาร & กิจกรรม", icon: FileSearch },
];

const mockUsers: AdminUserRow[] = [
  {
    id: "u-1042",
    name: "ณัฐวุฒิ ศรีสมบูรณ์",
    email: "nattawut@stax.com",
    role: "นักบัญชี",
    status: "active",
    joinedAt: "2025-11-02",
    lastActive: "5 นาทีที่แล้ว",
    filesUploaded: 34,
  },
  {
    id: "u-1043",
    name: "ปวีณา จันทร์เพ็ญ",
    email: "paweena@stax.com",
    role: "ผู้ใช้งานทั่วไป",
    status: "active",
    joinedAt: "2025-12-14",
    lastActive: "2 ชั่วโมงที่แล้ว",
    filesUploaded: 11,
  },
  {
    id: "u-1044",
    name: "ธีรพงษ์ วงศ์สวัสดิ์",
    email: "teerapong@stax.com",
    role: "ผู้ใช้งานทั่วไป",
    status: "suspended",
    joinedAt: "2026-01-20",
    lastActive: "6 วันที่แล้ว",
    filesUploaded: 3,
  },
  {
    id: "u-1045",
    name: "กมลชนก อินทร์แก้ว",
    email: "kamonchanok@stax.com",
    role: "ผู้ดูแลระบบ",
    status: "active",
    joinedAt: "2025-08-09",
    lastActive: "ออนไลน์อยู่",
    filesUploaded: 58,
  },
  {
    id: "u-1046",
    name: "สุรชัย เพชรรัตน์",
    email: "surachai@stax.com",
    role: "ผู้ใช้งานทั่วไป",
    status: "active",
    joinedAt: "2026-03-02",
    lastActive: "1 วันที่แล้ว",
    filesUploaded: 7,
  },
];

const mockApiConnections: ApiConnectionStatus[] = [
  {
    id: "bot-fx",
    name: "BOT API — อัตราแลกเปลี่ยน",
    description: "ดึงอัตราแลกเปลี่ยนเรียลไทม์จากธนาคารแห่งประเทศไทย",
    status: "connected",
    latencyMs: 118,
    lastChecked: "1 นาทีที่แล้ว",
  },
  {
    id: "pdf-parser",
    name: "PDF Statement Parser",
    description: "บริการแยกวิเคราะห์ไฟล์ statement ที่ผู้ใช้อัปโหลด",
    status: "connected",
    latencyMs: 342,
    lastChecked: "1 นาทีที่แล้ว",
  },
  {
    id: "tax-engine",
    name: "Tax Estimation Engine",
    description: "คำนวณประมาณการภาษีจากรายการธุรกรรม",
    status: "degraded",
    latencyMs: 1840,
    lastChecked: "3 นาทีที่แล้ว",
  },
  {
    id: "notify",
    name: "Notification Service",
    description: "ส่งอีเมลและการแจ้งเตือนในระบบ",
    status: "down",
    latencyMs: null,
    lastChecked: "8 นาทีที่แล้ว",
  },
];

const mockUploadLog: UploadLogEntry[] = [
  { id: "up-1", fileName: "statement_march_2026.pdf", uploadedBy: "ณัฐวุฒิ ศรีสมบูรณ์", sizeKb: 842, status: "สำเร็จ", uploadedAt: "2026-08-01 09:12" },
  { id: "up-2", fileName: "statement_hk_broker.pdf", uploadedBy: "กมลชนก อินทร์แก้ว", sizeKb: 1204, status: "สำเร็จ", uploadedAt: "2026-08-01 08:47" },
  { id: "up-3", fileName: "dividend_report_q2.pdf", uploadedBy: "ปวีณา จันทร์เพ็ญ", sizeKb: 96, status: "กำลังตรวจสอบ", uploadedAt: "2026-08-01 08:20" },
  { id: "up-4", fileName: "statement_corrupted.pdf", uploadedBy: "ธีรพงษ์ วงศ์สวัสดิ์", sizeKb: 12, status: "ล้มเหลว", uploadedAt: "2026-07-31 22:05" },
  { id: "up-5", fileName: "statement_july_2026.pdf", uploadedBy: "สุรชัย เพชรรัตน์", sizeKb: 655, status: "สำเร็จ", uploadedAt: "2026-07-31 17:33" },
];

const mockAccessLog: AccessLogEntry[] = [
  { id: "log-1", user: "ณัฐวุฒิ ศรีสมบูรณ์", action: "เข้าสู่ระบบ", ipAddress: "203.150.12.4", device: "Chrome · Windows", timestamp: "2026-08-01 09:10" },
  { id: "log-2", user: "ธีรพงษ์ วงศ์สวัสดิ์", action: "เข้าสู่ระบบล้มเหลว", ipAddress: "171.4.88.201", device: "Safari · iPhone", timestamp: "2026-08-01 07:58" },
  { id: "log-3", user: "กมลชนก อินทร์แก้ว", action: "เปลี่ยนรหัสผ่าน", ipAddress: "203.150.12.4", device: "Chrome · macOS", timestamp: "2026-07-31 21:40" },
  { id: "log-4", user: "ปวีณา จันทร์เพ็ญ", action: "ออกจากระบบ", ipAddress: "49.230.14.77", device: "Edge · Windows", timestamp: "2026-07-31 19:02" },
  { id: "log-5", user: "สุรชัย เพชรรัตน์", action: "เข้าสู่ระบบ", ipAddress: "184.22.6.19", device: "Chrome · Android", timestamp: "2026-07-31 17:31" },
];

// ----- Helpers -----

function apiStatusBadge(status: ApiConnectionStatus["status"]) {
  switch (status) {
    case "connected":
      return { label: "เชื่อมต่อปกติ", cls: "bg-emerald-50 text-emerald-600", Icon: Wifi };
    case "degraded":
      return { label: "ล่าช้าผิดปกติ", cls: "bg-amber-50 text-amber-600", Icon: Wifi };
    case "down":
      return { label: "ขาดการเชื่อมต่อ", cls: "bg-red-50 text-red-600", Icon: WifiOff };
  }
}

function uploadStatusBadge(status: UploadLogEntry["status"]) {
  switch (status) {
    case "สำเร็จ":
      return "bg-emerald-50 text-emerald-600";
    case "ล้มเหลว":
      return "bg-red-50 text-red-600";
    case "กำลังตรวจสอบ":
      return "bg-amber-50 text-amber-600";
  }
}

function accessActionBadge(action: AccessLogEntry["action"]) {
  switch (action) {
    case "เข้าสู่ระบบ":
      return { cls: "bg-emerald-50 text-emerald-600", Icon: LogIn };
    case "ออกจากระบบ":
      return { cls: "bg-gray-100 text-gray-500", Icon: LogOut };
    case "เข้าสู่ระบบล้มเหลว":
      return { cls: "bg-red-50 text-red-600", Icon: ShieldAlert };
    case "เปลี่ยนรหัสผ่าน":
      return { cls: "bg-blue-50 text-blue-700", Icon: ShieldCheck };
  }
}

interface AdminDashboardProps {
  userEmail?: string;
}

export default function AdminDashboard({ userEmail }: AdminDashboardProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const [activeSection, setActiveSection] = useState<AdminSection>("overview");
  const [userSearch, setUserSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | UserStatus>("all");
  const [users, setUsers] = useState<AdminUserRow[]>(mockUsers);
  const [showAllUploads, setShowAllUploads] = useState(false);
  const [showAllAccessLogs, setShowAllAccessLogs] = useState(false);

  const emailFromLogin = (location.state as { email?: string } | null)?.email;
  const resolvedEmail = userEmail || emailFromLogin || "admin@stax.com";
  const emailPrefix = resolvedEmail.split("@")[0] || "ผู้ดูแลระบบ";
  const displayName = emailPrefix.charAt(0).toUpperCase() + emailPrefix.slice(1);

  const handleLogout = () => {
    sessionStorage.removeItem("stax_admin_session");
    navigate("/admin/login", { replace: true });
  };

  const toggleUserStatus = (id: string) => {
    setUsers((prev) =>
      prev.map((u) =>
        u.id === id
          ? { ...u, status: u.status === "active" ? "suspended" : "active" }
          : u
      )
    );
  };

  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      const matchesSearch =
        userSearch.trim() === "" ||
        u.name.toLowerCase().includes(userSearch.toLowerCase()) ||
        u.email.toLowerCase().includes(userSearch.toLowerCase());
      const matchesStatus = statusFilter === "all" || u.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [users, userSearch, statusFilter]);

  const totalUsers = users.length;
  const activeUsers = users.filter((u) => u.status === "active").length;
  const suspendedUsers = totalUsers - activeUsers;
  const totalUploadsThisWeek = mockUploadLog.length;
  const failedUploads = mockUploadLog.filter((u) => u.status === "ล้มเหลว").length;
  const connectedApis = mockApiConnections.filter((a) => a.status === "connected").length;

  const visibleUploads = showAllUploads ? mockUploadLog : mockUploadLog.slice(0, 4);
  const visibleAccessLogs = showAllAccessLogs ? mockAccessLog : mockAccessLog.slice(0, 4);

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
  };

  return (
    <div className="min-h-screen w-full bg-gray-50 flex">
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
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition cursor-pointer"
          >
            <Settings className="w-4 h-4r" />
            ตั้งค่าระบบ
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition cursor-pointer"
          >
            <HelpCircle className="w-4 h-4 " />
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
      <div className="flex-1 min-w-0 flex flex-col">
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
              <Bell className="w-4 h-4 cursor-pointer" />
            </button>
            <button
              type="button"
              className="w-9 h-9 rounded-lg flex items-center justify-center text-gray-400 hover:bg-gray-50 transition"
              aria-label="ตั้งค่า"
            >
              <Settings className="w-4 h-4 cursor-pointer" />
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-red-600 transition px-2 cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              ออกจากระบบ
            </button>
          </div>
        </header>

        {/* Scrollable body */}
        <main className="flex-1 overflow-y-auto p-6 space-y-6">
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
                    {failedUploads > 0 ? (
                      <span className="text-red-500 font-medium">{failedUploads} รายการล้มเหลว</span>
                    ) : (
                      <span className="text-emerald-500 font-medium">ไม่มีรายการล้มเหลว</span>
                    )}
                  </p>
                </div>

                <div className="bg-white rounded-xl border border-gray-100 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-gray-400">สถานะ API ภายนอก</span>
                    <Wifi className="w-4 h-4 text-gray-300" />
                  </div>
                  <p className="text-xl font-semibold text-gray-800">
                    {connectedApis}/{mockApiConnections.length} เชื่อมต่อปกติ
                  </p>
                  <div className="h-1.5 bg-gray-100 rounded-full mt-3 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-blue-900"
                      style={{ width: `${(connectedApis / mockApiConnections.length) * 100}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* API connections list */}
              <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                  <h2 className="text-sm font-semibold text-gray-800">การเชื่อมต่อ API ภายนอก</h2>
                </div>
                <div className="divide-y divide-gray-50">
                  {mockApiConnections.map((api) => {
                    const badge = apiStatusBadge(api.status);
                    return (
                      <div
                        key={api.id}
                        className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50/60 transition"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-800">{api.name}</p>
                          <p className="text-xs text-gray-400 mt-0.5">{api.description}</p>
                        </div>
                        <div className="flex items-center gap-4 shrink-0">
                          <span className="text-xs text-gray-400 hidden sm:inline">
                            {api.latencyMs !== null ? `${api.latencyMs} ms` : "—"} · {api.lastChecked}
                          </span>
                          <span
                            className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-md ${badge.cls}`}
                          >
                            <badge.Icon className="w-3.5 h-3.5" />
                            {badge.label}
                          </span>
                        </div>
                      </div>
                    );
                  })}
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
                        <th className="px-5 py-3 font-medium">ใช้งานล่าสุด</th>
                        <th className="px-5 py-3 font-medium">ไฟล์ที่อัปโหลด</th>
                        <th className="px-5 py-3 font-medium">สถานะ</th>
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
                          <td className="px-5 py-3.5 text-gray-500 whitespace-nowrap">{u.joinedAt}</td>
                          <td className="px-5 py-3.5 text-gray-500 whitespace-nowrap">{u.lastActive}</td>
                          <td className="px-5 py-3.5 text-gray-500">{u.filesUploaded}</td>
                          <td className="px-5 py-3.5">
                            <span
                              className={`text-xs font-medium px-2 py-1 rounded-md ${
                                u.status === "active"
                                  ? "bg-emerald-50 text-emerald-600"
                                  : "bg-red-50 text-red-600"
                              }`}
                            >
                              {u.status === "active" ? "ใช้งานอยู่" : "ถูกระงับ"}
                            </span>
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center justify-end">
                              <button
                                type="button"
                                onClick={() => toggleUserStatus(u.id)}
                                className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border transition ${
                                  u.status === "active"
                                    ? "border-red-100 text-red-600 hover:bg-red-50"
                                    : "border-emerald-100 text-emerald-600 hover:bg-emerald-50"
                                }`}
                              >
                                {u.status === "active" ? (
                                  <>
                                    <Ban className="w-3.5 h-3.5 cursor-pointer" />
                                    ระงับบัญชี
                                  </>
                                ) : (
                                  <>
                                    <CheckCircle2 className="w-3.5 h-3.5 cursor-pointer" />
                                    เปิดใช้งาน
                                  </>
                                )}
                              </button>
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
                {mockUploadLog.length > 4 && (
                  <div className="px-5 py-3 text-center border-t border-gray-100">
                    <button
                      type="button"
                      onClick={() => setShowAllUploads((p) => !p)}
                      className="inline-flex items-center gap-1 text-xs text-blue-800 font-medium hover:underline cursor-pointer"
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
                {mockAccessLog.length > 4 && (
                  <div className="px-5 py-3 text-center border-t border-gray-100">
                    <button
                      type="button"
                      onClick={() => setShowAllAccessLogs((p) => !p)}
                      className="inline-flex items-center gap-1 text-xs text-blue-800 font-medium hover:underline cursor-pointer"
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

          {/* Footer */}
          <div className="text-center text-xs text-gray-400 pt-4 space-y-1">
            <p>© 2026 STAX Financial Management. All Rights Reserved.</p>
          </div>
        </main>
      </div>
    </div>
  );
}