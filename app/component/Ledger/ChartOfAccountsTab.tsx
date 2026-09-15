import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Plus, X, ArrowRight, Landmark, Search } from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  useSuspendedAccount,
  flagSuspendedFromResponse,
} from "../../lib/suspended-account";
import { fetchAccounts, type GeneralLedgerAccount } from "../../lib/server-api";
import {
  AccountTypeBadge,
  formatAmount,
  LoadingRows,
  ErrorBox,
  EmptyState,
  Panel,
} from "./shared";

const CURRENCY_OPTIONS = ["THB", "USD", "HKD", "CNH"];

const ACCOUNT_TYPES: { value: string; label: string }[] = [
  { value: "ASSET", label: "สินทรัพย์" },
  { value: "LIABILITY", label: "หนี้สิน" },
  { value: "EQUITY", label: "ส่วนทุน" },
  { value: "INCOME", label: "รายได้" },
  { value: "EXPENSE", label: "ค่าใช้จ่าย" },
];

interface ChartOfAccountsTabProps {
  onOpenAccount: (account: GeneralLedgerAccount) => void;
}

interface AddForm {
  code: string;
  name: string;
  type: string;
  currency: string;
}

function emptyAddForm(): AddForm {
  return { code: "", name: "", type: "ASSET", currency: "THB" };
}

