import type { GeneralLedgerAccountType } from "../../lib/server-api";
import AccountCategoryView from "./AccountCategoryView";
import OverviewTab from "./OverviewTab";
import JournalTab from "../Ledger/JournalTab";
import TrialBalanceTab from "../Ledger/TrialBalanceTab";
import IncomeStatementTab from "../Ledger/IncomeStatementTab";
import BalanceSheetTab from "../Ledger/BalanceSheetTab";

export type CategoryId = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";

export type GlTab =
  | "overview"
  | "ASSET"
  | "LIABILITY"
  | "EQUITY"
  | "INCOME"
  | "EXPENSE"
  | "journal"
  | "trial"
  | "income"
  | "balance";

export interface CategoryDef {
  id: CategoryId;
  label: string;
  english: string;
  /** Tailwind banner accent classes */
  accent: string;
  icon: "wallet" | "landmark" | "percent" | "receipt" | "piggy";
}

export const CATEGORIES: CategoryDef[] = [
  {
    id: "ASSET",
    label: "สินทรัพย์",
    english: "Assets",
    accent: "from-emerald-900 to-emerald-950",
    icon: "wallet",
  },
  {
    id: "LIABILITY",
    label: "หนี้สิน",
    english: "Liabilities",
    accent: "from-amber-900 to-amber-950",
    icon: "landmark",
  },
  {
    id: "EQUITY",
    label: "ส่วนทุน",
    english: "Equity",
    accent: "from-blue-900 to-blue-950",
    icon: "percent",
  },
  {
    id: "INCOME",
    label: "รายได้",
    english: "Revenue",
    accent: "from-green-900 to-green-950",
    icon: "receipt",
  },
  {
    id: "EXPENSE",
    label: "ค่าใช้จ่าย",
    english: "Expenses",
    accent: "from-red-900 to-red-950",
    icon: "piggy",
  },
];

const CATEGORY_TABS: { id: CategoryId; label: string }[] = CATEGORIES.map(
  (c) => ({ id: c.id, label: c.label })
);

const REPORT_TABS: { id: GlTab; label: string }[] = [
  { id: "journal", label: "บันทึกรายการ" },
  { id: "trial", label: "งบทดลอง" },
  { id: "income", label: "งบกำไรขาดทุน" },
  { id: "balance", label: "งบดุล" },
];

interface GeneralLedgerNewProps {
  activeTab: GlTab;
  onSelectTab: (tab: GlTab) => void;
  onNavigateToArchive?: () => void;
  /** เจาะดูหุ้นรายตัวจากกราฟสัดส่วน (เหมือนหน้าหลัก) */
  onOpenSymbol?: (symbol: string) => void;
}

export default function GeneralLedgerNew({
  activeTab,
  onSelectTab,
  onNavigateToArchive,
  onOpenSymbol,
}: GeneralLedgerNewProps) {
  const isCategory =
    activeTab === "ASSET" ||
    activeTab === "LIABILITY" ||
    activeTab === "EQUITY" ||
    activeTab === "INCOME" ||
    activeTab === "EXPENSE";

  return activeTab === "overview" ? (
    <OverviewTab onOpenSymbol={onOpenSymbol} />
  ) : isCategory ? (
    <AccountCategoryView
      type={activeTab as GeneralLedgerAccountType}
      activeTab={activeTab}
      onSelectTab={(t) => {
        if (
          t === "ASSET" ||
          t === "LIABILITY" ||
          t === "EQUITY" ||
          t === "INCOME" ||
          t === "EXPENSE"
        ) {
          onSelectTab(t);
        }
      }}
    />
  ) : activeTab === "journal" ? (
    <JournalTab onNavigateToArchive={onNavigateToArchive} />
  ) : activeTab === "trial" ? (
    <TrialBalanceTab />
  ) : activeTab === "income" ? (
    <IncomeStatementTab />
  ) : (
    <BalanceSheetTab />
  );
}
