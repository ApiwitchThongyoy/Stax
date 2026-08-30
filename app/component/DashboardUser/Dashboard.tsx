import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import {
  LayoutDashboard,
  BookOpen,
  TrendingUp,
  Users,
  Settings,
  HelpCircle,
  Archive,
  Plus,
  Pencil,
  Trash2,
  ChevronRight,
  ChevronUp,
  ArrowUpDown,
  CalendarDays,
} from "lucide-react";
import StaxLogo from "../Login/StaxLogo";
import { useNavigate } from "react-router";
import { useAuth } from "../../lib/auth"; // ปรับ path ให้ตรง
import { useSuspendedAccount } from "../../lib/suspended-account";
import { usePresenceHeartbeat } from "../../lib/usePresenceHeartbeat";
import { useTheme } from "../../lib/useTheme";
import ThemeToggle from "../ThemeToggle";
import PdfStatementUploader from "./PdfStatementUploader";
import StoredDocumentsList from "./Storeddocumentslist";
import DailyCalendarExport from "./Dailycalendarexport";
import CapitalLedgerPage from "../Ledger/CapitalLedgerPage";
import SettingsPage from "./SettingsPage";
import NotificationBell from "./NotificationBell";
import StatementArchivePage from "./StatementArchivePage";
import FxAiPage from "./FxAiPage";
import type { ExtractedTransaction } from "../../lib/pdfStatementParser";
import type { Transaction } from "../../lib/Financeutils";
import { formatMoney, toDisplayDate, parseRateString } from "../../lib/Financeutils";

// ไม่มีข้อมูลตัวอย่างแล้ว — สมุดบัญชีเริ่มต้นว่างเปล่า รอผู้ใช้ import ไฟล์ statement จริง
const initialTransactions: Transaction[] = [];

type NavId = "dashboard" | "ledger" | "fx" | "users" | "settings" | "archive";

const navItems: { id: NavId; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "dashboard", label: "แดชบอร์ด", icon: LayoutDashboard },
  { id: "ledger", label: "สมุดบัญชี", icon: BookOpen },
  { id: "fx", label: "อัตราแลกเปลี่ยน AI", icon: TrendingUp },
  { id: "users", label: "ปฏิทิน", icon: CalendarDays },
  { id: "archive", label: "คลัง Statement", icon: Archive },
];

interface DashboardProps {
  userEmail?: string;
}

