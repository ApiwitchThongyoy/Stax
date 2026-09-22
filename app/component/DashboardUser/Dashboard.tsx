import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  LayoutDashboard,
  UploadCloud,
  Settings,
  HelpCircle,
  Archive,
  ScrollText,
  Wallet,
  NotebookPen,
  BookOpenText,
} from "lucide-react";
import StaxLogo from "../Login/StaxLogo";
import { useAuth } from "../../lib/auth";
import { clearAllSessions } from "../../lib/session";
import { useSuspendedAccount } from "../../lib/suspended-account";
import { usePresenceHeartbeat } from "../../lib/usePresenceHeartbeat";
import { useTheme } from "../../lib/useTheme";
import ThemeToggle from "../ThemeToggle";
import GeneralLedgerNew, { type GlTab } from "../LedgerRedesign/GeneralLedgerNew";
import SettingsPage from "./SettingsPage";
import NotificationBell from "./NotificationBell";
import StatementArchivePage from "./StatementArchivePage";
import StatementUploadPage from "./StatementUploadPage";
import CashFlowPage from "./CashFlowPage";
import DashboardHomePage from "./DashboardHomePage";
import StockDetailPage from "./StockDetailPage";
import TradingJournalPage from "./TradingJournalPage";
import JournalPage from "../Journal/JournalPage";
import type { Transaction } from "../../lib/Financeutils";
import {
  fetchCapitalLedger,
  capitalLedgerToTransactions,
  fetchUserDocuments,
  type ServerDocumentMeta,
} from "../../lib/server-api";

// สมุดบัญชีเริ่มต้นว่างเปล่า — รายการจริงโหลดจาก server ผ่าน endpoint ที่เกี่ยวข้อง

type NavId =
  | "dashboard"
  | "journal"
  | "gl"
  | "upload"
  | "archive"
  | "cashflow"
  | "trading"
  | "settings";

const navItems: { id: NavId; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "dashboard", label: "หน้าหลัก", icon: LayoutDashboard },
  { id: "trading", label: "สมุดบันทึกการซื้อขาย", icon: BookOpenText },
  { id: "journal", label: "สมุดรายวัน", icon: NotebookPen },
  { id: "gl", label: "บัญชีแยกประเภท", icon: ScrollText },
  { id: "upload", label: "อัปโหลด Statement", icon: UploadCloud },
  { id: "archive", label: "คลัง Statement", icon: Archive },
  { id: "cashflow", label: "เงินเข้า/ออก", icon: Wallet },
];

interface DashboardProps {
  userEmail?: string;
}

