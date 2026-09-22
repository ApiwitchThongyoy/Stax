import { useState, useEffect } from "react";
import {
  X,
  Plus,
  Edit3,
  History,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Info,
  FileText,
} from "lucide-react";
import {
  createStructuredJournalEntry,
  updateJournalEntry,
  fetchJournalEntryDetail,
  type GeneralLedgerJournalEntry,
  type GeneralLedgerAccount,
  type StructuredJournalEntryInput,
  type EditJournalInput,
} from "../../lib/server-api";
import { formatAmount, formatBaht } from "../Ledger/shared";
import {
  isReferenceOnlySkip,
  classifyEntryCategory,
  getEntryExplanation,
} from "../../lib/general-ledger";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 1. Audit History Modal ("ดูประวัติการแก้ไข")
// ---------------------------------------------------------------------------
export function AuditHistoryModal({
  entry,
  accessToken,
  onClose,
}: {
  entry: GeneralLedgerJournalEntry | null;
  accessToken: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<
    Array<{ id: string; action: string; createdAt: string; details: any }>
  >([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!entry) return;
    let isMounted = true;
    setLoading(true);
    setError("");
    fetchJournalEntryDetail(accessToken, entry.id)
      .then((res) => {
        if (isMounted) {
          setHistory(res.history || []);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "โหลดประวัติไม่สำเร็จ");
          setLoading(false);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [entry, accessToken]);

  if (!entry) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0 bg-gray-50/50">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-blue-800" />
            <h3 className="text-sm font-semibold text-gray-800">
              ประวัติการแก้ไขรายการ #{entry.entryNo}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          <div className="bg-blue-50/50 border border-blue-100 rounded-xl p-3 text-xs text-blue-900 space-y-1">
            <p className="font-medium">รายการ: {entry.description}</p>
            <p className="text-blue-700">วันที่: {entry.entryDate} · แหล่งที่มา: {entry.sourceType}</p>
            {entry.updatedAt && entry.updatedAt !== entry.createdAt && (
              <p className="text-blue-600">
                อัปเดตล่าสุดเมื่อ: {new Date(entry.updatedAt).toLocaleString("th-TH")}
              </p>
            )}
          </div>

          {loading ? (
            <div className="py-8 text-center text-sm text-gray-400">กำลังโหลดประวัติ...</div>
          ) : error ? (
            <div className="py-4 text-center text-sm text-red-500">{error}</div>
          ) : history.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">
              ยังไม่มีบันทึกประวัติการแก้ไขสำหรับรายการนี้
            </div>
          ) : (
            <div className="space-y-3">
              {history.map((h, idx) => {
                const details = (h.details ?? {}) as Record<string, any>;
                return (
                  <div
                    key={h.id || idx}
                    className="border border-gray-100 rounded-xl p-4 bg-white shadow-xs space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between border-b border-gray-50 pb-2">
                      <span className="font-semibold text-gray-700">
                        {h.action === "CAPITAL_TRANSACTION_UPDATE"
                          ? "แก้ไขข้อมูลโดยผู้ใช้"
                          : h.action === "JOURNAL_ENTRY_CREATE"
                          ? "สร้างรายการใหม่"
                          : h.action}
                      </span>
                      <span className="text-gray-400">
                        {new Date(h.createdAt).toLocaleString("th-TH")}
                      </span>
                    </div>

                    {details.reason && (
                      <p className="text-gray-600">
                        <span className="font-medium text-gray-500">เหตุผล:</span> {details.reason}
                      </p>
                    )}

                    {details.oldValues && details.newValues && (
                      <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-gray-50">
                        <div className="bg-red-50/40 border border-red-100 rounded-lg p-2.5">
                          <p className="font-medium text-red-800 mb-1">ข้อมูลเดิมก่อนแก้ไข</p>
                          <div className="space-y-0.5 text-gray-600">
                            {details.oldValues.entryDate && (
                              <p>วันที่: {details.oldValues.entryDate}</p>
                            )}
                            {details.oldValues.description && (
                              <p>รายการ: {details.oldValues.description}</p>
                            )}
                            {details.oldValues.amount && (
                              <p>จำนวน: {details.oldValues.amount} {details.oldValues.currency || ""}</p>
                            )}
                            {details.oldValues.symbol && (
                              <p>หุ้น: {details.oldValues.symbol}</p>
                            )}
                            {details.oldValues.note && (
                              <p>หมายเหตุ: {details.oldValues.note}</p>
                            )}
                          </div>
                        </div>

                        <div className="bg-emerald-50/40 border border-emerald-100 rounded-lg p-2.5">
                          <p className="font-medium text-emerald-800 mb-1">ข้อมูลใหม่หลังแก้ไข</p>
                          <div className="space-y-0.5 text-gray-600">
                            {details.newValues.entryDate && (
                              <p>วันที่: {details.newValues.entryDate}</p>
                            )}
                            {details.newValues.description && (
                              <p>รายการ: {details.newValues.description}</p>
                            )}
                            {details.newValues.amount && (
                              <p>จำนวน: {details.newValues.amount} {details.newValues.currency || ""}</p>
                            )}
                            {details.newValues.symbol && (
                              <p>หุ้น: {details.newValues.symbol}</p>
                            )}
                            {details.newValues.note && (
                              <p>หมายเหตุ: {details.newValues.note}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/50 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg transition"
          >
            ปิด
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Edit Journal Entry Modal ("แก้ไข")
// ---------------------------------------------------------------------------
export function EditJournalEntryModal({
  entry,
  accessToken,
  onClose,
  onSuccess,
}: {
  entry: GeneralLedgerJournalEntry | null;
  accessToken: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const [entryDate, setEntryDate] = useState(entry?.entryDate ?? today());
  const [description, setDescription] = useState(entry?.description ?? "");
  const [note, setNote] = useState(entry?.note ?? "");
  const [reason, setReason] = useState("");
  const [symbol, setSymbol] = useState(entry?.detail?.symbol ?? "");
  const [amount, setAmount] = useState(entry?.detail?.amount ?? "");
  const [fees, setFees] = useState(entry?.detail?.fees ?? "");
  const [quantity, setQuantity] = useState(entry?.detail?.quantity ?? "");
  const [unitPrice, setUnitPrice] = useState(entry?.detail?.unitPrice ?? "");

  const [confirmStep, setConfirmStep] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  if (!entry) return null;

  const hasTradeDetail =
    entry.detail.symbol != null ||
    entry.detail.quantity != null ||
    entry.detail.unitPrice != null ||
    entry.detail.fees != null;

  const handleProceedToConfirm = () => {
    if (!entryDate.trim()) {
      setError("กรุณาเลือกวันที่");
      return;
    }
    if (!description.trim()) {
      setError("กรุณากรอกคำอธิบายรายการ");
      return;
    }
    setError("");
    setConfirmStep(true);
  };

  const handleExecuteSave = async () => {
    setIsSaving(true);
    setError("");

    const payload: EditJournalInput = {
      entryDate: entryDate.trim(),
      description: description.trim(),
      note: note.trim() || null,
      reason: reason.trim() || "ผู้ใช้แก้ไขข้อมูลผ่านสมุดรายวัน",
      ...(symbol.trim() ? { symbol: symbol.trim() } : {}),
      ...(amount.trim() ? { amount: amount.trim() } : {}),
      ...(fees.trim() ? { fees: fees.trim() } : {}),
      ...(quantity.trim() ? { quantity: quantity.trim() } : {}),
      ...(unitPrice.trim() ? { unitPrice: unitPrice.trim() } : {}),
    };

    const res = await updateJournalEntry(accessToken, entry.id, payload);
    setIsSaving(false);

    if (res.ok) {
      onSuccess("แก้ไขข้อมูลเรียบร้อยแล้ว");
      onClose();
    } else {
      setConfirmStep(false);
      setError(res.message || res.errors?.join("; ") || "แก้ไขข้อมูลไม่สำเร็จ");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0 bg-gray-50/50">
          <div className="flex items-center gap-2">
            <Edit3 className="w-4 h-4 text-blue-800" />
            <h3 className="text-sm font-semibold text-gray-800">
              {confirmStep ? "ยืนยันการแก้ไขข้อมูล" : `แก้ไขรายการ #${entry.entryNo}`}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!confirmStep ? (
            <div className="space-y-4 text-xs">
              <div>
                <label className="block text-gray-700 font-medium mb-1">วันที่รายการ *</label>
                <input
                  type="date"
                  value={entryDate}
                  onChange={(e) => setEntryDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900"
                />
              </div>

              <div>
                <label className="block text-gray-700 font-medium mb-1">คำอธิบายรายการ *</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900"
                />
              </div>

              {hasTradeDetail && (
                <div className="p-3 bg-gray-50 rounded-xl border border-gray-200/70 space-y-3">
                  <p className="font-semibold text-gray-700">รายละเอียดรายการซื้อขาย</p>
                  <div className="grid grid-cols-2 gap-2">
                    {entry.detail.symbol != null && (
                      <div>
                        <label className="block text-gray-500 text-[11px] mb-0.5">สัญลักษณ์หุ้น</label>
                        <input
                          type="text"
                          value={symbol}
                          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                          className="w-full px-2.5 py-1.5 border border-gray-200 rounded-md bg-white text-xs"
                        />
                      </div>
                    )}
                    {entry.detail.quantity != null && (
                      <div>
                        <label className="block text-gray-500 text-[11px] mb-0.5">จำนวนหุ้น</label>
                        <input
                          type="number"
                          step="any"
                          value={quantity}
                          onChange={(e) => setQuantity(e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-gray-200 rounded-md bg-white text-xs"
                        />
                      </div>
                    )}
                    {entry.detail.unitPrice != null && (
                      <div>
                        <label className="block text-gray-500 text-[11px] mb-0.5">ราคาต่อหน่วย</label>
                        <input
                          type="number"
                          step="any"
                          value={unitPrice}
                          onChange={(e) => setUnitPrice(e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-gray-200 rounded-md bg-white text-xs"
                        />
                      </div>
                    )}
                    {entry.detail.fees != null && (
                      <div>
                        <label className="block text-gray-500 text-[11px] mb-0.5">ค่าธรรมเนียม</label>
                        <input
                          type="number"
                          step="any"
                          value={fees}
                          onChange={(e) => setFees(e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-gray-200 rounded-md bg-white text-xs"
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-gray-700 font-medium mb-1">หมายเหตุบันทึกส่วนตัว</label>
                <textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="บันทึกข้อความช่วยจำสำหรับรายการนี้..."
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900"
                />
              </div>

              <div>
                <label className="block text-gray-700 font-medium mb-1">เหตุผลในการแก้ไข (Audit Note)</label>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="เช่น แก้ไขวันที่ผิด, ปรับแก้คำอธิบายให้ถูกต้อง"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4 text-xs">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 text-amber-900 space-y-1">
                <p className="font-semibold flex items-center gap-1.5 text-amber-800">
                  <AlertTriangle className="w-4 h-4" />
                  ยืนยันการแก้ไขข้อมูลรายการ #{entry.entryNo} (ใช่ / ไม่)
                </p>
                <p className="text-amber-700">
                  การแก้ไขจะถูกบันทึกประวัติการเปลี่ยนแปลง (Audit Log) และระบบจะคำนวณต้นทุน/ยอดบัญชีที่เกี่ยวข้องใหม่อัตโนมัติ
                </p>
              </div>

              <div className="border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">
                <div className="p-3 bg-gray-50 flex items-center justify-between font-medium text-gray-700">
                  <span>ฟิลด์ข้อมูล</span>
                  <div className="flex gap-4">
                    <span className="text-gray-400">ก่อนแก้ไข</span>
                    <span className="text-blue-700 font-semibold">หลังแก้ไข</span>
                  </div>
                </div>

                <div className="p-3 flex items-center justify-between">
                  <span className="text-gray-500 font-medium">วันที่</span>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-400">{entry.entryDate}</span>
                    <ArrowRight className="w-3 h-3 text-gray-300" />
                    <span className="text-gray-800 font-medium">{entryDate}</span>
                  </div>
                </div>

                <div className="p-3 flex items-center justify-between">
                  <span className="text-gray-500 font-medium">คำอธิบาย</span>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-400 truncate max-w-[140px]">{entry.description}</span>
                    <ArrowRight className="w-3 h-3 text-gray-300" />
                    <span className="text-gray-800 font-medium truncate max-w-[140px]">{description}</span>
                  </div>
                </div>

                {symbol !== (entry.detail.symbol ?? "") && (
                  <div className="p-3 flex items-center justify-between">
                    <span className="text-gray-500 font-medium">สัญลักษณ์หุ้น</span>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400">{entry.detail.symbol || "-"}</span>
                      <ArrowRight className="w-3 h-3 text-gray-300" />
                      <span className="text-gray-800 font-medium">{symbol}</span>
                    </div>
                  </div>
                )}

                {quantity !== (entry.detail.quantity ?? "") && (
                  <div className="p-3 flex items-center justify-between">
                    <span className="text-gray-500 font-medium">จำนวนหุ้น</span>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400">{entry.detail.quantity || "-"}</span>
                      <ArrowRight className="w-3 h-3 text-gray-300" />
                      <span className="text-gray-800 font-medium">{quantity}</span>
                    </div>
                  </div>
                )}

                {note !== (entry.note ?? "") && (
                  <div className="p-3 flex items-center justify-between">
                    <span className="text-gray-500 font-medium">หมายเหตุ</span>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400 truncate max-w-[140px]">{entry.note || "-"}</span>
                      <ArrowRight className="w-3 h-3 text-gray-300" />
                      <span className="text-gray-800 font-medium truncate max-w-[140px]">{note || "-"}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer Buttons */}
        <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/50 flex justify-end gap-2">
          {!confirmStep ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg transition"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={handleProceedToConfirm}
                className="px-4 py-2 text-xs font-medium text-white bg-blue-900 hover:bg-blue-800 rounded-lg shadow-sm transition"
              >
                ตรวจสอบข้อมูล
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={isSaving}
                onClick={() => setConfirmStep(false)}
                className="px-4 py-2 text-xs font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg transition"
              >
                ไม่ (ยกเลิก)
              </button>
              <button
                type="button"
                disabled={isSaving}
                onClick={handleExecuteSave}
                className="px-4 py-2 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-600 rounded-lg shadow-sm transition flex items-center gap-1.5"
              >
                {isSaving ? "กำลังบันทึก..." : "ใช่ (ยืนยันการแก้ไขข้อมูล)"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Structured Manual Entry Modal ("+ เพิ่มรายการเอง")
// ---------------------------------------------------------------------------
export type TransactionType =
  | "BUY"
  | "SELL"
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "FX"
  | "DIVIDEND"
  | "INTEREST"
  | "FEE"
  | "TAX"
  | "VAT"
  | "GAIN_LOSS"
  | "CUSTOM";

const TYPE_OPTIONS: { id: TransactionType; label: string }[] = [
  { id: "BUY", label: "ซื้อหุ้น (BUY)" },
  { id: "SELL", label: "ขายหุ้น (SELL)" },
  { id: "DEPOSIT", label: "ฝากเงินเข้า (Deposit)" },
  { id: "WITHDRAWAL", label: "ถอนเงินออก (Withdrawal)" },
  { id: "FX", label: "แลกเปลี่ยนเงินตรา (FX)" },
  { id: "DIVIDEND", label: "เงินปันผล (Dividend)" },
  { id: "INTEREST", label: "ดอกเบี้ยรับ (Interest)" },
  { id: "FEE", label: "ค่าธรรมเนียม (Fee)" },
  { id: "VAT", label: "ภาษีมูลค่าเพิ่ม (VAT)" },
  { id: "TAX", label: "ภาษี (Tax)" },
  { id: "GAIN_LOSS", label: "กำไร/ขาดทุน (Gain / Loss)" },
  { id: "CUSTOM", label: "กำหนดเอง (Custom)" },
];

export function ManualJournalEntryModal({
  isOpen,
  accessToken,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  accessToken: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const [type, setType] = useState<TransactionType>("BUY");
  const [entryDate, setEntryDate] = useState(today());
  const [description, setDescription] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [amount, setAmount] = useState("");
  const [fxRate, setFxRate] = useState("35.0");
  const [symbol, setSymbol] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [fees, setFees] = useState("");
  const [whtAmount, setWhtAmount] = useState("");
  const [fromCurrency, setFromCurrency] = useState("THB");
  const [fromAmount, setFromAmount] = useState("");
  const [toCurrency, setToCurrency] = useState("USD");
  const [toAmount, setToAmount] = useState("");
  const [note, setNote] = useState("");

  const [confirmStep, setConfirmStep] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  if (!isOpen) return null;

  const handleTypeChange = (newType: TransactionType) => {
    setType(newType);
    setError("");
    if (newType === "BUY" && !description) setDescription("ซื้อหุ้น");
    if (newType === "SELL" && !description) setDescription("ขายหุ้น");
    if (newType === "DEPOSIT" && !description) setDescription("ฝากเงินเข้าบัญชี");
    if (newType === "WITHDRAWAL" && !description) setDescription("ถอนเงินจากบัญชี");
    if (newType === "FX" && !description) setDescription("แลกเปลี่ยนเงินตรา");
    if (newType === "DIVIDEND" && !description) setDescription("รับเงินปันผล");
    if (newType === "INTEREST" && !description) setDescription("รับดอกเบี้ย");
    if (newType === "FEE" && !description) setDescription("ค่าธรรมเนียม");
    if (newType === "VAT" && !description) setDescription("ภาษีมูลค่าเพิ่ม (VAT)");
    if (newType === "TAX" && !description) setDescription("ภาษีหัก ณ ที่จ่าย");
    if (newType === "GAIN_LOSS" && !description) setDescription("กำไร/ขาดทุนจากการลงทุน");
    if (newType === "CUSTOM" && !description) setDescription("รายการทั่วไป");
  };

  const handleValidateBeforeConfirm = () => {
    if (!entryDate.trim()) {
      setError("กรุณาเลือกวันที่");
      return;
    }
    if (!description.trim()) {
      setError("กรุณากรอกคำอธิบายรายการ");
      return;
    }
    if (type === "BUY" || type === "SELL") {
      if (!symbol.trim()) {
        setError("กรุณากรอกสัญลักษณ์หุ้น");
        return;
      }
      if (!quantity.trim() || Number(quantity) <= 0) {
        setError("กรุณากรอกจำนวนหุ้นที่มากกว่า 0");
        return;
      }
      if (!unitPrice.trim() || Number(unitPrice) <= 0) {
        setError("กรุณากรอกราคาต่อหุ้นที่มากกว่า 0");
        return;
      }
    } else if (type === "FX") {
      if (!fromAmount.trim() || Number(fromAmount) <= 0) {
        setError("กรุณากรอกจำนวนเงินที่แลกเปลี่ยนออก");
        return;
      }
      if (!toAmount.trim() || Number(toAmount) <= 0) {
        setError("กรุณากรอกจำนวนเงินที่ได้รับเข้า");
        return;
      }
    } else {
      if (!amount.trim() || Number(amount) <= 0) {
        setError("กรุณากรอกจำนวนเงินที่มากกว่า 0");
        return;
      }
    }

    setError("");
    setConfirmStep(true);
  };

  const handleExecuteSave = async () => {
    setIsSaving(true);
    setError("");

    const payload: StructuredJournalEntryInput = {
      transactionType: type,
      entryDate: entryDate.trim(),
      description: description.trim(),
      currency: currency.trim().toUpperCase(),
      fxRateEffective: fxRate.trim() || "1",
      symbol: symbol.trim() || undefined,
      quantity: quantity.trim() || undefined,
      unitPrice: unitPrice.trim() || undefined,
      amount: amount.trim() || undefined,
      fees: fees.trim() || undefined,
      whtAmount: whtAmount.trim() || undefined,
      fromCurrency: fromCurrency.trim().toUpperCase(),
      fromAmount: fromAmount.trim() || undefined,
      toCurrency: toCurrency.trim().toUpperCase(),
      toAmount: toAmount.trim() || undefined,
      exchangeRate: fxRate.trim() || undefined,
      note: note.trim() || undefined,
    };

    const res = await createStructuredJournalEntry(accessToken, payload);
    setIsSaving(false);

    if (res.ok) {
      const successMessage =
        type === "BUY"
          ? "เพิ่มรายการเรียบร้อยแล้ว และคำนวณต้นทุนรายการขายที่เกี่ยวข้องใหม่แล้ว"
          : "เพิ่มรายการเรียบร้อยแล้ว";
      onSuccess(successMessage);
      onClose();
    } else {
      setConfirmStep(false);
      setError(res.message || res.errors?.join("; ") || "เพิ่มรายการไม่สำเร็จ");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0 bg-gray-50/50">
          <div className="flex items-center gap-2">
            <Plus className="w-4 h-4 text-blue-800" />
            <h3 className="text-sm font-semibold text-gray-800">
              {confirmStep ? "ยืนยันการเพิ่มรายการ" : "เพิ่มรายการเอง (+ บันทึกรายวัน)"}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!confirmStep ? (
            <div className="space-y-4 text-xs">
              {/* Type Picker */}
              <div>
                <label className="block text-gray-700 font-medium mb-1.5">
                  ประเภทธุรกรรม *
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {TYPE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => handleTypeChange(opt.id)}
                      className={`px-2.5 py-1.5 rounded-lg font-medium transition ${
                        type === opt.id
                          ? "bg-blue-900 text-white shadow-xs"
                          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Date & Description */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-gray-700 font-medium mb-1">วันที่ *</label>
                  <input
                    type="date"
                    value={entryDate}
                    onChange={(e) => setEntryDate(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20"
                  />
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">คำอธิบายรายการ *</label>
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="เช่น ซื้อหุ้น AAPL, ฝากเงิน"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20"
                  />
                </div>
              </div>

              {/* Specific fields depending on type */}
              {(type === "BUY" || type === "SELL") && (
                <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 space-y-3">
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-gray-600 font-medium mb-0.5">หุ้น (Symbol) *</label>
                      <input
                        type="text"
                        value={symbol}
                        onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                        placeholder="เช่น AAPL"
                        className="w-full px-2.5 py-1.5 border border-gray-200 rounded-md bg-white text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-600 font-medium mb-0.5">จำนวนหุ้น *</label>
                      <input
                        type="number"
                        step="any"
                        value={quantity}
                        onChange={(e) => setQuantity(e.target.value)}
                        placeholder="10"
                        className="w-full px-2.5 py-1.5 border border-gray-200 rounded-md bg-white text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-600 font-medium mb-0.5">ราคาต่อหุ้น *</label>
                      <input
                        type="number"
                        step="any"
                        value={unitPrice}
                        onChange={(e) => setUnitPrice(e.target.value)}
                        placeholder="150.00"
                        className="w-full px-2.5 py-1.5 border border-gray-200 rounded-md bg-white text-xs"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-gray-600 font-medium mb-0.5">สกุลเงิน</label>
                      <select
                        value={currency}
                        onChange={(e) => setCurrency(e.target.value)}
                        className="w-full px-2.5 py-1.5 border border-gray-200 rounded-md bg-white text-xs"
                      >
                        <option value="USD">USD</option>
                        <option value="THB">THB</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-gray-600 font-medium mb-0.5">ค่าธรรมเนียม</label>
                      <input
                        type="number"
                        step="any"
                        value={fees}
                        onChange={(e) => setFees(e.target.value)}
                        placeholder="0.00"
                        className="w-full px-2.5 py-1.5 border border-gray-200 rounded-md bg-white text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-600 font-medium mb-0.5">อัตราแลกเปลี่ยน THB</label>
                      <input
                        type="number"
                        step="any"
                        value={fxRate}
                        onChange={(e) => setFxRate(e.target.value)}
                        placeholder="35.0"
                        className="w-full px-2.5 py-1.5 border border-gray-200 rounded-md bg-white text-xs"
                      />
                    </div>
                  </div>
                  {type === "BUY" && (
                    <div className="p-2.5 bg-blue-50/80 border border-blue-200 rounded-lg text-blue-800 text-[11px] flex items-start gap-2">
                      <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-blue-600" />
                      <span>การเพิ่มรายการซื้อย้อนหลังจะถูกนำไปคำนวณต้นทุนของรายการขายภายหลังโดยอัตโนมัติ</span>
                    </div>
                  )}
                </div>
              )}

              {type === "FX" && (
                <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <label className="block text-gray-600 font-medium">แลกเปลี่ยนออก (From)</label>
                      <div className="flex gap-2">
                        <select
                          value={fromCurrency}
                          onChange={(e) => setFromCurrency(e.target.value)}
                          className="w-24 px-2 py-1.5 border border-gray-200 rounded-md bg-white"
                        >
                          <option value="THB">THB</option>
                          <option value="USD">USD</option>
                        </select>
                        <input
                          type="number"
                          step="any"
                          value={fromAmount}
                          onChange={(e) => setFromAmount(e.target.value)}
                          placeholder="จำนวนเงินออก"
                          className="flex-1 px-2.5 py-1.5 border border-gray-200 rounded-md bg-white"
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="block text-gray-600 font-medium">แลกเปลี่ยนเข้า (To)</label>
                      <div className="flex gap-2">
                        <select
                          value={toCurrency}
                          onChange={(e) => setToCurrency(e.target.value)}
                          className="w-24 px-2 py-1.5 border border-gray-200 rounded-md bg-white"
                        >
                          <option value="USD">USD</option>
                          <option value="THB">THB</option>
                        </select>
                        <input
                          type="number"
                          step="any"
                          value={toAmount}
                          onChange={(e) => setToAmount(e.target.value)}
                          placeholder="จำนวนเงินเข้า"
                          className="flex-1 px-2.5 py-1.5 border border-gray-200 rounded-md bg-white"
                        />
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className="block text-gray-600 font-medium mb-1">อัตราแลกเปลี่ยน (Exchange Rate)</label>
                    <input
                      type="number"
                      step="any"
                      value={fxRate}
                      onChange={(e) => setFxRate(e.target.value)}
                      placeholder="เช่น 35.0"
                      className="w-full px-2.5 py-1.5 border border-gray-200 rounded-md bg-white"
                    />
                  </div>
                </div>
              )}

              {type !== "BUY" && type !== "SELL" && type !== "FX" && (
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-gray-700 font-medium mb-1">จำนวนเงิน *</label>
                    <input
                      type="number"
                      step="any"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-2.5 py-2 border border-gray-200 rounded-lg outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-gray-700 font-medium mb-1">สกุลเงิน</label>
                    <select
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                      className="w-full px-2.5 py-2 border border-gray-200 rounded-lg bg-white"
                    >
                      <option value="THB">THB</option>
                      <option value="USD">USD</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-gray-700 font-medium mb-1">อัตราแลกเปลี่ยน THB</label>
                    <input
                      type="number"
                      step="any"
                      value={fxRate}
                      onChange={(e) => setFxRate(e.target.value)}
                      placeholder="35.0"
                      className="w-full px-2.5 py-2 border border-gray-200 rounded-lg outline-none"
                    />
                  </div>
                </div>
              )}

              {(type === "DIVIDEND" || type === "INTEREST") && (
                <div>
                  <label className="block text-gray-700 font-medium mb-1">ภาษีหัก ณ ที่จ่าย (WHT ถ้ามี)</label>
                  <input
                    type="number"
                    step="any"
                    value={whtAmount}
                    onChange={(e) => setWhtAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-2.5 py-2 border border-gray-200 rounded-lg outline-none"
                  />
                </div>
              )}

              <div>
                <label className="block text-gray-700 font-medium mb-1">หมายเหตุบันทึกส่วนตัว</label>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="ข้อความช่วยจำ..."
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg outline-none"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4 text-xs">
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3.5 text-emerald-900 space-y-1">
                <p className="font-semibold flex items-center gap-1.5 text-emerald-800">
                  <CheckCircle2 className="w-4 h-4" />
                  ยืนยันการเพิ่มรายการบัญชี
                </p>
                <p className="text-emerald-700">
                  ระบบจะสร้างคู่รายการเดบิต/เครดิตตามมาตรฐานการบัญชี (GAAP) และลงบัญชีแยกประเภทให้อัตโนมัติ
                </p>
              </div>

              <div className="border border-gray-200 rounded-xl p-3.5 bg-gray-50 space-y-2">
                <p><span className="text-gray-500">ประเภท:</span> <span className="font-semibold text-gray-800">{TYPE_OPTIONS.find((o) => o.id === type)?.label}</span></p>
                <p><span className="text-gray-500">วันที่:</span> <span className="font-semibold text-gray-800">{entryDate}</span></p>
                <p><span className="text-gray-500">คำอธิบาย:</span> <span className="font-semibold text-gray-800">{description}</span></p>
                {symbol && <p><span className="text-gray-500">หุ้น:</span> <span className="font-semibold text-gray-800">{symbol} ({quantity} หุ้น @ {unitPrice})</span></p>}
                {amount && <p><span className="text-gray-500">จำนวนเงิน:</span> <span className="font-semibold text-gray-800">{amount} {currency}</span></p>}
                {fromAmount && <p><span className="text-gray-500">แลกเปลี่ยน:</span> <span className="font-semibold text-gray-800">{fromAmount} {fromCurrency} → {toAmount} {toCurrency}</span></p>}
              </div>
            </div>
          )}
        </div>

        {/* Footer Buttons */}
        <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/50 flex justify-end gap-2">
          {!confirmStep ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg transition"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={handleValidateBeforeConfirm}
                className="px-4 py-2 text-xs font-medium text-white bg-blue-900 hover:bg-blue-800 rounded-lg shadow-sm transition"
              >
                ตรวจสอบข้อมูล
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={isSaving}
                onClick={() => setConfirmStep(false)}
                className="px-4 py-2 text-xs font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg transition"
              >
                ย้อนกลับ
              </button>
              <button
                type="button"
                disabled={isSaving}
                onClick={handleExecuteSave}
                className="px-4 py-2 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-600 rounded-lg shadow-sm transition flex items-center gap-1.5"
              >
                {isSaving ? "กำลังบันทึก..." : "ยืนยันการเพิ่มรายการ"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Journal Note Modal ("หมายเหตุรายการ")
// ---------------------------------------------------------------------------
export function JournalNoteModal({
  entry,
  onClose,
}: {
  entry: GeneralLedgerJournalEntry | null;
  onClose: () => void;
}) {
  if (!entry) return null;

  const noteInfo = getEntryExplanation(entry);
  const catInfo = classifyEntryCategory(entry);
  const isRef = entry.postingState === "SKIPPED" && isReferenceOnlySkip(entry.skipReason);
  const isSkipped = entry.postingState === "SKIPPED";
  const userNote = noteInfo.userNote || entry.note?.trim() || null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0 bg-gray-50/50">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-amber-700" />
            <h3 className="text-sm font-semibold text-gray-800">
              หมายเหตุรายการ #{entry.entryNo}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {/* Metadata Card */}
          <div className="bg-gray-50 border border-gray-200/70 rounded-xl p-3 text-xs space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-gray-800 text-sm">
                {entry.description}
              </span>
              <span className="inline-flex items-center text-xs px-2 py-0.5 rounded-md font-medium bg-white text-gray-700 border border-gray-200">
                {catInfo.label}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-gray-500 pt-1 border-t border-gray-200/50">
              <span>วันที่: <strong className="text-gray-700 font-medium">{entry.entryDate}</strong></span>
              <span>แหล่งที่มา: <strong className="text-gray-700 font-medium">{entry.sourceType}</strong></span>
              {entry.detail?.symbol && (
                <span>หุ้น/สินทรัพย์: <strong className="text-gray-700 font-medium">{entry.detail.symbol}</strong></span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="text-gray-500">สถานะ:</span>
              {isSkipped ? (
                isRef ? (
                  <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200">
                    บันทึกแล้ว (รายการอ้างอิง)
                  </span>
                ) : (
                  <>
                    <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                      บันทึกแล้ว (ยังไม่มีคู่บัญชี)
                    </span>
                    <span className="inline-flex items-center text-xs font-medium px-1.5 py-0.5 rounded-md bg-amber-100/70 text-amber-800 border border-amber-200">
                      ต้องตรวจสอบ
                    </span>
                  </>
                )
              ) : (
                <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                  ลงบัญชีแล้ว
                </span>
              )}
            </div>
          </div>

          {/* Detailed Explanations */}
          {isRef && (
            <div className="bg-blue-50/70 border border-blue-200 rounded-xl p-4 space-y-2 text-xs text-blue-900">
              <div className="flex items-center gap-1.5 font-semibold text-blue-800">
                <Info className="w-4 h-4 text-blue-700 shrink-0" />
                <span>คำอธิบายรายการอ้างอิง (Reference-Only)</span>
              </div>
              <p className="font-medium text-blue-800 leading-relaxed">
                บันทึกครบแล้ว: ผลกระทบทางบัญชีถูกบันทึกผ่านรายการหลักแล้ว จึงไม่ลงเดบิต/เครดิตซ้ำ
              </p>
              <p className="text-blue-700 leading-relaxed">
                รายการนี้ถูกบันทึกไว้ในสมุดรายวันเพื่อเป็นหลักฐานอ้างอิงที่สอดคล้องกับเอกสาร Statement ครบถ้วน โดยไม่มีการลงบัญชีคู่ซ้ำซ้อน เพื่อป้องกันไม่ให้กระทบยอดเงินและกำไรขาดทุนซ้ำ
              </p>
              {entry.skipReason && (
                <div className="mt-2 pt-2 border-t border-blue-200/60 text-[11px] text-blue-700/80">
                  <span className="font-medium text-blue-800">รายละเอียดระบบ: </span>
                  {entry.skipReason}
                </div>
              )}
            </div>
          )}

          {isSkipped && !isRef && (
            <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-4 space-y-2 text-xs text-amber-900">
              <div className="flex items-center gap-1.5 font-semibold text-amber-800">
                <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                <span>คำอธิบายทางบัญชี / ข้อมูลการลงบัญชี</span>
              </div>
              <p className="leading-relaxed">
                <span className="font-semibold text-amber-800">บันทึกในสมุดรายวันแล้ว:</span>{" "}
                {entry.skipReason === "backfilled-record-only"
                  ? "ข้อมูลเก่า — นำเข้าก่อนระบบลงบัญชีอัตโนมัติ ยังไม่มีรายการบัญชีคู่"
                  : entry.skipReason || "ยังไม่มีคู่รายการเดบิต/เครดิต"}
              </p>
              <p className="text-amber-700/90 leading-relaxed">
                รายการนี้ถูกบันทึกในระบบเรียบร้อยแล้ว แต่ยังไม่สามารถลงเดบิต/เครดิตอัตโนมัติได้ (เช่น ต้องคำนวณต้นทุนหรือจับคู่รายการก่อน)
              </p>
            </div>
          )}

          {userNote && (
            <div className="bg-purple-50/60 border border-purple-200 rounded-xl p-3.5 space-y-1 text-xs text-purple-900">
              <span className="font-semibold text-purple-800">บันทึกช่วยจำ (User Note):</span>
              <p className="whitespace-pre-wrap leading-relaxed">{userNote}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-5 py-3 border-t border-gray-100 bg-gray-50/50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg transition"
          >
            ปิด
          </button>
        </div>
      </div>
    </div>
  );
}
