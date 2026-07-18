import { useState } from "react";
import { useLocation } from "react-router";
import {
  LayoutDashboard,
  BookOpen,
  TrendingUp,
  Users,
  Settings,
  HelpCircle,
  Bell,
  LogOut,
  Plus,
  Pencil,
  Trash2,
  UploadCloud,
  Sparkles,
  ChevronRight,
} from "lucide-react";
import StaxLogo from "../Login/StaxLogo";
import { useNavigate } from "react-router";
import { useAuth } from "../../lib/auth"; // ปรับ path ให้ตรง

interface Transaction {
  id: string;
  date: string;
  description: string;
  subLabel?: string;
  income: string | null;
  expense: string | null;
  rate: string;
}

const transactions: Transaction[] = [
  {
    id: "1",
    date: "2024-05-12",
    description: "เงินทุนร่วมลงทุน",
    subLabel: "(Venture Capital)",
    income: "$50,000.00",
    expense: null,
    rate: "35.42",
  },
  {
    id: "2",
    date: "2024-05-14",
    description: "ค่าโฮสติ้งคลาวด์",
    subLabel: "AWS Cloud",
    income: null,
    expense: "$1,240.50",
    rate: "35.38",
  },
  {
    id: "3",
    date: "2024-05-15",
    description: "รายรับค่าธรรมเนียม",
    subLabel: "SWIFT โอนเข้าบัญชี",
    income: "$45.00",
    expense: null,
    rate: "35.40",
  },
  {
    id: "4",
    date: "2024-05-18",
    description: "ค่าใบอนุญาตซอฟต์แวร์",
    subLabel: "SaaS",
    income: null,
    expense: "$8,920.00",
    rate: "35.45",
  },
];

const navItems = [
  { label: "แดชบอร์ด", icon: LayoutDashboard, active: true },
  { label: "สมุดบัญชี", icon: BookOpen, active: false },
  { label: "อัตราแลกเปลี่ยน AI", icon: TrendingUp, active: false },
  { label: "ผู้ใช้งาน", icon: Users, active: false },
];

interface DashboardProps {
  userEmail?: string;
}