export default function Dashboard({ userEmail }: DashboardProps) {
  const navigate = useNavigate();
  const { logout, user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [activeNav, setActiveNav] = useState<NavId>("dashboard");
  const [glTab, setGlTab] = useState<GlTab>("overview");
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [journalSearchQuery, setJournalSearchQuery] = useState("");
  const [targetLedgerTxId, setTargetLedgerTxId] = useState<string | null>(null);
  const location = useLocation();

  // Keep-Alive Tab Cache: mount tabs lazily on first visit and keep them mounted
  // in memory to eliminate refetch storms, skeleton flashes, and tab lag (0ms switching)
  const [visitedNavs, setVisitedNavs] = useState<Set<NavId>>(
    () => new Set(["dashboard", activeNav])
  );

  useEffect(() => {
    setVisitedNavs((prev) => {
      if (prev.has(activeNav)) return prev;
      const next = new Set(prev);
      next.add(activeNav);
      return next;
    });
  }, [activeNav]);

  // Server-authoritative data for หน้าหลัก (ไม่มี session-import state แยก
  // ค่านี้เป็นแหล่งเดียวกับที่หน้าอื่นใช้)
  const [serverTransactions, setServerTransactions] = useState<Transaction[]>(
    []
  );
  const [serverDocuments, setServerDocuments] = useState<ServerDocumentMeta[]>(
    []
  );
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [dataRevision, setDataRevision] = useState(0);

  const refreshServerData = useCallback(async () => {
    if (!user?.accessToken) return;
    setLedgerError(null);
    setDataRevision((prev) => prev + 1);
    try {
      const [rows, docs] = await Promise.all([
        fetchCapitalLedger(user.accessToken),
        fetchUserDocuments(user.accessToken),
      ]);
      setServerTransactions(capitalLedgerToTransactions(rows));
      setServerDocuments(docs);
    } catch (error) {
      setLedgerError(
        error instanceof Error
          ? error.message
          : "ไม่สามารถโหลดข้อมูลจากเซิร์ฟเวอร์ได้"
      );
    }
  }, [user?.accessToken]);

  const handleDataChanged = useCallback(() => {
    setDataRevision((prev) => prev + 1);
    void refreshServerData();
  }, [refreshServerData]);

  // When authenticated user changes, clear cached tabs to avoid cross-user state leaks
  useEffect(() => {
    setVisitedNavs(new Set(["dashboard"]));
    setActiveNav("dashboard");
  }, [user?.id]);

  useEffect(() => {
    void refreshServerData();
  }, [refreshServerData]);

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
    onUnauthorized: () => {
      clearAllSessions();
      logout();
    },
  });

  // ตัดชื่อย่อจากอีเมล (ส่วนก่อน @) แล้วปรับให้ตัวแรกเป็นตัวใหญ่
  const emailPrefix = resolvedEmail.split("@")[0] || "ผู้ใช้งาน";
  const displayName =
    emailPrefix.charAt(0).toUpperCase() + emailPrefix.slice(1);

  const handleLogout = () => {
    logout(); // เคลียร์สถานะ login (+ localStorage) ใน AuthProvider
    navigate("/login", { replace: true }); // เด้งกลับไปหน้า Login
  };

  return (
    <div
      className={`h-screen w-full bg-gray-50 flex overflow-hidden ${
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

          {/* เมนูย่อยของบัญชีแยกประเภท: ภาพรวม + 5 หมวด + รายงาน */}
          {activeNav === "gl" && (
            <div className="pt-2 space-y-1">
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                ภาพรวม
              </p>
              <button
                type="button"
                onClick={() => setGlTab("overview")}
                className={`w-full flex items-center gap-3 pl-8 pr-3 py-2 rounded-lg text-[13px] font-medium transition ${
                  glTab === "overview"
                    ? "bg-blue-50 text-blue-900"
                    : "text-gray-500 hover:bg-gray-50"
                }`}
              >
                ภาพรวมการเงิน
              </button>

              <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                หมวดหมู่
              </p>
              {([
                { id: "ASSET", label: "สินทรัพย์" },
                { id: "LIABILITY", label: "หนี้สิน" },
                { id: "EQUITY", label: "ส่วนทุน" },
                { id: "INCOME", label: "รายได้" },
                { id: "EXPENSE", label: "ค่าใช้จ่าย" },
              ] as { id: GlTab; label: string }[]).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setGlTab(item.id)}
                  className={`w-full flex items-center gap-3 pl-8 pr-3 py-2 rounded-lg text-[13px] font-medium transition ${
                    glTab === item.id
                      ? "bg-blue-50 text-blue-900"
                      : "text-gray-500 hover:bg-gray-50"
                  }`}
                >
                  {item.label}
                </button>
              ))}
              <div className="my-1 border-t border-gray-100" />
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                รายงาน
              </p>
              {([
                { id: "journal", label: "บันทึกรายการ" },
                { id: "trial", label: "งบทดลอง" },
                { id: "income", label: "งบกำไรขาดทุน" },
                { id: "balance", label: "งบดุล" },
              ] as { id: GlTab; label: string }[]).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setGlTab(item.id)}
                  className={`w-full flex items-center gap-3 pl-8 pr-3 py-2 rounded-lg text-[13px] font-medium transition ${
                    glTab === item.id
                      ? "bg-blue-50 text-blue-900"
                      : "text-gray-500 hover:bg-gray-50"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
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
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
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
          {selectedSymbol ? (
            <StockDetailPage
              symbol={selectedSymbol}
              onBack={() => setSelectedSymbol(null)}
            />
          ) : (
            <>
              {visitedNavs.has("dashboard") && (
                <div
                  key={`dashboard-${dataRevision}`}
                  className={activeNav === "dashboard" ? "block" : "hidden"}
                  hidden={activeNav !== "dashboard"}
                >
                  {ledgerError && (
                    <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm px-4 py-3 rounded-lg">
                      โหลดข้อมูลสำหรับหน้าหลักไม่สำเร็จ: {ledgerError}
                    </div>
                  )}
                  {!ledgerError && (
                    <DashboardHomePage
                      transactions={serverTransactions}
                      documents={serverDocuments}
                      onNavigate={(nav) => setActiveNav(nav)}
                      onOpenSymbol={(symbol) => setSelectedSymbol(symbol)}
                    />
                  )}
                </div>
              )}

              {visitedNavs.has("gl") && (
                <div
                  key={`gl-${dataRevision}`}
                  className={activeNav === "gl" ? "block" : "hidden"}
                  hidden={activeNav !== "gl"}
                >
                  <GeneralLedgerNew
                    activeTab={glTab}
                    targetTxId={targetLedgerTxId}
                    onSelectTab={(t) => {
                      setGlTab(t);
                      setActiveNav("gl");
                    }}
                    onNavigateToArchive={() => setActiveNav("archive")}
                    onOpenSymbol={(symbol) => setSelectedSymbol(symbol)}
                    onNavigateToJournal={(entryNo) => {
                      setJournalSearchQuery(`#${entryNo}`);
                      setActiveNav("journal");
                    }}
                  />
                </div>
              )}

              {visitedNavs.has("journal") && (
                <div
                  key={`journal-${dataRevision}`}
                  className={activeNav === "journal" ? "block" : "hidden"}
                  hidden={activeNav !== "journal"}
                >
                  <JournalPage
                    initialSearch={journalSearchQuery}
                    onNavigateToArchive={() => setActiveNav("archive")}
                    onNavigateToLedger={(sourceTransactionId, category) => {
                      setTargetLedgerTxId(sourceTransactionId);
                      if (category) {
                        setGlTab(category);
                      } else {
                        setGlTab("ASSET");
                      }
                      setActiveNav("gl");
                    }}
                    onDataChanged={handleDataChanged}
                  />
                </div>
              )}

              {visitedNavs.has("upload") && (
                <div
                  className={activeNav === "upload" ? "block" : "hidden"}
                  hidden={activeNav !== "upload"}
                >
                  <StatementUploadPage
                    onNavigateToArchive={() => setActiveNav("archive")}
                    onNavigateToOverview={() => {
                      setGlTab("overview");
                      setActiveNav("gl");
                    }}
                    onImportSuccess={refreshServerData}
                  />
                </div>
              )}

              {visitedNavs.has("archive") && (
                <div
                  key={`archive-${dataRevision}`}
                  className={activeNav === "archive" ? "block" : "hidden"}
                  hidden={activeNav !== "archive"}
                >
                  <StatementArchivePage />
                </div>
              )}

              {visitedNavs.has("cashflow") && (
                <div
                  className={activeNav === "cashflow" ? "block" : "hidden"}
                  hidden={activeNav !== "cashflow"}
                >
                  <CashFlowPage onBack={() => setActiveNav("dashboard")} />
                </div>
              )}

              {visitedNavs.has("trading") && (
                <div
                  className={activeNav === "trading" ? "block" : "hidden"}
                  hidden={activeNav !== "trading"}
                >
                  <TradingJournalPage
                    onOpenSymbol={(symbol) => setSelectedSymbol(symbol)}
                  />
                </div>
              )}

              {visitedNavs.has("settings") && (
                <div
                  className={activeNav === "settings" ? "block" : "hidden"}
                  hidden={activeNav !== "settings"}
                >
                  <SettingsPage onLogout={handleLogout} />
                </div>
              )}
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
    </div>
  );
}