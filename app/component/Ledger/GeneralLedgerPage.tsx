import { useState } from "react";
import type { GeneralLedgerAccount } from "../../lib/server-api";
import ChartOfAccountsTab from "./ChartOfAccountsTab";
import JournalTab from "./JournalTab";
import AccountLedgerDetail from "./AccountLedgerDetail";
import TrialBalanceTab from "./TrialBalanceTab";
import IncomeStatementTab from "./IncomeStatementTab";
import BalanceSheetTab from "./BalanceSheetTab";

type GlTab = "accounts" | "journal" | "trial" | "income" | "balance";

const TABS: { id: GlTab; label: string }[] = [
  { id: "accounts", label: "ผังบัญชี" },
  { id: "journal", label: "บันทึกรายการ" },
  { id: "trial", label: "งบทดลอง" },
  { id: "income", label: "งบกำไรขาดทุน" },
  { id: "balance", label: "งบดุล" },
];

interface GeneralLedgerPageProps {
  onNavigateToArchive?: () => void;
}

export default function GeneralLedgerPage({
  onNavigateToArchive,
}: GeneralLedgerPageProps) {
  const [tab, setTab] = useState<GlTab>("accounts");
  const [selectedAccount, setSelectedAccount] =
    useState<GeneralLedgerAccount | null>(null);

  if (selectedAccount) {
    return (
      <AccountLedgerDetail
        account={selectedAccount}
        onBack={() => setSelectedAccount(null)}
      />
    );
  }

  return (
    <>
      <div className="bg-white rounded-xl border border-gray-100 p-1 flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 rounded-lg text-sm font-medium transition ${
              tab === t.id
                ? "bg-blue-900 text-white"
                : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === "accounts" ? (
          <ChartOfAccountsTab onOpenAccount={setSelectedAccount} />
        ) : tab === "journal" ? (
          <JournalTab onNavigateToArchive={onNavigateToArchive} />
        ) : tab === "trial" ? (
          <TrialBalanceTab />
        ) : tab === "income" ? (
          <IncomeStatementTab />
        ) : (
          <BalanceSheetTab />
        )}
      </div>
    </>
  );
}