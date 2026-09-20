import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Plus, X, Landmark, ArrowLeft, Wallet, Percent, Receipt, PiggyBank, Table2, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  useSuspendedAccount,
  flagSuspendedFromResponse,
} from "../../lib/suspended-account";
import {
  fetchAccountLedger,
  fetchAccountCategorySummary,
  fetchUserTransaction,
  type CapitalLedgerRow,
  type GeneralLedgerAccount,
  type GeneralLedgerAccountCategoryRow,
  type GeneralLedgerAccountCategorySummary,
  type GeneralLedgerAccountType,
  type GeneralLedgerLineView,
  type GeneralLedgerSymbolSummary,
} from "../../lib/server-api";
import {
  AccountTypeBadge,
  formatAmount,
  formatSignedAmount,
  PeriodFilter,
  defaultPeriod,
  LoadingRows,
  ErrorBox,
  EmptyState,
  SourceBadge,
  Panel,
} from "../Ledger/shared";
import { CATEGORIES, type CategoryDef } from "./GeneralLedgerNew";

const CURRENCY_OPTIONS = ["THB", "USD", "HKD", "CNH"];

// Icon map ที่ตรงกับ category def
const CATEGORY_ICON: Record<string, typeof Wallet> = {
  wallet: Wallet,
  landmark: Landmark,
  percent: Percent,
  receipt: Receipt,
  piggy: PiggyBank,
};

interface AccountCategoryViewProps {
  type: GeneralLedgerAccountType;
  activeTab: string;
  onSelectTab: (tab: string) => void;
}

interface AddForm {
  code: string;
  name: string;
  type: string;
  currency: string;
}

function emptyAddForm(defaultType: string): AddForm {
  return { code: "", name: "", type: defaultType, currency: "THB" };
}

/** One definition row on the transaction-record page (server fields verbatim). */
function TxField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-3 border-b border-gray-50 last:border-0">
      <span className="text-xs text-gray-400 whitespace-nowrap">{label}</span>
      <span className="text-sm text-gray-800 font-medium text-right break-all">
        {children}
      </span>
    </div>
  );
}

/** Money fields read straight from the record (raw else "-"). */
function showMoney(value?: string | null): string {
  if (value == null || value === "") return "-";
  if (/^-?\d+(\.\d+)?$/.test(value)) return formatAmount(value);
  return value;
}

/** สรุปตามหมวด: ฝั่งขาย/ซื้อ ตัวใหญ่ */
function sideLabelFor(rec: CapitalLedgerRow): string | null {
  if (rec.side === "BUY") return "ซื้อ (BUY)";
  if (rec.side === "SELL") return "ขาย (SELL)";
  return null;
}

/**
 * แสดงเฉพาะฟิลด์ที่เกี่ยวข้องกับหมวดของรายการ (BUY/SELL/CASH) เพื่อลด "-"
 * ที่ไม่มีความหมาย — ค่า server มาครบทุกตัว แต่ render เฉพาะที่บันทึกไว้จริง.
 */
function txRecordFields(rec: CapitalLedgerRow): { label: string; value: string }[] {
  const f: { label: string; value: string }[] = [];
  f.push({ label: "วันที่", value: rec.transactionDate ?? "-" });
  f.push({ label: "หุ้น", value: rec.symbol ?? "-" });
  f.push({ label: "ฝั่ง", value: sideLabelFor(rec) ?? "-" });
  if (rec.quantity != null) f.push({ label: "จำนวน", value: rec.quantity });
  if (rec.unitPrice != null) f.push({ label: "ราคา/หน่วย", value: showMoney(rec.unitPrice) });
  if (rec.grossAmount != null) f.push({ label: "ราคารวม", value: showMoney(rec.grossAmount) });
  if (rec.fees != null) f.push({ label: "ค่าธรรมเนียม", value: showMoney(rec.fees) });
  const flow =
    rec.type === "CASH_IN"
      ? "เงินเข้า (CASH_IN)"
      : rec.type === "CASH_OUT"
        ? "เงินออก (CASH_OUT)"
        : null;
  if (flow) f.push({ label: "เงินเข้า-ออก", value: flow });
  if (rec.amountForeign != null) {
    f.push({
      label: "จำนวนเงิน (สกุล)",
      value: `${showMoney(rec.amountForeign)} ${rec.currency ?? ""}`.trim(),
    });
  }
  if (rec.amountThb != null) f.push({ label: "จำนวนเงิน (บาท)", value: showMoney(rec.amountThb) });
  if (rec.fxRateStatement != null) f.push({ label: "อัตราจาก Statement", value: rec.fxRateStatement });
  if (rec.fxRateEffective != null) f.push({ label: "อัตราที่ใช้จริง", value: rec.fxRateEffective });
  if (rec.costBasis != null) f.push({ label: "ต้นทุน", value: showMoney(rec.costBasis) });
  if (rec.realizedGainLoss != null) f.push({ label: "กำไร/ขาดทุน", value: showMoney(rec.realizedGainLoss) });
  if (rec.realizedGainLossThb != null) {
    f.push({ label: "กำไร/ขาดทุน (บาท)", value: showMoney(rec.realizedGainLossThb) });
  }
  if (rec.category != null && rec.category !== "") f.push({ label: "หมวดข้อมูล", value: rec.category });
  if (rec.section != null && rec.section !== "") f.push({ label: "ส่วนข้อมูล", value: rec.section });
  if (rec.exchange != null && rec.exchange !== "") f.push({ label: "ตลาด", value: rec.exchange });
  return f;
}

