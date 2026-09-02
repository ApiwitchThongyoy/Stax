import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  BookOpen,
  Plus,
  Pencil,
  Trash2,
  X,
  ArrowDownCircle,
  ArrowUpCircle,
  AlertCircle,
} from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  useSuspendedAccount,
  flagSuspendedFromResponse,
} from "../../lib/suspended-account";

const CURRENCY_OPTIONS = ["THB", "USD", "HKD", "CNH"];

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  THB: "฿",
  HKD: "HK$",
  CNH: "¥",
};

type ApiTransactionType = "CASH_IN" | "CASH_OUT";
type FormEntryType = "in" | "out";

// รูปทรงข้อมูลจริงจาก GET /api/v1/capital-ledgers (Drizzle schema: Capital_Transactions)
interface ApiTransaction {
  transactionId: string;
  amountForeign: string;
  currency: string;
  transactionDate: string;
  fxRateBot: string | null;
  fxRateEffective?: string | null;
  fxRateStatement?: string | null;
  amountThb: string;
  type: ApiTransactionType;
  sourceType: string;
}

function formatMoney(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  return `${symbol}${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatThb(amount: number): string {
  return `฿${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function toNumber(value: string): number {
  const num = Number(value);
  return Number.isNaN(num) ? 0 : num;
}

interface FormState {
  date: string;
  type: FormEntryType;
  amount: string;
  currency: string;
  rate: string;
}

function emptyForm(): FormState {
  return {
    date: new Date().toISOString().slice(0, 10),
    type: "in",
    amount: "",
    currency: "THB",
    rate: "1",
  };
}

export default function CapitalLedgerPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { suspended, markSuspended } = useSuspendedAccount();

  const [entries, setEntries] = useState<ApiTransaction[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "success" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [formError, setFormError] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Token หมดอายุ/ไม่ถูกต้อง → เคลียร์ session ตาม auth flow เดิม
  // (ProtectedLayout จะเด้งกลับไปหน้า /login ให้เอง)
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

  const fetchHistory = useCallback(async () => {
    if (suspended) return;
    setLoadState("loading");
    setLoadError("");

    let response: Response;
    try {
      response = await fetch("/api/v1/capital-ledgers", {
        headers: authHeaders(),
      });
    } catch {
      setLoadState("error");
      setLoadError("ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง");
      return;
    }

    if (response.status === 401) {
      handleUnauthorized();
      return;
    }

    if (await flagSuspendedFromResponse(response, markSuspended)) {
      return;
    }

    let data: { success?: boolean; data?: ApiTransaction[] };
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok || !data.success || !Array.isArray(data.data)) {
      setLoadState("error");
      setLoadError("ดึงประวัติธุรกรรมไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
      return;
    }

    setEntries(data.data);
    setLoadState("success");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleUnauthorized, user?.accessToken, suspended, markSuspended]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const openAddModal = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFormError("");
    setIsModalOpen(true);
  };

  const openEditModal = (entry: ApiTransaction) => {
    setEditingId(entry.transactionId);
    setForm({
      date: entry.transactionDate.slice(0, 10),
      type: entry.type === "CASH_OUT" ? "out" : "in",
      amount: entry.amountForeign,
      currency: entry.currency,
      // Imported rows carry fx_rate_bot = null; fall back to the rate actually
      // applied (fx_rate_effective) so editing never silently resets FX to 1.
      rate:
        entry.fxRateBot ?? entry.fxRateEffective ?? entry.fxRateStatement ?? "1",
    });
    setFormError("");
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingId(null);
    setFormError("");
  };

  const buildPayload = () => {
    const amountNum = parseFloat(form.amount);
    const rateNum = toNumber(form.rate.trim() || "1");
    return {
      amountForeign: String(amountNum),
      currency: form.currency,
      transactionDate: form.date,
      fxRateBot: String(rateNum),
      amountThb: String(amountNum * rateNum),
      type: (form.type === "out" ? "CASH_OUT" : "CASH_IN") as ApiTransactionType,
      sourceType: "MANUAL",
    };
  };

  const handleSave = async () => {
    if (!form.date) {
      setFormError("กรุณาเลือกวันที่");
      return;
    }
    const amountNum = parseFloat(form.amount);
    if (!form.amount || Number.isNaN(amountNum) || amountNum <= 0) {
      setFormError("กรุณากรอกจำนวนเงินให้ถูกต้อง (มากกว่า 0)");
      return;
    }

    setIsSaving(true);
    setFormError("");
    if (suspended) return;

    let response: Response;
    try {
      response = await fetch(
        editingId ? `/api/v1/capital-ledgers/${editingId}` : "/api/v1/capital-ledgers",
        {
          method: editingId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify(buildPayload()),
        }
      );
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

    let data: { success?: boolean; data?: ApiTransaction };
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok || !data.success || !data.data) {
      setIsSaving(false);
      setFormError("บันทึกรายการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
      return;
    }

    const saved = data.data;
    setEntries((prev) =>
      editingId
        ? prev.map((e) => (e.transactionId === saved.transactionId ? saved : e))
        : [saved, ...prev]
    );
    setIsSaving(false);
    closeModal();
  };

  const handleDelete = async (id: string) => {
    if (suspended) return;
    let response: Response;
    try {
      response = await fetch(`/api/v1/capital-ledgers/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
    } catch {
      setLoadError("ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง");
      return;
    }

    if (response.status === 401) {
      handleUnauthorized();
      return;
    }

    if (await flagSuspendedFromResponse(response, markSuspended)) {
      return;
    }

    if (response.ok) {
      setEntries((prev) => prev.filter((e) => e.transactionId !== id));
    }
  };

  const sortedEntries = [...entries].sort((a, b) =>
    a.transactionDate < b.transactionDate ? 1 : -1
  );

  const totalIn = entries
    .filter((e) => e.type === "CASH_IN")
    .reduce((sum, e) => sum + toNumber(e.amountThb), 0);
  const totalOut = entries
    .filter((e) => e.type === "CASH_OUT")
    .reduce((sum, e) => sum + toNumber(e.amountThb), 0);
  const netThb = totalIn - totalOut;

  return (
    <>
      {/* Intro banner */}
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">Capital Ledger</p>
        <h1 className="text-xl font-semibold mb-1.5">
          บันทึกเงินโอนเข้า-ออกประเทศด้วยตนเอง
        </h1>
        <p className="text-sm text-blue-200">
          เพิ่ม แก้ไข หรือลบรายการ Cash In / Cash Out ได้อิสระ ข้อมูลถูกบันทึกบนเซิร์ฟเวอร์ของบัญชีคุณ
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <span className="text-xs text-gray-400">เงินโอนเข้ารวม (THB)</span>
          <p className="text-xl font-semibold text-emerald-600 mt-2">
            +฿{totalIn.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <span className="text-xs text-gray-400">เงินโอนออกรวม (THB)</span>
          <p className="text-xl font-semibold text-red-500 mt-2">
            -฿{totalOut.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <span className="text-xs text-gray-400">สุทธิ (THB)</span>
          <p
            className={`text-xl font-semibold mt-2 ${
              netThb >= 0 ? "text-gray-800" : "text-red-600"
            }`}
          >
            {netThb >= 0 ? "+" : "-"}฿
            {Math.abs(netThb).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </p>
        </div>
      </div>

      {/* Ledger table */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden mt-6">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-800">
            รายการเงินโอนเข้า-ออก
          </h2>
          <button
            type="button"
            onClick={openAddModal}
            className="flex items-center gap-1.5 bg-blue-900 hover:bg-blue-950 text-white text-xs font-medium px-3 py-2 rounded-lg transition"
          >
            <Plus className="w-3.5 h-3.5" />
            เพิ่มรายการใหม่
          </button>
        </div>

        {loadState === "loading" ? (
          <div className="px-5 py-6 space-y-3 animate-pulse">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-4">
                <div className="h-3 bg-gray-200 rounded w-24" />
                <div className="h-3 bg-gray-200 rounded w-20" />
                <div className="h-3 bg-gray-200 rounded flex-1" />
                <div className="h-3 bg-gray-200 rounded w-16" />
              </div>
            ))}
          </div>
        ) : loadState === "error" ? (
          <div className="px-5 py-10 text-center">
            <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-3" />
            <p className="text-sm font-medium text-red-600">{loadError}</p>
            <button
              type="button"
              onClick={fetchHistory}
              className="mt-3 inline-flex items-center gap-1.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-3 py-2 rounded-lg transition"
            >
              ลองใหม่อีกครั้ง
            </button>
          </div>
        ) : sortedEntries.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <BookOpen className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-600">
              ยังไม่มีรายการในสมุดบัญชี
            </p>
            <p className="text-xs text-gray-400 mt-1">
              กด "เพิ่มรายการใหม่" เพื่อบันทึกรายการเงินโอนเข้า-ออกครั้งแรก
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                  <th className="px-5 py-3 font-medium">วันที่</th>
                  <th className="px-5 py-3 font-medium">ประเภท</th>
                  <th className="px-5 py-3 font-medium">จำนวนเงิน</th>
                  <th className="px-5 py-3 font-medium">อัตรา</th>
                  <th className="px-5 py-3 font-medium">ยอดเงิน (THB)</th>
                  <th className="px-5 py-3 font-medium text-right">จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {sortedEntries.map((e) => (
                  <tr
                    key={e.transactionId}
                    className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60 transition"
                  >
                    <td className="px-5 py-3.5 text-gray-500 whitespace-nowrap">
                      {e.transactionDate.slice(0, 10)}
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full ${
                          e.type === "CASH_IN"
                            ? "bg-emerald-50 text-emerald-600"
                            : "bg-red-50 text-red-500"
                        }`}
                      >
                        {e.type === "CASH_IN" ? (
                          <ArrowDownCircle className="w-3.5 h-3.5" />
                        ) : (
                          <ArrowUpCircle className="w-3.5 h-3.5" />
                        )}
                        {e.type === "CASH_IN" ? "เงินเข้า" : "เงินออก"}
                      </span>
                    </td>
                    <td
                      className={`px-5 py-3.5 font-medium whitespace-nowrap ${
                        e.type === "CASH_IN" ? "text-emerald-600" : "text-red-500"
                      }`}
                    >
                      {e.type === "CASH_IN" ? "+" : "-"}
                      {formatMoney(toNumber(e.amountForeign), e.currency)}
                    </td>
                    <td className="px-5 py-3.5 text-gray-500">{e.fxRateBot}</td>
                    <td className="px-5 py-3.5 text-gray-600 whitespace-nowrap">
                      {formatThb(toNumber(e.amountThb))}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => openEditModal(e)}
                          className="text-gray-400 hover:text-blue-800 transition"
                          aria-label="แก้ไขรายการ"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(e.transactionId)}
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
      </div>

      {/* Add/Edit modal */}
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
                {editingId ? "แก้ไขรายการ" : "เพิ่มรายการใหม่"}
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
              {/* Type toggle */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">
                  ประเภทรายการ
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, type: "in" }))}
                    className={`flex items-center justify-center gap-1.5 text-sm font-medium py-2.5 rounded-lg border transition ${
                      form.type === "in"
                        ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                        : "border-gray-200 text-gray-500 hover:bg-gray-50"
                    }`}
                  >
                    <ArrowDownCircle className="w-4 h-4" />
                    เงินเข้า (Cash In)
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, type: "out" }))}
                    className={`flex items-center justify-center gap-1.5 text-sm font-medium py-2.5 rounded-lg border transition ${
                      form.type === "out"
                        ? "bg-red-50 border-red-200 text-red-600"
                        : "border-gray-200 text-gray-500 hover:bg-gray-50"
                    }`}
                  >
                    <ArrowUpCircle className="w-4 h-4" />
                    เงินออก (Cash Out)
                  </button>
                </div>
              </div>

              {/* Date */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">
                  วันที่
                </label>
                <input
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                  className="w-full px-3 py-2.5 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
                />
              </div>

              {/* Amount + currency */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">
                    จำนวนเงิน
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.amount}
                    onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                    placeholder="0.00"
                    className="w-full px-3 py-2.5 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">
                    สกุลเงิน
                  </label>
                  <select
                    value={form.currency}
                    onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
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

              {/* Rate */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">
                  อัตราแลกเปลี่ยน (ใส่ "1" ถ้าเป็น THB)
                </label>
                <input
                  type="text"
                  value={form.rate}
                  onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))}
                  placeholder="เช่น 32.50"
                  className="w-full px-3 py-2.5 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
                />
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
                onClick={handleSave}
                disabled={isSaving}
                className="flex-1 bg-blue-900 hover:bg-blue-950 text-white text-sm font-medium py-2.5 rounded-lg transition disabled:opacity-60"
              >
                {isSaving ? "กำลังบันทึก..." : editingId ? "บันทึกการแก้ไข" : "บันทึกรายการ"}
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