export default function Dashboard({ userEmail }: DashboardProps) {
  const navigate = useNavigate();
  const { logout, user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [activeNav, setActiveNav] = useState<NavId>("dashboard");
  const [transactions, setTransactions] = useState<Transaction[]>(initialTransactions);
  const [docsRefreshKey, setDocsRefreshKey] = useState(0);
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [showAllTransactions, setShowAllTransactions] = useState(false);
  const location = useLocation();

  // Identity must come from the authenticated user only. Never fabricate a
  // fallback ("investor@stax.com") — ProtectedLayout guarantees <Dashboard/>
  // only ever renders with an authenticated session, so user?.email is present.
  const emailFromLogin = (location.state as { email?: string } | null)
    ?.email;
  const resolvedEmail = user?.email || userEmail || emailFromLogin || "";

  const { reactivated } = useSuspendedAccount();

  // Presence: bump last_seen_at ทุก 30 วิ ขณะอยู่บน dashboard หลัง login
  // หยุดอัตโนมัติเมื่อ logout / ออกจากหน้า / ไม่มี session
  usePresenceHeartbeat({
    enabled: !!user?.accessToken && !reactivated,
    accessToken: user?.accessToken ?? null,
  });

  // Reset user-scoped in-memory state the moment the authenticated user changes
  // (A -> B) so the next render can never reuse the previous user's data. This
  // is defensive; normal logout already unmounts <Dashboard/> via ProtectedLayout.
  const prevUserId = useRef<string | undefined>(user?.id);
  useEffect(() => {
    if (prevUserId.current !== user?.id) {
      prevUserId.current = user?.id;
      setTransactions([]);
    }
  }, [user?.id]);

  // ตัดชื่อย่อจากอีเมล (ส่วนก่อน @) แล้วปรับให้ตัวแรกเป็นตัวใหญ่
  const emailPrefix = resolvedEmail.split("@")[0] || "ผู้ใช้งาน";
  const displayName =
    emailPrefix.charAt(0).toUpperCase() + emailPrefix.slice(1);

  const handleLogout = () => {
    logout(); // เคลียร์สถานะ login (+ localStorage) ใน AuthProvider
    navigate("/login", { replace: true }); // เด้งกลับไปหน้า Login
  };

  const handleImportFromPdf = (imported: ExtractedTransaction[]) => {
    const mapped: Transaction[] = imported.map((t) => ({
      id: t.id,
      date: toDisplayDate(t.date),
      description: t.description,
      subLabel: t.subLabel,
      income: t.amount >= 0 ? formatMoney(t.amount, t.currency) : null,
      expense: t.amount < 0 ? formatMoney(t.amount, t.currency) : null,
      rate: t.rate ?? "-",
      category: t.category,
      pnlAmount: t.pnlAmount,
      amount: t.amount,
      currency: t.currency,
    }));

    // รายการใหม่ล่าสุดอยู่บนสุด
    setTransactions((prev) =>
      [...mapped, ...prev].sort((a, b) => (a.date < b.date ? 1 : -1))
    );
  };

  const sortedTransactions = [...transactions].sort((a, b) =>
    sortOrder === "newest"
      ? a.date < b.date
        ? 1
        : -1
      : a.date > b.date
      ? 1
      : -1
  );

  const visibleTransactions = showAllTransactions
    ? sortedTransactions
    : sortedTransactions.slice(0, 5);

  const toggleSortOrder = () => {
    setSortOrder((prev) => (prev === "newest" ? "oldest" : "newest"));
  };

  // คำนวณ "กำไร/ขาดทุนสุทธิ" แบบเรียลไทม์ตามหลักบัญชี:
  // นับเฉพาะรายการที่เป็น "กำไร/ขาดทุนจริง" (pnlAmount) เช่น เงินปันผล ดอกเบี้ย กำไรจากการขายหุ้น ค่าธรรมเนียม ภาษี
  // ไม่นับเงินฝาก/ถอน (equity) และเงินต้นที่ใช้ซื้อ-ขายหุ้น (asset) เพราะไม่ใช่กำไรขาดทุน
  // ค่านี้จะอัปเดตทันทีทุกครั้งที่ transactions เปลี่ยน ไม่ว่าจะเพิ่มเองหรือ import จากไฟล์ PDF
  const fxGainLoss = transactions.reduce((sum, t) => {
    const rate = parseRateString(t.rate);
    return sum + t.pnlAmount * rate;
  }, 0);

  const totalIncomeTHB = transactions.reduce((sum, t) => {
    if (t.pnlAmount <= 0) return sum;
    const rate = parseRateString(t.rate);
    return sum + t.pnlAmount * rate;
  }, 0);

  const fxGainLossPercent =
    totalIncomeTHB > 0 ? (fxGainLoss / totalIncomeTHB) * 100 : 0;

  const isGain = fxGainLoss >= 0;

  return (
    <div
      className={`min-h-screen w-full bg-gray-50 flex ${
        theme === "dark" ? "dark" : ""
      }`}
    >
      {/* Sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col bg-white border-r border-gray-100">
        <div className="flex items-center gap-2.5 px-5 py-5 border-b border-gray-100">
          <div className="w-8 h-8 shrink-0">
            <StaxLogo width="32px" transparent compact />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-800 leading-none">
              STAX
            </p>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveNav(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                activeNav === item.id
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
            onClick={() => setActiveNav("settings")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
              activeNav === "settings"
                ? "bg-blue-900 text-white"
                : "text-gray-600 hover:bg-gray-50"
            }`}
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
        <header className="flex items-center justify-end px-6 py-4 bg-white border-b border-gray-100">
          <div className="flex items-center gap-3">
            <NotificationBell />
            <button
              type="button"
              onClick={() => setActiveNav("settings")}
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
          {activeNav === "users" ? (
            <DailyCalendarExport transactions={transactions} />
          ) : activeNav === "ledger" ? (
            <CapitalLedgerPage />
          ) : activeNav === "fx" ? (
            <FxAiPage
              transactions={transactions}
              onImport={handleImportFromPdf}
              onDocumentSaved={() => setDocsRefreshKey((k) => k + 1)}
            />
          ) : activeNav === "settings" ? (
            <SettingsPage onLogout={handleLogout} />
          ) : activeNav === "archive" ? (
            <StatementArchivePage />
          ) : (
            <>
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
                      กำไร/ขาดทุนสุทธิ (แปลงเป็นบาท)
                    </span>
                    <span
                      className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                        isGain
                          ? "bg-emerald-50 text-emerald-500"
                          : "bg-red-50 text-red-500"
                      }`}
                    >
                      {isGain ? "กำไร" : "ขาดทุน"}
                      {totalIncomeTHB > 0 &&
                        ` ${isGain ? "+" : ""}${fxGainLossPercent.toFixed(1)}%`}
                    </span>
                  </div>
                  <p
                    className={`text-xl font-semibold ${
                      isGain ? "text-gray-800" : "text-red-600"
                    }`}
                  >
                    {isGain ? "+" : "-"}฿
                    {Math.abs(fxGainLoss).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </p>
                  <div className="h-1.5 bg-gray-100 rounded-full mt-3 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        isGain ? "bg-emerald-400" : "bg-red-400"
                      }`}
                      style={{
                        width: `${Math.min(Math.abs(fxGainLossPercent), 100)}%`,
                      }}
                    />
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
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={toggleSortOrder}
                        className="flex items-center gap-1.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-3 py-2 rounded-lg transition"
                        title={
                          sortOrder === "newest"
                            ? "กำลังเรียง: ล่าสุด → เก่าสุด"
                            : "กำลังเรียง: เก่าสุด → ล่าสุด"
                        }
                      >
                        <ArrowUpDown className="w-3.5 h-3.5" />
                        {sortOrder === "newest" ? "ล่าสุดก่อน" : "เก่าสุดก่อน"}
                      </button>
                      <button
                        type="button"
                        className="flex items-center gap-1.5 bg-blue-900 hover:bg-blue-950 text-white text-xs font-medium px-3 py-2 rounded-lg transition"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        เพิ่มรายการใหม่
                      </button>
                    </div>
                  </div>

                  {sortedTransactions.length === 0 ? (
                    <div className="px-5 py-12 text-center">
                      <BookOpen className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                      <p className="text-sm font-medium text-gray-600">
                        ยังไม่มีรายการในสมุดบัญชี
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        ลากไฟล์ PDF statement มาที่ช่องด้านขวา หรือกด "เพิ่มรายการใหม่" เพื่อเริ่มต้น
                      </p>
                    </div>
                  ) : (
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
                        {visibleTransactions.map((t) => (
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
                  )}

                  {sortedTransactions.length > 5 && (
                    <div className="px-5 py-3.5 text-center border-t border-gray-100">
                      <button
                        type="button"
                        onClick={() => setShowAllTransactions((prev) => !prev)}
                        className="inline-flex items-center gap-1 text-xs text-blue-800 font-medium hover:underline"
                      >
                        {showAllTransactions ? "ย่อรายการ" : "ดูรายการบัญชีทั้งหมด"}
                        {showAllTransactions ? (
                          <ChevronUp className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {/* Right column */}
                <div className="space-y-4">
                  <PdfStatementUploader
                    onImport={handleImportFromPdf}
                    onDocumentSaved={() => setDocsRefreshKey((k) => k + 1)}
                  />
                  <StoredDocumentsList refreshTrigger={docsRefreshKey} />

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
            </>
          )}

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