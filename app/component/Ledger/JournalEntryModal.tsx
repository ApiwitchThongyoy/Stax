import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  createJournalEntry,
  type GeneralLedgerAccount,
} from "../../lib/server-api";
import { formatBaht } from "./shared";

type LineSide = "DEBIT" | "CREDIT";

interface LineForm {
  accountId: string;
  side: LineSide;
  amount: string;
  currency: string;
  fxRateEffective: string;
  memo: string;
}

interface JournalEntryModalProps {
  accounts: GeneralLedgerAccount[];
  onClose: () => void;
  onSaved: () => void;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyLine(): LineForm {
  return {
    accountId: "",
    side: "DEBIT",
    amount: "",
    currency: "THB",
    fxRateEffective: "",
    memo: "",
  };
}

const CURRENCY_OPTIONS = ["THB", "USD", "HKD", "CNH"];

export default function JournalEntryModal({
  accounts,
  onClose,
  onSaved,
}: JournalEntryModalProps) {
  const { user } = useAuth();
  const [entryDate, setEntryDate] = useState(today());
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<LineForm[]>([emptyLine(), emptyLine()]);
  const [formError, setFormError] = useState("");
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  const setLine = (index: number, patch: Partial<LineForm>) => {
    setLines((prev) =>
      prev.map((l, i) => (i === index ? { ...l, ...patch } : l))
    );
  };

  const addLine = () => setLines((prev) => [...prev, emptyLine()]);

  const removeLine = (index: number) =>
    setLines((prev) =>
      prev.length > 2 ? prev.filter((_, i) => i !== index) : prev
    );

  const totals = lines.reduce<
    Record<string, { debit: number; credit: number }>
  >((acc, l) => {
    const n = Number(l.amount);
    if (!l.accountId || !Number.isFinite(n)) return acc;
    acc[l.currency] = acc[l.currency] ?? { debit: 0, credit: 0 };
    if (l.side === "DEBIT") acc[l.currency].debit += n;
    else acc[l.currency].credit += n;
    return acc;
  }, {});

  const listInvalidLines = (): string | null => {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.accountId) return `บรรทัดที่ ${i + 1}: กรุณาเลือกบัญชี`;
      if (!/^[A-Z]{3}$/.test(l.currency)) {
        return `บรรทัดที่ ${i + 1}: สกุลเงินต้องเป็นรหัส ISO 3 ตัวอักษร`;
      }
      const n = Number(l.amount);
      if (!Number.isFinite(n) || n <= 0) {
        return `บรรทัดที่ ${i + 1}: กรุณากรอกจำนวนเงินที่มากกว่า 0`;
      }
      if (l.currency !== "THB") {
        const fx = Number(l.fxRateEffective);
        if (l.fxRateEffective.trim() === "" || !Number.isFinite(fx) || fx <= 0) {
          return `บรรทัดที่ ${i + 1}: กรุณากรอกอัตราแลกเปลี่ยนที่มากกว่า 0 (สกุล ${l.currency})`;
        }
      }
    }
    return null;
  };

  const handleSave = async () => {
    if (!entryDate) {
      setFormError("กรุณาเลือกวันที่");
      return;
    }
    if (!description.trim()) {
      setFormError("กรุณากรอกคำอธิบายรายการ");
      return;
    }
    const invalid = listInvalidLines();
    if (invalid) {
      setFormError(invalid);
      return;
    }
    if (!user?.accessToken) return;

    setIsSaving(true);
    setFormError("");
    setServerErrors([]);

    const outcome = await createJournalEntry(user.accessToken, {
      entryDate: entryDate.trim(),
      description: description.trim(),
      lines: lines.map((l) => ({
        accountId: l.accountId,
        currency: l.currency,
        ...(l.side === "DEBIT"
          ? { debit: String(Number(l.amount)) }
          : { credit: String(Number(l.amount)) }),
        ...(l.fxRateEffective.trim() !== ""
          ? { fxRateEffective: l.fxRateEffective.trim() }
          : {}),
        memo: l.memo.trim() || null,
      })),
    });

    if (outcome.ok) {
      setIsSaving(false);
      onSaved();
      return;
    }

    setIsSaving(false);
    setFormError(outcome.message);
    setServerErrors(outcome.errors);
  };

  const handleOutside = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/40 backdrop-blur-sm"
      onClick={handleOutside}
    >
      <div className="w-full max-w-3xl bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[88vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">
              บันทึกรายการบัญชีใหม่
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">
              แต่ละสกุลเงินต้องมียอดเดบิตรวมเท่ากับเครดิตรวม (ระบบลงบัญชีแบบคู่)
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition p-1"
            aria-label="ปิดหน้าต่าง"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">
                วันที่
              </label>
              <input
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                className="w-full px-3 py-2.5 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">
                คำอธิบายรายการ
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="เช่น โอนเข้าเงินทุนนำไปซื้อหุ้น"
                className="w-full px-3 py-2.5 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between pb-1">
              <span className="text-xs font-medium text-gray-500">
                รายการเดินบัญชี
              </span>
              <button
                type="button"
                onClick={addLine}
                className="inline-flex items-center gap-1 bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-2.5 py-1.5 rounded-lg transition"
              >
                <Plus className="w-3 h-3" />
                เพิ่มบรรทัด
              </button>
            </div>

            <div className="hidden sm:grid grid-cols-[1.6fr_1fr_1.2fr_1fr_0.5fr] gap-2 px-1 text-[11px] text-gray-400 font-medium">
              <span>บัญชี</span>
              <span>เดบิต/เครดิต</span>
              <span>จำนวนเงิน</span>
              <span>อัตรา FX (ไม่บังคับ)</span>
              <span />
            </div>

            {lines.map((l, index) => (
              <div key={index} className="space-y-1.5">
                <div className="grid grid-cols-1 sm:grid-cols-[1.6fr_1fr_1.2fr_1fr_0.5fr] gap-2 items-center">
                  <select
                    value={l.accountId}
                    onChange={(e) => {
                      const acc = accounts.find((a) => a.id === e.target.value);
                      setLine(index, {
                        accountId: e.target.value,
                        currency: acc ? acc.currency : l.currency,
                      });
                    }}
                    className="w-full px-3 py-2 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
                  >
                    <option value="">เลือกบัญชี...</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>

                  <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                    {(["DEBIT", "CREDIT"] as LineSide[]).map((side) => (
                      <button
                        key={side}
                        type="button"
                        onClick={() => setLine(index, { side })}
                        className={`flex-1 text-xs font-medium py-2 transition ${
                          l.side === side
                            ? "bg-blue-50 text-blue-900"
                            : "bg-white text-gray-500 hover:bg-gray-50"
                        }`}
                      >
                        {side === "DEBIT" ? "เดบิต" : "เครดิต"}
                      </button>
                    ))}
                  </div>

                  <div>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={l.amount}
                        onChange={(e) =>
                          setLine(index, { amount: e.target.value })
                        }
                        placeholder="0.00"
                        className="w-full px-3 py-2 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
                      />
                      <select
                        value={l.currency}
                        onChange={(e) =>
                          setLine(index, { currency: e.target.value })
                        }
                        className="px-1.5 py-2 text-xs bg-white text-gray-700 border border-gray-200 rounded-lg outline-none transition"
                        title="สกุลเงิน"
                      >
                        {CURRENCY_OPTIONS.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <input
                    type="text"
                    value={l.fxRateEffective}
                    onChange={(e) =>
                      setLine(index, { fxRateEffective: e.target.value })
                    }
                    placeholder="เช่น 35.5 (ถ้า THB เว้นว่าง)"
                    className="w-full px-3 py-2 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
                  />

                  <div className="flex items-center justify-end">
                    <button
                      type="button"
                      onClick={() => removeLine(index)}
                      disabled={lines.length <= 2}
                      className="text-gray-400 hover:text-red-600 transition disabled:opacity-40"
                      aria-label="ลบบรรทัด"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <input
                  type="text"
                  value={l.memo}
                  onChange={(e) => setLine(index, { memo: e.target.value })}
                  placeholder="หมายเหตุประจำบรรทัด (ไม่บังคับ)"
                  className="w-full px-3 py-1.5 text-xs bg-white text-gray-700 border border-gray-100 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/10 focus:border-blue-900 transition"
                />
              </div>
            ))}
          </div>

          {Object.keys(totals).length > 0 && (
            <div className="bg-blue-50/60 rounded-lg px-4 py-3 text-xs text-gray-600">
              {Object.entries(totals).map(([currency, t]) => (
                <div
                  key={currency}
                  className="flex items-center justify-between py-0.5"
                >
                  <span>รวม {currency}</span>
                  <span className="font-medium">
                    เดบิต {formatBaht(t.debit)} · เครดิต {formatBaht(t.credit)}
                  </span>
                </div>
              ))}
              {Object.entries(totals).some(([, t]) =>
                Number((t.debit - t.credit).toFixed(3)) !== 0
              ) && (
                <p className="text-amber-600 mt-1">
                  ยอดเดบิต/เครดิตของบางสกุลเงินยังไม่เท่ากัน ระบบจะไม่อนุมัติ
                  จนกว่าจะสมดุล
                </p>
              )}
            </div>
          )}

          {formError && (
            <div className="px-3 py-2.5 rounded-lg bg-red-50 text-red-600 text-sm">
              {formError}
            </div>
          )}
          {serverErrors.length > 0 && (
            <div className="px-3 py-2.5 rounded-lg bg-red-50 text-red-600 text-sm space-y-1">
              {serverErrors.map((err, i) => (
                <p key={i}>{err}</p>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-100 shrink-0">
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="flex-1 bg-blue-900 hover:bg-blue-950 text-white text-sm font-medium py-2.5 rounded-lg transition disabled:opacity-60"
          >
            {isSaving ? "กำลังบันทึก..." : "บันทึกรายการบัญชี"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-sm font-medium px-4 py-2.5 rounded-lg text-gray-500 hover:bg-gray-50 transition"
          >
            ยกเลิก
          </button>
        </div>
      </div>
    </div>
  );
}