export default function ChartOfAccountsTab({
  onOpenAccount,
}: ChartOfAccountsTabProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { suspended, markSuspended } = useSuspendedAccount();

  const [accounts, setAccounts] = useState<GeneralLedgerAccount[]>([]);
  const [loadState, setLoadState] = useState<
    "loading" | "success" | "error"
  >("loading");
  const [loadError, setLoadError] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState<AddForm>(emptyAddForm());
  const [formError, setFormError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [query, setQuery] = useState("");

  const handleUnauthorized = useCallback(() => {
    logout();
    navigate("/login", { replace: true });
  }, [logout, navigate]);

  const authHeaders = (): Record<string, string> => {
    if (!user?.accessToken) {
      handleUnauthorized();
      return {};
    }
    return { Authorization: `Bearer ${user.accessToken}` };
  };

  const loadAccounts = useCallback(async () => {
    if (suspended) return;
    if (!user?.accessToken) return;
    setLoadState("loading");
    setLoadError("");
    try {
      const rows = await fetchAccounts(user.accessToken);
      setAccounts(rows);
      setLoadState("success");
    } catch {
      setLoadState("error");
      setLoadError("ดึงผังบัญชีไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    }
  }, [user?.accessToken, suspended]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const openModal = () => {
    setForm(emptyAddForm());
    setFormError("");
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setFormError("");
  };

  const handleCreate = async () => {
    const code = form.code.trim();
    const name = form.name.trim();
    if (!/^[0-9]{4}$/.test(code)) {
      setFormError("รหัสบัญชีต้องเป็นตัวเลข 4 หลัก (เช่น 1020)");
      return;
    }
    if (!name) {
      setFormError("กรุณากรอกชื่อบัญชี");
      return;
    }
    if (suspended) return;

    setIsSaving(true);
    setFormError("");

    let response: Response;
    try {
      response = await fetch("/api/v1/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          code,
          name,
          type: form.type,
          currency: form.currency,
        }),
      });
    } catch {
      setIsSaving(false);
      setFormError("ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง");
      return;
    }

    if (response.status === 401) {
      handleUnauthorized();
      return;
    }

    if (await flagSuspendedFromResponse(response, markSuspended)) {
      return;
    }

    let data: {
      success?: boolean;
      message?: string;
      data?: GeneralLedgerAccount;
    };
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok || !data.success || !data.data) {
      setIsSaving(false);
      setFormError(data.message || "สร้างบัญชีไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
      return;
    }

    setAccounts((prev) => [...prev, data.data as GeneralLedgerAccount]);
    setIsSaving(false);
    closeModal();
  };

  const counts = accounts.reduce<Record<string, number>>((acc, row) => {
    acc[row.type] = (acc[row.type] ?? 0) + 1;
    return acc;
  }, {});

  const searching = query.trim() !== "";
  const filteredAccounts = searching
    ? accounts.filter((row) => {
        const q = query.trim().toLowerCase();
        return (
          row.code.toLowerCase().includes(q) ||
          row.name.toLowerCase().includes(q) ||
          row.type.toLowerCase().includes(q) ||
          row.currency.toLowerCase().includes(q)
        );
      })
    : accounts;

  return (
    <>
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">Chart of Accounts</p>
        <h1 className="text-xl font-semibold mb-1.5">ผังบัญชีแยกประเภท</h1>
        <p className="text-sm text-blue-200">
          บัญชีทั้งหมดสำหรับการบันทึกแบบคู่ (เดบิต/เครดิต) จัดตั้งอัตโนมัติตั้งแต่สมัครใช้งาน
          นำเข้างบได้จาก Statement และคลังเอกสาร
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <span className="text-xs text-gray-400">จำนวนบัญชีที่ใช้งาน</span>
          <p className="text-xl font-semibold text-gray-800 mt-2">
            {accounts.length}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <span className="text-xs text-gray-400">บัญชีสินทรัพย์</span>
          <p className="text-xl font-semibold text-emerald-600 mt-2">
            {counts.ASSET ?? 0}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <span className="text-xs text-gray-400">บัญชีส่วนทุน/รายได้/ค่าใช้จ่าย</span>
          <p className="text-xl font-semibold text-gray-800 mt-2">
            {(counts.EQUITY ?? 0) + (counts.INCOME ?? 0) + (counts.EXPENSE ?? 0)}
          </p>
        </div>
      </div>

      <div className="mt-6">
        <Panel
          title="รายการบัญชี"
          actions={
            <button
              type="button"
              onClick={openModal}
              className="flex items-center gap-1.5 bg-blue-900 hover:bg-blue-950 text-white text-xs font-medium px-3 py-2 rounded-lg transition"
            >
              <Plus className="w-3.5 h-3.5" />
              เพิ่มบัญชีใหม่
            </button>
          }
        >
          {loadState === "loading" ? (
            <LoadingRows />
          ) : loadState === "error" ? (
            <ErrorBox message={loadError} onRetry={loadAccounts} />
          ) : accounts.length === 0 ? (
            <EmptyState
              title="ยังไม่มีผังบัญชี"
              hint="ผังบัญชีจะถูกสร้างอัตโนมัติเมื่อสมัครใช้งาน"
            />
          ) : filteredAccounts.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <Search className="w-8 h-8 text-gray-300 mx-auto mb-3" />
              <p className="text-sm font-medium text-gray-600">
                ไม่พบรายการที่ค้นหา
              </p>
              <p className="text-xs text-gray-400 mt-1">
                ลองเปลี่ยนคำค้นหา
              </p>
              <button
                type="button"
                onClick={() => setQuery("")}
                className="mt-3 bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-3 py-2 rounded-lg transition"
              >
                ล้าง
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 px-5 pt-4">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="ค้นหารหัส ชื่อ ประเภท หรือสกุลเงิน…"
                    className="w-full pl-9 pr-3 py-2 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
                  />
                </div>
                {searching && (
                  <span className="text-xs text-gray-500">
                    พบ {filteredAccounts.length} จาก {accounts.length} บัญชี
                  </span>
                )}
              </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                    <th className="px-5 py-3 font-medium">รหัส</th>
                    <th className="px-5 py-3 font-medium">ชื่อบัญชี</th>
                    <th className="px-5 py-3 font-medium">ประเภท</th>
                    <th className="px-5 py-3 font-medium">สกุลเงิน</th>
                    <th className="px-5 py-3 font-medium">ยอดยกมา</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {filteredAccounts.map((row) => (
                    <tr
                      key={row.id}
                      onClick={() => onOpenAccount(row)}
                      className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60 transition cursor-pointer"
                    >
                      <td className="px-5 py-3.5 text-gray-500 whitespace-nowrap">
                        {row.code}
                      </td>
                      <td className="px-5 py-3.5">
                        <p className="text-gray-800 font-medium">{row.name}</p>
                      </td>
                      <td className="px-5 py-3.5">
                        <AccountTypeBadge type={row.type} />
                      </td>
                      <td className="px-5 py-3.5 text-gray-500">{row.currency}</td>
                      <td className="px-5 py-3.5 text-gray-600 whitespace-nowrap">
                        {row.openingBalance != null
                          ? formatAmount(row.openingBalance)
                          : "-"}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center justify-end">
                          <ArrowRight className="w-4 h-4 text-gray-300" />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </Panel>
      </div>

      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/40 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-800">
                เพิ่มบัญชีใหม่
              </h3>
              <button
                type="button"
                onClick={closeModal}
                className="text-gray-400 hover:text-gray-600 transition p-1"
                aria-label="ปิดหน้าต่าง"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">
                  รหัสบัญชี
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.code}
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                  placeholder="เช่น 1020"
                  className="w-full px-3 py-2.5 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">
                  ชื่อบัญชี
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="เช่น เงินฝากธนาคาร UOB"
                  className="w-full px-3 py-2.5 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">
                    ประเภท
                  </label>
                  <select
                    value={form.type}
                    onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                    className="w-full px-3 py-2.5 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
                  >
                    {ACCOUNT_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">
                    สกุลเงิน
                  </label>
                  <select
                    value={form.currency}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, currency: e.target.value }))
                    }
                    className="w-full px-3 py-2.5 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
                  >
                    {CURRENCY_OPTIONS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {formError && (
                <div className="px-3 py-2.5 rounded-lg bg-red-50 text-red-600 text-sm">
                  {formError}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-100">
              <button
                type="button"
                onClick={handleCreate}
                disabled={isSaving}
                className="flex-1 flex items-center justify-center gap-1.5 bg-blue-900 hover:bg-blue-950 text-white text-sm font-medium py-2.5 rounded-lg transition disabled:opacity-60"
              >
                <Landmark className="w-4 h-4" />
                {isSaving ? "กำลังบันทึก..." : "สร้างบัญชี"}
              </button>
              <button
                type="button"
                onClick={closeModal}
                className="text-sm font-medium px-4 py-2.5 rounded-lg text-gray-500 hover:bg-gray-50 transition"
              >
                ยกเลิก
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}