export default function AccountCategoryView({
  type,
  activeTab,
  onSelectTab,
}: AccountCategoryViewProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { suspended, markSuspended } = useSuspendedAccount();

  const [accounts, setAccounts] = useState<GeneralLedgerAccount[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "success" | "error">(
    "loading"
  );
  const [loadError, setLoadError] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState<AddForm>(emptyAddForm(type));
  const [formError, setFormError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  // Batch ledger summary for THIS category loaded with ONE request (no N+1).
  const [categorySummary, setCategorySummary] =
    useState<GeneralLedgerAccountCategorySummary | null>(null);
  const summaryRows = useMemo(() => {
    const m = new Map<string, GeneralLedgerAccountCategoryRow>();
    for (const r of categorySummary?.summary.rows ?? []) m.set(r.accountId, r);
    return m;
  }, [categorySummary]);
  const categoryTotals = categorySummary?.summary.totalsByCurrency ?? [];
  const [categoryPeriod, setCategoryPeriod] = useState(defaultPeriod);
  const [categoryRange, setCategoryRange] = useState(categoryPeriod);
  const categoryRequest = useRef(0);

  // ---- ดูรายละเอียดบัญชี (account ledger) ----
  const [selected, setSelected] = useState<GeneralLedgerAccount | null>(null);
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState(defaultPeriod());
  const [appliedFrom, setAppliedFrom] = useState(period.from);
  const [appliedTo, setAppliedTo] = useState(period.to);
  const [opening, setOpening] = useState("0");
  const [movement, setMovement] = useState("0");
  const [closing, setClosing] = useState("0");
  const [lines, setLines] = useState<GeneralLedgerLineView[]>([]);
  const [symbolSummary, setSymbolSummary] = useState<
    GeneralLedgerSymbolSummary[]
  >([]);
  const [detailState, setDetailState] = useState<"loading" | "success" | "error">(
    "loading"
  );
  const [detailError, setDetailError] = useState("");

  // ---- ดูบันทึกธุรกรรมต้นทางของรายการ ----
  const [selectedTxId, setSelectedTxId] = useState<string | null>(null);
  const [txRecord, setTxRecord] = useState<CapitalLedgerRow | null>(null);
  const [txState, setTxState] = useState<"loading" | "success" | "error">(
    "loading"
  );
  const [txError, setTxError] = useState("");

  // รายการธุรกรรมที่ view ได้ในหน้านี้ (เฉพาะแถวที่มี sourceTransactionId)
  // เรียงตามลำดับตาราง → ปุ่ม ก่อนหน้า/ถัดไป ไล่ดูได้โดยไม่ต้องกลับไปกลับมา
  const linkedTxIds = useMemo(
    () =>
      lines
        .map((l) => l.sourceTransactionId)
        .filter((id): id is string => id != null),
    [lines]
  );
  const txIndex = selectedTxId ? linkedTxIds.indexOf(selectedTxId) : -1;
  const goToTx = useCallback(
    (index: number) => {
      const id = linkedTxIds[index];
      if (id) setSelectedTxId(id);
    },
    [linkedTxIds]
  );

  const cat: CategoryDef | undefined = CATEGORIES.find((c) => c.id === type);
  const accent = cat?.accent ?? "from-blue-900 to-blue-950";
  const label = cat?.label ?? type;

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
    const requestId = ++categoryRequest.current;
    setLoadState("loading");
    setCategorySummary(null);
    setLoadError("");
    try {
      const summary = await fetchAccountCategorySummary(
          user.accessToken,
          type,
          categoryRange.from,
          categoryRange.to
        );
      if (requestId !== categoryRequest.current) return;
      setAccounts(summary.accounts);
      setCategorySummary(summary);
      setLoadState("success");
    } catch {
      if (requestId !== categoryRequest.current) return;
      setLoadState("error");
      setLoadError("ดึงผังบัญชีไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    }
  }, [user?.accessToken, suspended, type, categoryRange]);

  useEffect(() => {
    setSelected(null);
    setForm(emptyAddForm(type));
    setFormError("");
    void loadAccounts();
    return () => { categoryRequest.current++; };
  }, [type, loadAccounts]);

  // ---- ดูรายละเอียดบัญชี ----
  const loadDetail = useCallback(async () => {
    if (!selected || !user?.accessToken) return;
    setDetailState("loading");
    setDetailError("");
    setSelectedTxId(null);
    setTxRecord(null);
    try {
      const data = await fetchAccountLedger(
        user.accessToken,
        selected.id,
        appliedFrom,
        appliedTo
      );
      setOpening(data.opening);
      setMovement(data.movement);
      setClosing(data.closing);
      setLines(data.lines);
      setSymbolSummary(data.symbolSummary);
      setDetailState("success");
    } catch {
      setDetailState("error");
      setDetailError("ดึงยอดรายบัญชีไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    }
  }, [selected, user?.accessToken, appliedFrom, appliedTo]);

  useEffect(() => {
    if (selected) void loadDetail();
  }, [selected, loadDetail]);

  // ---- ดึงบันทึกธุรกรรมต้นทางของรายการ (server-authoritative, owner-scoped) ----
  const loadTxRecord = useCallback(async () => {
    if (!selectedTxId || !user?.accessToken) return;
    setTxState("loading");
    setTxError("");
    setTxRecord(null);
    try {
      setTxRecord(await fetchUserTransaction(user.accessToken, selectedTxId));
      setTxState("success");
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      setTxState("error");
      setTxError(
        message && message.toLowerCase().includes("record not found")
          ? "ไม่พบบันทึกธุรกรรมนี้ (อาจถูกลบไปแล้ว)"
          : "โหลดบันทึกธุรกรรมไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"
      );
    }
  }, [selectedTxId, user?.accessToken]);

  useEffect(() => {
    if (selectedTxId) void loadTxRecord();
  }, [selectedTxId, loadTxRecord]);

  // ---- เพิ่มบัญชี ----
  const openModal = () => {
    setForm(emptyAddForm(type));
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

    void loadAccounts();
    setIsSaving(false);
    closeModal();
  };

  // ถ้ากำลังดูธุรกรรมรายการเดียว → หน้าเต็ม "บันทึกธุรกรรม" (ใน tab GL)
  if (selectedTxId) {
    const rec = txRecord;
    const backLabel = selected?.name
      ? `กลับไป${selected.name}`
      : "กลับไปรายการบัญชี";
    return (
      <>
        <button
          type="button"
          onClick={() => setSelectedTxId(null)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-800 hover:underline"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          {backLabel}
        </button>

        <div className={`bg-linear-to-br ${accent} rounded-2xl px-6 py-5 text-white mt-4`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              {rec && sideLabelFor(rec) && (
                <span
                  className={`inline-flex items-center text-xs font-medium px-2 py-1 rounded-full mb-2 ${
                    rec.side === "SELL"
                      ? "bg-red-300/20 text-white"
                      : "bg-emerald-300/20 text-white"
                  }`}
                >
                  {sideLabelFor(rec)}
                </span>
              )}
              <h1 className="text-xl font-semibold mb-1">
                บันทึกธุรกรรม{rec?.transactionDate ? ` · ${rec.transactionDate}` : ""}
              </h1>
              <p className="text-sm text-white/80">
                {selected?.name ?? "รายการ"}
                {rec && rec.symbol ? ` · ${rec.symbol}` : ""}
              </p>
            </div>
            {linkedTxIds.length > 1 && (
              <div className="flex items-center gap-2 bg-black/10 rounded-xl px-3 py-2">
                <button
                  type="button"
                  onClick={() => txIndex > 0 && goToTx(txIndex - 1)}
                  disabled={txIndex <= 0}
                  className="inline-flex items-center gap-1 text-xs font-medium text-white hover:underline disabled:text-white/40 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  ก่อนหน้า
                </button>
                <span className="text-xs text-white/80">
                  รายการที่ {txIndex + 1} / {linkedTxIds.length}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    txIndex >= 0 &&
                    txIndex < linkedTxIds.length - 1 &&
                    goToTx(txIndex + 1)
                  }
                  disabled={txIndex < 0 || txIndex >= linkedTxIds.length - 1}
                  className="inline-flex items-center gap-1 text-xs font-medium text-white hover:underline disabled:text-white/40 disabled:cursor-not-allowed"
                >
                  ถัดไป
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="mt-6">
          {txState === "loading" ? (
            <LoadingRows />
          ) : txState === "error" ? (
            <ErrorBox message={txError} onRetry={loadTxRecord} />
          ) : !rec ? (
            <EmptyState
              title="ไม่พบบันทึกธุรกรรมนี้ (อาจถูกลบไปแล้ว)"
              hint="ลองตรวจสอบข้อมูล Statement หรือช่วงวันที่ของบัญชีนี้อีกครั้ง"
            />
          ) : (
            <div className="bg-white rounded-xl border border-gray-100">
              <div className="px-6 py-4 border-b border-gray-100">
                <div className="flex flex-wrap items-center gap-2">
                  {sideLabelFor(rec) && (
                    <span
                      className={`inline-flex items-center text-xs font-medium px-2 py-1 rounded-full ${
                        rec.side === "SELL"
                          ? "bg-red-50 text-red-500"
                          : "bg-emerald-50 text-emerald-600"
                      }`}
                    >
                      {sideLabelFor(rec)}
                    </span>
                  )}
                  <span className="text-lg font-semibold text-gray-900">
                    {rec.symbol ?? "รายการ"}
                  </span>
                  <span className="text-sm text-gray-400">{rec.transactionDate}</span>
                </div>
                {(rec.side === "BUY" || rec.side === "SELL") && (
                  <p className="mt-1 text-sm text-gray-500">
                    {rec.side === "BUY" ? "ซื้อ" : "ขาย"} {rec.quantity ?? "-"} ×{" "}
                    {showMoney(rec.unitPrice)} {rec.currency ?? ""}
                  </p>
                )}
                {rec.section && (
                  <p className="mt-1 text-sm text-gray-500">{rec.section}</p>
                )}
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="text-xs text-gray-400">จำนวนเงิน (บาท)</span>
                  <span className="text-2xl font-bold text-gray-900">
                    {showMoney(rec.amountThb)}
                  </span>
                </div>
                {rec.side === "SELL" && rec.realizedGainLossThb != null && (
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-xs text-gray-400">กำไร/ขาดทุน (บาท)</span>
                    <span
                      className={`text-lg font-semibold ${
                        Number(rec.realizedGainLossThb) >= 0
                          ? "text-emerald-600"
                          : "text-red-600"
                      }`}
                    >
                      {showMoney(rec.realizedGainLossThb)}
                    </span>
                  </div>
                )}
              </div>
              <h3 className="px-6 py-3 text-sm font-semibold text-gray-800 border-b border-gray-100">
                รายละเอียดธุรกรรม
              </h3>
              {txRecordFields(rec).map((field) => (
                <TxField key={field.label} label={field.label}>
                  {field.value}
                </TxField>
              ))}
              <p className="px-6 py-3 text-xs text-gray-400 border-t border-gray-100">
                แสดงข้อมูลโดยตรงจากบันทึกธุรกรรมบนเซิร์ฟเวอร์ (ไม่คำนวณใหม่)
              </p>
            </div>
          )}
        </div>
      </>
    );
  }

  // ถ้ากำลังดูบัญชีใดบัญชีหนึ่ง → แสดงรายละเอียด
  if (selected) {
    return (
      <>
        <button
          type="button"
          onClick={() => setSelected(null)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-800 hover:underline"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          กลับไปรายการ{label}
        </button>

        <div className={`bg-linear-to-br ${accent} rounded-2xl px-6 py-5 text-white mt-4`}>
          <p className="text-xs text-white/70 mb-1">
            {selected.code} · {selected.currency} · <AccountTypeBadge type={selected.type} />
          </p>
          <h1 className="text-xl font-semibold mb-1">{selected.name}</h1>
          <p className="text-sm text-white/80">ประวัติรายบัญชี แสดงยอดยกมาและรายการเคลื่อนไหว</p>
        </div>

        <div className="mt-6">
          <PeriodFilter
            from={period.from}
            to={period.to}
            onFromChange={(v) => setPeriod((p) => ({ ...p, from: v }))}
            onToChange={(v) => setPeriod((p) => ({ ...p, to: v }))}
            onApply={() => {
              setAppliedFrom(period.from);
              setAppliedTo(period.to);
            }}
            onClear={() => {
              const d = defaultPeriod();
              setPeriod(d);
              setAppliedFrom(d.from);
              setAppliedTo(d.to);
            }}
          />
        </div>

        {symbolSummary.length > 0 && (
          <div className="mt-6">
            <Panel
              title={
                selected.code === "4010"
                  ? "เงินปันผลรวมตามหุ้น"
                  : "สรุปแยกตามหุ้น"
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                      <th className="px-5 py-2.5 font-medium">หุ้น</th>
                      <th className="px-5 py-2.5 font-medium">สกุล</th>
                      <th className="px-5 py-2.5 font-medium text-right">
                        จำนวนรายการ
                      </th>
                      <th className="px-5 py-2.5 font-medium text-right">
                        จำนวนเงิน
                      </th>
                      <th className="px-5 py-2.5 font-medium text-right">
                        จำนวนเงิน (บาท)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {symbolSummary.map((d) => (
                      <tr
                        key={`${d.symbol}-${d.currency}`}
                        className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60 transition"
                      >
                        <td className="px-5 py-3 text-gray-800 font-medium">
                          {d.symbol}
                        </td>
                        <td className="px-5 py-3 text-gray-500">
                          {d.currency}
                        </td>
                        <td className="px-5 py-3 text-gray-600 text-right">
                          {d.count}
                        </td>
                        <td className="px-5 py-3 text-gray-700 font-medium text-right whitespace-nowrap">
                          {formatAmount(d.amount)}
                        </td>
                        <td className="px-5 py-3 text-gray-700 font-medium text-right whitespace-nowrap">
                          {formatAmount(d.amountThb)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="px-5 py-3 text-xs text-gray-400 border-t border-gray-100">
                สรุปจากรายการในหน้านี้ แยกตามหุ้น (สัญลักษณ์จาก memo ของรายการ)
              </p>
            </Panel>
          </div>
        )}

        <div className="mt-6">
          <Panel title="รายการเคลื่อนไหว">
            {detailState === "loading" ? (
              <LoadingRows />
            ) : detailState === "error" ? (
              <ErrorBox message={detailError} onRetry={loadDetail} />
            ) : lines.length === 0 ? (
              <EmptyState
                title="ยังไม่มีรายการเคลื่อนไหวในช่วงเวลานี้"
                hint="ลองเปลี่ยนช่วงวันที่แล้วค้นหาใหม่"
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                        <th className="px-5 py-3 font-medium">เลขที่</th>
                        <th className="px-5 py-3 font-medium">วันที่</th>
                        <th className="px-5 py-3 font-medium">รายการ</th>
                        <th className="px-5 py-3 font-medium">ที่มา</th>
                        <th className="px-5 py-3 font-medium">ธุรกรรม</th>
                        <th className="px-5 py-3 font-medium text-right">เดบิต</th>
                        <th className="px-5 py-3 font-medium text-right">เครดิต</th>
                        <th className="px-5 py-3 font-medium text-right">เคลื่อนไหว</th>
                        <th className="px-5 py-3 font-medium text-right">ยอดคงเหลือ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l) => (
                        <tr
                          key={l.lineId}
                          className={`border-b border-gray-50 last:border-0 transition ${
                            selectedTxId === l.sourceTransactionId
                              ? "bg-blue-50/70"
                              : "hover:bg-gray-50/60"
                          }`}
                        >
                          <td className="px-5 py-3 text-gray-500">#{l.entryNo}</td>
                          <td className="px-5 py-3 text-gray-500 whitespace-nowrap">
                            {l.entryDate}
                          </td>
                          <td className="px-5 py-3">
                            <p className="text-gray-800 font-medium">{l.description}</p>
                            {l.memo && (
                              <p className="text-xs text-gray-400">{l.memo}</p>
                            )}
                          </td>
                          <td className="px-5 py-3">
                            <SourceBadge source={l.sourceType} />
                          </td>
                          <td className="px-5 py-3">
                            {l.sourceTransactionId ? (
                              <button
                                type="button"
                                onClick={() => setSelectedTxId(l.sourceTransactionId)}
                                className="inline-flex items-center gap-1 text-xs font-medium text-blue-800 hover:underline"
                              >
                                <Table2 className="w-3.5 h-3.5" />
                                ดูธุรกรรม
                              </button>
                            ) : (
                              <span className="text-xs text-gray-300">-</span>
                            )}
                          </td>
                          <td className="px-5 py-3 text-right text-gray-800 font-medium whitespace-nowrap">
                            {l.side === "DEBIT" ? formatAmount(l.amount) : "-"}
                          </td>
                          <td className="px-5 py-3 text-right text-gray-800 font-medium whitespace-nowrap">
                            {l.side === "CREDIT" ? formatAmount(l.amount) : "-"}
                          </td>
                          <td className="px-5 py-3 text-right text-gray-600 whitespace-nowrap">
                            {formatSignedAmount(
                              l.side === "DEBIT" ? l.amount : `-${l.amount}`
                            )}
                          </td>
                          <td className="px-5 py-3 text-right font-medium whitespace-nowrap">
                            <span
                              className={
                                Number(l.runningBalance) > 0
                                  ? "text-emerald-600"
                                  : Number(l.runningBalance) < 0
                                    ? "text-red-600"
                                    : "text-gray-600"
                              }
                            >
                              {formatSignedAmount(l.runningBalance)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t bg-gray-50/60">
                        <td
                          className="px-5 py-3 text-sm font-semibold text-gray-700"
                          colSpan={5}
                        >
                          ยอดยกมา (ก่อนช่วง, {selected.currency})
                        </td>
                        <td colSpan={3}></td>
                        <td className="px-5 py-3 text-gray-800 font-semibold text-right whitespace-nowrap">
                          {formatSignedAmount(opening)}
                        </td>
                      </tr>
                      <tr className="bg-gray-50/60">
                        <td
                          className="px-5 py-3 text-sm font-semibold text-gray-700"
                          colSpan={5}
                        >
                          ยอดรวมเคลื่อนไหว ({selected.currency})
                        </td>
                        <td colSpan={2}></td>
                        <td className="px-5 py-3 text-gray-800 font-semibold text-right whitespace-nowrap">
                          {formatSignedAmount(movement)}
                        </td>
                        <td className="px-5 py-3 text-gray-800 font-semibold text-right whitespace-nowrap">
                          {formatSignedAmount(closing)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <p className="px-5 py-3 text-xs text-gray-400 border-t border-gray-100">
                  ยอดตามหลักเดบิตบวก (เดบิต + / เครดิต −) — ตรงกับคอลัมน์ balance ของงบทดลอง บัญชีที่ปกติเป็นเครดิต (ส่วนทุน/รายได้/หนี้สิน) จะแสดงเป็นตัวติดลบ
                </p>
              </>
            )}
          </Panel>
        </div>

        </>
    );
  }

  const searching = query.trim() !== "";
  const filteredAccounts = searching
    ? accounts.filter((row) => {
        const q = query.trim().toLowerCase();
        return (
          row.code.toLowerCase().includes(q) ||
          row.name.toLowerCase().includes(q) ||
          row.currency.toLowerCase().includes(q)
        );
      })
    : accounts;

  return (
    <>
      <div className="flex flex-wrap gap-2 mb-4">
        {CATEGORIES.map((c) => {
          const CIcon = CATEGORY_ICON[c.icon] ?? Wallet;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelectTab(c.id)}
              className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition ${
                activeTab === c.id
                  ? "bg-blue-900 text-white"
                  : "text-gray-600 hover:bg-gray-50 border border-gray-200"
              }`}
            >
              <CIcon className="w-4 h-4" />
              {c.label}
            </button>
          );
        })}
      </div>

      <div className={`bg-linear-to-br ${accent} rounded-2xl px-6 py-5 text-white`}>
        <p className="text-xs text-white/70 mb-1">General Ledger · {label}</p>
        <h1 className="text-xl font-semibold mb-1.5">{label}</h1>
        <p className="text-sm text-white/80">
          บัญชี{label}ทั้งหมดสำหรับการบันทึกแบบคู่ (เดบิต/เครดิต)
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <span className="text-xs text-gray-400">จำนวนบัญชี{label}</span>
          <p className="text-xl font-semibold text-gray-800 mt-2">{accounts.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <span className="text-xs text-gray-400">ยอดคงเหลือตามสกุล</span>
          {categoryTotals.length === 0 ? (
            <p className="text-sm font-medium text-gray-600 mt-2">-</p>
          ) : (
            <div className="mt-2 space-y-1.5">
              {categoryTotals.map((t) => (
                <p key={t.currency} className="text-sm font-semibold text-gray-800">
                  {t.currency} · ปิด {formatAmount(t.closing)}
                  <span className="text-xs text-gray-400 font-normal">
                    {" "}
                    (ยกมา {formatAmount(t.opening)} · เคลื่อนไหว{" "}
                    {formatSignedAmount(t.movement)})
                  </span>
                </p>
              ))}
            </div>
          )}
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <span className="text-xs text-gray-400">สถานะ</span>
          <p className="text-sm font-medium text-gray-700 mt-2">
            {accounts.length > 0 ? "พร้อมใช้งาน" : "ยังไม่มีบัญชี"}
          </p>
        </div>
      </div>

      <div className="mt-6">
        <div className="mb-4">
          <PeriodFilter
            from={categoryPeriod.from}
            to={categoryPeriod.to}
            onFromChange={(from) => setCategoryPeriod((p) => ({ ...p, from }))}
            onToChange={(to) => setCategoryPeriod((p) => ({ ...p, to }))}
            onApply={() => setCategoryRange({ ...categoryPeriod })}
            onClear={() => {
              const range = defaultPeriod();
              setCategoryPeriod(range);
              setCategoryRange(range);
            }}
          />
        </div>
        <Panel
          title={`รายการบัญชี${label}`}
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
              title={`ยังไม่มีบัญชี${label}`}
              hint={`กด "เพิ่มบัญชีใหม่" เพื่อสร้างบัญชี${label}`}
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
                    placeholder="ค้นหารหัส ชื่อ หรือสกุลเงิน…"
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
                    <th className="px-5 py-3 font-medium text-right">ยอดยกมา</th>
                    <th className="px-5 py-3 font-medium text-right">เคลื่อนไหว</th>
                    <th className="px-5 py-3 font-medium text-right">ยอดคงเหลือ</th>
                    <th className="px-5 py-3 font-medium text-right">จำนวนรายการ</th>
                    <th className="px-5 py-3 font-medium text-right">ดูรายละเอียด</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAccounts.map((row) => {
                    const s = summaryRows.get(row.id);
                    return (
                    <tr
                      key={row.id}
                      onClick={() => setSelected(row)}
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
                      <td className="px-5 py-3.5 text-gray-600 text-right whitespace-nowrap">
                        {s ? formatAmount(s.opening) : "-"}
                      </td>
                      <td className="px-5 py-3.5 text-gray-600 text-right whitespace-nowrap">
                        {s ? formatSignedAmount(s.netMovement) : "-"}
                      </td>
                      <td className="px-5 py-3.5 text-gray-700 font-medium text-right whitespace-nowrap">
                        {s ? formatSignedAmount(s.closing) : "-"}
                      </td>
                      <td className="px-5 py-3.5 text-gray-600 text-right">
                        {s ? s.lineCount : "-"}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center justify-end text-blue-800 text-xs font-medium">
                          ดูรายละเอียด
                        </div>
                      </td>
                    </tr>
                    );
                  })}
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
                เพิ่มบัญชี{label}ใหม่
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
                  <input
                    type="text"
                    value={label}
                    readOnly
                    className="w-full px-3 py-2.5 text-sm bg-gray-50 text-gray-500 border border-gray-200 rounded-lg"
                  />
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