export default function Dashboard({ userEmail }: DashboardProps) {
  const navigate = useNavigate();
  const { logout, user } = useAuth();
  const [activeTab, setActiveTab] = useState("stax");
  const location = useLocation();

  const emailFromLogin = (location.state as { email?: string } | null)
    ?.email;
  const resolvedEmail = userEmail || emailFromLogin || "investor@stax.com";

  // ตัดชื่อย่อจากอีเมล (ส่วนก่อน @) แล้วปรับให้ตัวแรกเป็นตัวใหญ่
  const emailPrefix = resolvedEmail.split("@")[0] || "ผู้ใช้งาน";
  const displayName =
    emailPrefix.charAt(0).toUpperCase() + emailPrefix.slice(1);

  const handleLogout = () => {
    logout(); // เคลียร์สถานะ login (+ localStorage) ใน AuthProvider
    navigate("/login", { replace: true }); // เด้งกลับไปหน้า Login
  };

  return (
    <div className="min-h-screen w-full bg-gray-50 flex">
      {/* Sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col bg-white border-r border-gray-100">
        <div className="flex items-center gap-2.5 px-5 py-5 border-b border-gray-100">
          <div className="w-8 h-8 shrink-0">
            <StaxLogo width="32px" transparent compact />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-800 leading-none">
              STAX Admin
            </p>
            <p className="text-[11px] text-gray-400 mt-0.5">องค์กร</p>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => (
            <button
              key={item.label}
              type="button"
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                item.active
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
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition"
          >
            <Settings className="w-4 h-4" />
            ตั้งค่า
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
              <p className="text-xs font-medium text-gray-800 truncate">
                {displayName}
              </p>
              <p className="text-[11px] text-gray-400 truncate">{resolvedEmail}</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top bar */}
        <header className="flex items-center justify-between px-6 py-4 bg-white border-b border-gray-100">
          <div className="flex items-center gap-6">
            {[
              { id: "stax", label: "STAX" },
              { id: "insights", label: "สังเคราะห์" },
              { id: "guide", label: "คู่มือ" },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`text-sm font-medium pb-1 border-b-2 transition ${
                  activeTab === tab.id
                    ? "text-blue-900 border-blue-900"
                    : "text-gray-400 border-transparent hover:text-gray-600"
                }`}
              >
                {tab.label}
              </button>
            ))}
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
            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-red-600 transition px-2"
            >
              <LogOut className="w-4 h-4" />
              ออกจากระบบ
            </button>
          </div>
        </header>

        {/* Scrollable body */}
        <main className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Welcome banner */}
          <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
            <p className="text-xs text-blue-300 mb-1">เซสชั่นนี้ของคุณ</p>
            <h1 className="text-xl font-semibold mb-1.5">
              ยินดีต้อนรับกลับเข้าสู่ระบบ, {displayName}
            </h1>
            <p className="text-sm text-blue-200">
              เชื่อได้ว่าการควบคุมและกำกับดูแลบัญชีการเงินคลังโรงเรือน 3
            </p>
          </div>

          {/* Stat cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-gray-400">
                  กราไฟแนวโน้มรายได้เดือนนี้
                </span>
                <span className="text-xs font-medium text-emerald-500">
                  +4.2%
                </span>
              </div>
              <p className="text-xl font-semibold text-gray-800">
                +$12,450.00
              </p>
              <div className="h-1.5 bg-emerald-50 rounded-full mt-3 overflow-hidden">
                <div className="h-full w-2/3 bg-emerald-400 rounded-full" />
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-gray-400">
                  อัตราแลกเปลี่ยนแบบเรียลไทม์ (USD/THB)
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-500 font-medium">
                  Live BOT API
                </span>
              </div>
              <p className="text-xl font-semibold text-gray-800">35.42</p>
              <p className="text-[11px] text-gray-400 mt-3">
                อัปเดตล่าสุด 2 นาทีที่แล้ว
              </p>
            </div>

            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-gray-400">
                  ประมาณการภาษีที่ต้องชำระ
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 font-medium">
                  ใกล้ครบกำหนด
                </span>
              </div>
              <p className="text-xl font-semibold text-gray-800">
                $4,120.35
              </p>
            </div>
          </div>

          {/* Table + right column */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Transaction table */}
            <div className="lg:col-span-2 bg-white rounded-xl border border-gray-100 overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                <h2 className="text-sm font-semibold text-gray-800">
                  สมุดบัญชีเงินทุน
                </h2>
                <button
                  type="button"
                  className="flex items-center gap-1.5 bg-blue-900 hover:bg-blue-950 text-white text-xs font-medium px-3 py-2 rounded-lg transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                  เพิ่มรายการใหม่
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                      <th className="px-5 py-3 font-medium">วันที่</th>
                      <th className="px-5 py-3 font-medium">รายการ</th>
                      <th className="px-5 py-3 font-medium">เงินเข้า</th>
                      <th className="px-5 py-3 font-medium">เงินออก</th>
                      <th className="px-5 py-3 font-medium">อัตรา</th>
                      <th className="px-5 py-3 font-medium text-right">
                        จัดการ
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((t) => (
                      <tr
                        key={t.id}
                        className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60 transition"
                      >
                        <td className="px-5 py-3.5 text-gray-500 whitespace-nowrap">
                          {t.date}
                        </td>
                        <td className="px-5 py-3.5">
                          <p className="text-gray-800 font-medium">
                            {t.description}
                          </p>
                          {t.subLabel && (
                            <p className="text-xs text-gray-400">
                              {t.subLabel}
                            </p>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-emerald-600 font-medium whitespace-nowrap">
                          {t.income || "-"}
                        </td>
                        <td className="px-5 py-3.5 text-red-500 font-medium whitespace-nowrap">
                          {t.expense || "-"}
                        </td>
                        <td className="px-5 py-3.5 text-gray-500">
                          {t.rate}
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              className="text-gray-400 hover:text-blue-800 transition"
                              aria-label="แก้ไขรายการ"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              className="text-gray-400 hover:text-red-600 transition"
                              aria-label="ลบรายการ"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="px-5 py-3.5 text-center border-t border-gray-100">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs text-blue-800 font-medium hover:underline"
                >
                  ดูรายการบัญชีทั้งหมด
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Right column */}
            <div className="space-y-4">
              <div className="bg-white rounded-xl border border-gray-100 p-5">
                <div className="flex items-center gap-1.5 mb-4">
                  <Sparkles className="w-4 h-4 text-blue-800" />
                  <h3 className="text-sm font-semibold text-gray-800">
                    ระบบวิเคราะห์เอกสารอัจฉริยะ AI
                  </h3>
                </div>

                <label className="block border-2 border-dashed border-blue-100 rounded-xl px-4 py-6 text-center bg-blue-50/40 cursor-pointer hover:bg-blue-50 transition">
                  <input type="file" accept="application/pdf" className="hidden" />
                  <UploadCloud className="w-6 h-6 text-blue-800 mx-auto mb-2" />
                  <p className="text-sm font-medium text-blue-900">
                    ลากและวางไฟล์ PDF ที่นี่
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    หรือกดเพื่อเลือกไฟล์จากเครื่อง
                  </p>
                </label>

                <div className="mt-4">
                  <div className="flex items-center justify-between text-xs text-gray-400 mb-1.5">
                    <span>กำลังประมวลผล...</span>
                    <span>72%</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full w-[72%] bg-blue-800 rounded-full" />
                  </div>
                </div>
              </div>

              <div className="bg-emerald-50 rounded-xl p-5">
                <p className="text-xs text-emerald-700 font-medium mb-1.5">
                  ข้อเสนอแนะจาก AI
                </p>
                <p className="text-sm text-emerald-900 leading-relaxed">
                  รายจ่ายด้านซอฟต์แวร์เดือนนี้สูงกว่าค่าเฉลี่ย 18%
                  แนะนำให้ตรวจสอบใบสมัครที่ไม่ได้ใช้งาน
                </p>
                <button
                  type="button"
                  className="text-xs text-emerald-700 font-medium hover:underline mt-2"
                >
                  ดูรายละเอียด
                </button>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="text-center text-xs text-gray-400 pt-4 space-y-1">
            <p>© 2026 STAX Financial Management. All Rights Reserved.</p>
            <p>
              <button className="hover:underline">ความเป็นส่วนตัว</button>
              {"  ·  "}
              <button className="hover:underline">
                เงื่อนไขการให้บริการ
              </button>
              {"  ·  "}
              <button className="hover:underline">ติดต่อเรา</button>
            </p>
          </div>
        </main>
      </div>

      {/* Floating action button (mobile) */}
      <button
        type="button"
        className="md:hidden fixed bottom-5 right-5 w-12 h-12 rounded-full bg-blue-900 text-white flex items-center justify-center shadow-lg"
        aria-label="เพิ่มรายการใหม่"
      >
        <Plus className="w-5 h-5" />
      </button>
    </div>
  );
}