import { Fragment, useCallback, useEffect, useState } from "react";
import {
  X,
  RotateCcw,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Search,
  CircleHelp,
  Edit3,
  Plus,
  History,
  CheckCircle2,
} from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  fetchJournal,
  reverseJournalEntry,
  type GeneralLedgerJournalEntry,
} from "../../lib/server-api";
import {
  isReferenceOnlySkip,
  getEntryMoneyFlow,
  classifyEntryCategory,
} from "../../lib/general-ledger";
import {
  EditJournalEntryModal,
  ManualJournalEntryModal,
  AuditHistoryModal,
} from "./JournalActionModals";
import {
  PeriodFilter,
  defaultPeriod,
  LoadingRows,
  ErrorBox,
  EmptyState,
  SourceBadge,
  ReversedBadge,
  AccountTypeBadge,
  formatAmount,
  formatBaht,
  Panel,
} from "../Ledger/shared";

interface JournalPageProps {
  onNavigateToArchive?: () => void;
}

const SIDE_LABELS: Record<string, string> = {
  BUY: "ซื้อ",
  SELL: "ขาย",
  CASH_IN: "เงินเข้า",
  CASH_OUT: "เงินออก",
};

const CATEGORY_LABELS: Record<string, string> = {
  asset: "สินทรัพย์",
  equity: "ส่วนทุน",
  income: "รายได้",
  expense: "ค่าใช้จ่าย",
};

function sideLabel(side: string | null): string {
  return side ? SIDE_LABELS[side] ?? side : "-";
}

/** Translate the server row category into a friendly Thai label. */
function friendlyCategory(category: string | null): string {
  if (!category) return "ไม่ระบุ";
  return CATEGORY_LABELS[category] ?? category;
}

/** Friendly one-line summary of what the entry means (server fields only). */
function tradeSummary(entry: GeneralLedgerJournalEntry): string {
  const d = entry.detail;
  if (d.side === "BUY" || d.side === "SELL") {
    const parts = [d.side === "BUY" ? "ซื้อ" : "ขาย"];
    if (d.symbol) parts.push(d.symbol);
    if (d.quantity != null) parts.push(`${d.quantity} หุ้น`);
    if (d.unitPrice != null) parts.push(`@ ${formatAmount(d.unitPrice)}`);
    if (d.currency) parts.push(d.currency);
    return parts.join(" ");
  }
  const desc = entry.description;
  const isDeposit = desc.includes("ฝากเงินเข้า");
  const isWithdraw = desc.includes("ถอนเงินจาก");
  if (isDeposit || isWithdraw) {
    const verb = isDeposit ? "ฝากเงินเข้าบัญชี" : "ถอนเงินจากบัญชี";
    if (d.amountThb != null) return `${verb} ${formatBaht(d.amountThb)}`;
    if (d.amount != null)
      return `${verb} ${formatAmount(d.amount)}${d.currency ? " " + d.currency : ""}`;
    return verb;
  }
  return entry.description;
}

/** Client-side search across description/symbol/accounts/memo/entry no./skipReason. */
function matchesSearch(
  entry: GeneralLedgerJournalEntry,
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    String(entry.entryNo),
    entry.description,
    entry.entryDate,
    entry.skipReason ?? "",
    entry.detail?.symbol ?? "",
    entry.detail?.side ?? "",
    entry.detail?.section ?? "",
    entry.detail?.currency ?? "",
    ...entry.lines.flatMap((l) => [
      l.accountName,
      l.accountCode,
      l.memo ?? "",
      l.currency,
    ]),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

/** Count the journal visibility counters from the loaded entries. */
function summaryOf(entries: GeneralLedgerJournalEntry[]) {
  const posted = entries.filter((e) => e.postingState === "POSTED").length;
  const reference = entries.filter(
    (e) => e.postingState === "SKIPPED" && isReferenceOnlySkip(e.skipReason)
  ).length;
  const unposted = entries.filter(
    (e) => e.postingState === "SKIPPED" && !isReferenceOnlySkip(e.skipReason)
  ).length;
  const reversed = entries.filter(
    (e) => e.status.toUpperCase() === "REVERSED"
  ).length;
  return {
    total: entries.length,
    posted,
    reference,
    unposted,
    reversed,
  };
}

/** Build the visible trade-detail fields of an entry (server fields verbatim). */
function detailRows(
  entry: GeneralLedgerJournalEntry
): { label: string; value: string }[] {
  const d = entry.detail;
  const rows: { label: string; value: string }[] = [];
  const push = (label: string, value: string | null | undefined) => {
    if (value != null && value !== "") rows.push({ label, value });
  };
  if (d.symbol != null) push("สัญลักษณ์", d.symbol);
  if (d.side != null) push("ฝั่ง", sideLabel(d.side));
  if (d.exchange != null) push("ตลาด", d.exchange);
  if (d.quantity != null) push("จำนวน", d.quantity);
  if (d.unitPrice != null) push("ราคาต่อหน่วย", d.unitPrice);
  if (d.grossAmount != null) push("มูลค่ารวม (gross)", `${formatAmount(d.grossAmount)}${d.currency ? " " + d.currency : ""}`);
  if (d.fees != null) push("ค่าธรรมเนียม", `${formatAmount(d.fees)}${d.currency ? " " + d.currency : ""}`);
  if (d.netAmount != null) push("เงินเข้า-ออก (net)", `${formatAmount(d.netAmount)}${d.currency ? " " + d.currency : ""}`);
  if (d.proceeds != null) push("เงินที่ได้รับ (proceeds)", `${formatAmount(d.proceeds)}${d.currency ? " " + d.currency : ""}`);
  if (d.amount != null) push("จำนวนเงิน", `${formatAmount(d.amount)}${d.currency ? " " + d.currency : ""}`);
  if (d.amountThb != null) push("จำนวนเงิน (THB)", `${formatAmount(d.amountThb)} บาท`);
  if (d.costBasis != null) push("ต้นทุน (cost basis)", `${formatAmount(d.costBasis)}${d.currency ? " " + d.currency : ""}`);
  if (d.averageCost != null) push("ต้นทุนเฉลี่ย", d.averageCost);
  if (d.realizedGainLoss != null) push("กำไร/ขาดทุน", `${formatAmount(d.realizedGainLoss)}${d.currency ? " " + d.currency : ""}`);
  if (d.realizedGainLossThb != null) push("กำไร/ขาดทุน (THB)", `${formatAmount(d.realizedGainLossThb)} บาท`);
  if (d.fxRateStatement != null) push("อัตราจาก Statement", d.fxRateStatement);
  if (d.fxRateEffective != null) push("อัตราที่ใช้จริง", `${d.fxRateEffective}${d.isFxConversion ? " (เฉพาะสกุลเงิน)" : ""}`);
  if (d.category != null) push("หมวดหมู่", friendlyCategory(d.category));
  if (d.section != null) push("ส่วน", d.section);
  return rows;
}

export default function JournalPage({ onNavigateToArchive }: JournalPageProps) {
  const { user } = useAuth();
  const [entries, setEntries] = useState<GeneralLedgerJournalEntry[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "success" | "error">(
    "loading"
  );
  const [loadError, setLoadError] = useState("");
  const [period, setPeriod] = useState(defaultPeriod());
  const [appliedFrom, setAppliedFrom] = useState(period.from);
  const [appliedTo, setAppliedTo] = useState(period.to);
  const [sourceFilter, setSourceFilter] = useState<
    "" | "MANUAL" | "STATEMENT"
  >("");
  const [postingFilter, setPostingFilter] = useState<"" | "POSTED" | "SKIPPED">(
    ""
  );
  const [appliedSource, setAppliedSource] = useState<
    "" | "MANUAL" | "STATEMENT"
  >("");
  const [appliedPosting, setAppliedPosting] = useState<"" | "POSTED" | "SKIPPED">(
    ""
  );
  const [query, setQuery] = useState("");
  const [showLegend, setShowLegend] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [reverseTarget, setReverseTarget] =
    useState<GeneralLedgerJournalEntry | null>(null);
  const [isReversing, setIsReversing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [editingEntry, setEditingEntry] = useState<GeneralLedgerJournalEntry | null>(null);
  const [historyEntry, setHistoryEntry] = useState<GeneralLedgerJournalEntry | null>(null);
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState("");

  const handleActionSuccess = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(""), 4000);
    void loadAll();
  };

  const loadAll = useCallback(async () => {
    if (!user?.accessToken) return;
    setLoadState("loading");
    setLoadError("");
    try {
      const items = await fetchJournal(user.accessToken, appliedFrom, appliedTo, {
        sourceType: appliedSource === "" ? undefined : appliedSource,
        postingState: appliedPosting === "" ? undefined : appliedPosting,
      });
      // สมุดรายวันเรียงตามวันที่ (เก่าก่อน) + เลขที่รายการ เพื่อให้อ่าน
      // ลำดับเหตุการณ์ได้ตรงกับงบการเงิน
      const sorted = [...items].sort(
        (a, b) =>
          a.entryDate.localeCompare(b.entryDate) || a.entryNo - b.entryNo
      );
      setEntries(sorted);
      setLoadState("success");
    } catch (error) {
      setLoadState("error");
      setLoadError("ดึงสมุดรายวันไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    }
  }, [user?.accessToken, appliedFrom, appliedTo, appliedSource, appliedPosting]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const applyFilters = () => {
    setAppliedFrom(period.from);
    setAppliedTo(period.to);
    setAppliedSource(sourceFilter);
    setAppliedPosting(postingFilter);
  };

  const clearFilters = () => {
    const d = defaultPeriod();
    setPeriod(d);
    setAppliedFrom(d.from);
    setAppliedTo(d.to);
    setSourceFilter("");
    setPostingFilter("");
    setAppliedSource("");
    setAppliedPosting("");
  };

  const isReversed = (entry: GeneralLedgerJournalEntry) =>
    entry.status.toUpperCase() === "REVERSED";

  const confirmReverse = async () => {
    if (!reverseTarget || !user?.accessToken) return;
    setIsReversing(true);
    setActionError("");
    try {
      await reverseJournalEntry(user.accessToken, reverseTarget.id);
      setReverseTarget(null);
      setIsReversing(false);
      void loadAll();
    } catch (err) {
      setIsReversing(false);
      setActionError(err instanceof Error ? err.message : "กลับรายการไม่สำเร็จ");
    }
  };

  const entryTotals = (entry: GeneralLedgerJournalEntry) => {
    const debit = entry.lines
      .filter((l) => l.side === "DEBIT")
      .reduce((sum, l) => sum + Number(l.amountThb || 0), 0);
    const credit = entry.lines
      .filter((l) => l.side === "CREDIT")
      .reduce((sum, l) => sum + Number(l.amountThb || 0), 0);
    return { debit, credit };
  };

  const summary = summaryOf(entries);
  const filtered = entries.filter((e) => matchesSearch(e, query));
  const searching = query.trim() !== "";

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const inputClass =
    "px-3 py-2 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition";

  return (
    <>
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">Journal (สมุดรายวัน)</p>
        <h1 className="text-xl font-semibold mb-1.5">สมุดรายวัน (Journal)</h1>
        <p className="text-sm text-blue-200">
          บันทึกรายการทั้งหมดจาก Statement และรายการที่บันทึกด้วยมือ — ทุกรายการใน Statement ถูกบันทึกครบถ้วน (รวมถึงรายการอ้างอิงที่ไม่ลงเดบิต/เครดิตซ้ำ)
        </p>
      </div>

      {/* Counters */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-6">
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3">
          <p className="text-xs text-gray-400">รายการทั้งหมด</p>
          <p className="text-2xl font-semibold text-gray-800 mt-1">
            {summary.total}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3">
          <p className="text-xs text-gray-400">ลงบัญชีแล้ว</p>
          <p className="text-2xl font-semibold text-emerald-600 mt-1">
            {summary.posted}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3">
          <p className="text-xs text-gray-400">บันทึกอ้างอิง</p>
          <p className="text-2xl font-semibold text-purple-700 mt-1">
            {summary.reference}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3">
          <p className="text-xs text-gray-400">ยังไม่มีคู่บัญชี</p>
          <p className="text-2xl font-semibold text-amber-600 mt-1">
            {summary.unposted}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3">
          <p className="text-xs text-gray-400">กลับรายการแล้ว</p>
          <p className="text-2xl font-semibold text-gray-400 mt-1">
            {summary.reversed}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 mt-6">
        <PeriodFilter
          from={period.from}
          to={period.to}
          onFromChange={(v) => setPeriod((p) => ({ ...p, from: v }))}
          onToChange={(v) => setPeriod((p) => ({ ...p, to: v }))}
          onApply={applyFilters}
          onClear={clearFilters}
        />
        <label className="block">
          <span className="block text-xs font-medium text-gray-500 mb-1.5">
            แหล่งที่มา
          </span>
          <select
            value={sourceFilter}
            onChange={(e) =>
              setSourceFilter(e.target.value as "" | "MANUAL" | "STATEMENT")
            }
            className={inputClass}
          >
            <option value="">ทั้งหมด</option>
            <option value="STATEMENT">จาก Statement</option>
            <option value="MANUAL">บันทึกด้วยมือ</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-gray-500 mb-1.5">
            สถานะ
          </span>
          <select
            value={postingFilter}
            onChange={(e) =>
              setPostingFilter(e.target.value as "" | "POSTED" | "SKIPPED")
            }
            className={inputClass}
          >
            <option value="">ทั้งหมด</option>
            <option value="POSTED">ลงบัญชีแล้ว</option>
            <option value="SKIPPED">บันทึกแล้ว (ไม่มีคู่เดบิต/เครดิต)</option>
          </select>
        </label>
      </div>

      {/* Search + helpers */}
      <div className="flex flex-wrap items-center gap-3 mt-4">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหารายการ — ชื่อหุ้น, บัญชี, หมายเหตุ, เลขที่"
            className="w-full pl-9 pr-3 py-2 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
          />
        </div>
        <button
          type="button"
          onClick={() => setIsManualModalOpen(true)}
          className="inline-flex items-center gap-1.5 bg-blue-900 hover:bg-blue-800 text-white text-xs font-semibold px-3 py-2 rounded-lg shadow-xs transition shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          + เพิ่มรายการเอง
        </button>
        <button
          type="button"
          onClick={() => setShowLegend((s) => !s)}
          className="inline-flex items-center gap-1.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-3 py-2 rounded-lg transition"
        >
          <CircleHelp className="w-3.5 h-3.5" />
          วิธีอ่านสมุดรายวัน
        </button>
      </div>

      {toastMessage && (
        <div className="mt-3 p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl flex items-center gap-2 shadow-xs transition">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span className="font-medium">{toastMessage}</span>
        </div>
      )}

      {showLegend && (
        <div className="mt-3 bg-blue-50/70 border border-blue-100 rounded-xl px-4 py-3 text-xs text-gray-600 space-y-1.5">
          <p className="font-semibold text-blue-900">วิธีอ่านสมุดรายวัน</p>
          <p>
            •{" "}
            <span className="text-gray-800 font-medium">เดบิต</span>{" "}
            = ยอดฝั่งสินทรัพย์/ค่าใช้จ่าย ·
            <span className="text-gray-800 font-medium">เครดิต</span>{" "}
            = ยอดฝั่งรายได้/ส่วนทุน
          </p>
          <p>
            • <span className="font-medium">ลงบัญชีแล้ว</span> = รายการถูกบันทึก
            ลงบัญชีแยกประเภทแล้ว (มีคู่เดบิต/เครดิต)
          </p>
          <p>
            • <span className="font-medium">บันทึกแล้ว (รายการอ้างอิง)</span> = บันทึกในสมุดรายวันครบถ้วน ผลกระทบทางบัญชีถูกบันทึกผ่านรายการหลักแล้ว จึงไม่ลงเดบิต/เครดิตซ้ำ (เช่น สรุปค่าธรรมเนียม/VAT รายเดือน, กำไรจากการขายที่ลงคู่กับรายการขายแล้ว)
          </p>
          <p>
            • <span className="font-medium">บันทึกแล้ว (ยังไม่มีคู่บัญชี)</span> = บันทึกในสมุดรายวันครบถ้วนแล้ว แต่ยังไม่มีรายการบัญชีคู่เดบิต/เครดิต
          </p>
          <p>
            • <span className="font-medium">ข้อมูลเก่า (backfilled)</span> =
            รายการที่นำเข้าก่อนระบบลงบัญชีอัตโนมัติ — ตัวเลขและรายละเอียดอยู่ครบ
            แต่ยังไม่มีคู่เดบิต/เครดิต สามารถกดย้อนกลับเพื่อดูรายละเอียดได้
          </p>
          <p>
            • รายการเรียงตามวันที่ (เก่าก่อน) · กดแถว
            <span className="text-gray-800 font-medium"> ดูรายละเอียด</span>{" "}
            เพื่อขยายข้อมูล Statement ของรายการนั้น
          </p>
        </div>
      )}

      <div className="mt-6">
        {loadState === "loading" ? (
          <Panel>
            <LoadingRows />
          </Panel>
        ) : loadState === "error" ? (
          <Panel>
            <ErrorBox message={loadError} onRetry={loadAll} />
          </Panel>
        ) : entries.length === 0 ? (
          <Panel>
            <EmptyState
              title="ยังไม่มีรายการในสมุดรายวัน"
              hint="นำเข้า Statement โดยลากไฟล์ PDF ลงในหน้าอัปโหลด เพื่อสร้างรายการบัญชีอัตโนมัติ"
              hintButtonLabel={
                onNavigateToArchive ? "ไปที่คลัง Statement" : undefined
              }
              onHintClick={onNavigateToArchive}
            />
          </Panel>
        ) : filtered.length === 0 ? (
          <Panel>
            <div className="px-5 py-12 text-center">
              <Search className="w-8 h-8 text-gray-300 mx-auto mb-3" />
              <p className="text-sm font-medium text-gray-600">
                ไม่พบรายการที่ค้นหา
              </p>
              <p className="text-xs text-gray-400 mt-1">
                ลองเปลี่ยนคำค้นหรือล้างตัวกรอง
              </p>
            </div>
          </Panel>
        ) : (
          <>
            <p className="text-xs text-gray-500 mb-2">
              พบ {filtered.length} รายการ
              {searching ? ` จาก ${entries.length} รายการในกรอบเวลานี้` : ""} ·
              เรียงตามวันที่ (เก่าก่อน)
            </p>
            <Panel>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                      <th className="px-4 py-3 font-medium">วันที่</th>
                      <th className="px-4 py-3 font-medium">เลขที่</th>
                      <th className="px-4 py-3 font-medium">รายการ</th>
                      <th className="px-4 py-3 font-medium">หมวดหมู่</th>
                      <th className="px-4 py-3 font-medium text-right text-emerald-700">เงินเข้า</th>
                      <th className="px-4 py-3 font-medium text-right text-red-700">เงินออก</th>
                      <th className="px-4 py-3 font-medium">แหล่ง</th>
                      <th className="px-4 py-3 font-medium">สถานะ</th>
                      <th className="px-4 py-3 font-medium">บัญชี</th>
                      <th className="px-4 py-3 font-medium text-right">เดบิต</th>
                      <th className="px-4 py-3 font-medium text-right">เครดิต</th>
                      <th className="px-4 py-3 font-medium text-right">
                        จำนวน (THB)
                      </th>
                      <th className="px-4 py-3 font-medium text-right">การจัดการ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((entry) => {
                      const totals = entryTotals(entry);
                      const reversed = isReversed(entry);
                      const balanced =
                        Math.abs(totals.debit - totals.credit) < 0.005;
                      const skipped = entry.postingState === "SKIPPED";
                      const isRef = skipped && isReferenceOnlySkip(entry.skipReason);
                      const detail = detailRows(entry);
                      const summaryText = tradeSummary(entry);
                      const showSubtitle = summaryText !== entry.description;
                      const expanded = expandedIds.has(entry.id);
                      const lineCount = skipped ? 1 : entry.lines.length;
                      const catInfo = classifyEntryCategory(entry);
                      const moneyFlow = getEntryMoneyFlow(entry);
                      const isEdited = Boolean(entry.updatedAt && entry.updatedAt !== entry.createdAt);

                      const actions = (
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {!reversed && (
                            <button
                              type="button"
                              onClick={() => setEditingEntry(entry)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-amber-800 border border-amber-200 hover:bg-amber-50 px-2 py-1 rounded-lg transition"
                            >
                              <Edit3 className="w-3 h-3" />
                              แก้ไข
                            </button>
                          )}
                          {isEdited && (
                            <button
                              type="button"
                              onClick={() => setHistoryEntry(entry)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-purple-700 border border-purple-200 hover:bg-purple-50 px-2 py-1 rounded-lg transition"
                            >
                              <History className="w-3 h-3" />
                              ดูประวัติ
                            </button>
                          )}
                          {!reversed && !skipped && (
                            <button
                              type="button"
                              onClick={() => {
                                setActionError("");
                                setReverseTarget(entry);
                              }}
                              className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 border border-gray-200 hover:bg-gray-50 px-2 py-1 rounded-lg transition"
                            >
                              <RotateCcw className="w-3 h-3" />
                              กลับรายการ
                            </button>
                          )}
                          {entry.sourceDocumentId && onNavigateToArchive && (
                            <button
                              type="button"
                              onClick={onNavigateToArchive}
                              className="inline-flex items-center gap-1 text-xs font-medium text-blue-800 border border-blue-100 hover:bg-blue-50 px-2 py-1 rounded-lg transition"
                            >
                              ดู Statement
                              <ArrowRight className="w-3 h-3" />
                            </button>
                          )}
                          {detail.length > 0 && (
                            <button
                              type="button"
                              onClick={() => toggleExpanded(entry.id)}
                              aria-label={
                                expanded ? "ซ่อนรายละเอียด" : "ดูรายละเอียด"
                              }
                              className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:bg-gray-50 px-2 py-1 rounded-lg transition"
                            >
                              {expanded ? (
                                <ChevronUp className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                              )}
                              {expanded ? "ซ่อนรายละเอียด" : "ดูรายละเอียด"}
                            </button>
                          )}
                        </div>
                      );

                      const headerCells = (rowSpan: number) => (
                        <>
                          <td
                            rowSpan={rowSpan}
                            className="px-4 py-3 text-gray-500 whitespace-nowrap align-top"
                          >
                            {entry.entryDate}
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="px-4 py-3 text-gray-500 align-top"
                          >
                            #{entry.entryNo}
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="px-4 py-3 align-top min-w-[200px]"
                          >
                            <p
                              className={`text-sm font-medium ${
                                reversed
                                  ? "text-gray-400 line-through"
                                  : "text-gray-800"
                              }`}
                            >
                              {summaryText}
                            </p>
                            {showSubtitle && (
                              <p className="text-xs text-gray-400">
                                {entry.description}
                              </p>
                            )}
                            {skipped && (
                              isRef ? (
                                <p className="mt-1 text-xs text-blue-700">
                                  บันทึกครบแล้ว: ผลกระทบทางบัญชีถูกบันทึกผ่านรายการหลักแล้ว จึงไม่ลงเดบิต/เครดิตซ้ำ
                                </p>
                              ) : (
                                <p className="mt-1 text-xs text-amber-700">
                                  <span className="font-medium">บันทึกในสมุดรายวันแล้ว:</span>{" "}
                                  {entry.skipReason === "backfilled-record-only"
                                    ? "ข้อมูลเก่า — นำเข้าก่อนระบบลงบัญชีอัตโนมัติ ยังไม่มีรายการบัญชีคู่"
                                    : entry.skipReason ||
                                      "ยังไม่มีคู่รายการเดบิต/เครดิต"}
                                </p>
                              )
                            )}
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="px-4 py-3 align-top whitespace-nowrap"
                          >
                            <span className="inline-flex items-center text-xs px-2 py-0.5 rounded-md font-medium bg-gray-100 text-gray-700 border border-gray-200/60">
                              {catInfo.label}
                            </span>
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="px-4 py-3 text-right font-medium align-top whitespace-nowrap text-emerald-600"
                          >
                            {moneyFlow.moneyIn ? `+ ${moneyFlow.moneyIn}` : "—"}
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="px-4 py-3 text-right font-medium align-top whitespace-nowrap text-red-600"
                          >
                            {moneyFlow.moneyOut ? `- ${moneyFlow.moneyOut}` : "—"}
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="px-4 py-3 align-top"
                          >
                            <SourceBadge source={entry.sourceType} />
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="px-4 py-3 align-top"
                          >
                            <div className="flex flex-wrap items-center gap-1.5">
                              {skipped ? (
                                isRef ? (
                                  <span className="inline-flex items-center text-xs font-medium px-2 py-1 rounded-full bg-purple-50 text-purple-700">
                                    บันทึกแล้ว (รายการอ้างอิง)
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center text-xs font-medium px-2 py-1 rounded-full bg-amber-50 text-amber-700">
                                    บันทึกแล้ว (ยังไม่มีคู่บัญชี)
                                  </span>
                                )
                              ) : (
                                <span className="inline-flex items-center text-xs font-medium px-2 py-1 rounded-full bg-blue-50 text-blue-700">
                                  ลงบัญชีแล้ว
                                </span>
                              )}
                              {reversed && <ReversedBadge />}
                              {isEdited && (
                                <button
                                  type="button"
                                  onClick={() => setHistoryEntry(entry)}
                                  className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-200 transition"
                                  title="คลิกเพื่อดูประวัติการแก้ไข"
                                >
                                  แก้ไขโดยผู้ใช้
                                </button>
                              )}
                              {!skipped && (
                                <span
                                  className={`inline-flex items-center text-xs font-medium px-2 py-1 rounded-full ${
                                    balanced
                                      ? "bg-emerald-50 text-emerald-600"
                                      : "bg-red-50 text-red-500"
                                  }`}
                                >
                                  {balanced ? "สมดุล" : "ไม่สมดุล"}
                                </span>
                              )}
                            </div>
                          </td>
                        </>
                      );

                      return (
                        <Fragment key={entry.id}>
                          {entry.lines.length === 0 ? (
                            <tr
                              className={`border-b border-gray-50 hover:bg-gray-50/40 transition ${
                                reversed ? "opacity-60" : ""
                              }`}
                            >
                              {headerCells(1)}
                              <td className="px-4 py-3 text-xs text-gray-300">
                                -
                              </td>
                              <td className="px-4 py-3 text-right text-gray-800 font-medium whitespace-nowrap">
                                -
                              </td>
                              <td className="px-4 py-3 text-right text-gray-800 font-medium whitespace-nowrap">
                                -
                              </td>
                              <td className="px-4 py-3 text-right text-gray-500 whitespace-nowrap">
                                -
                              </td>
                              <td className="px-4 py-3 align-top">{actions}</td>
                            </tr>
                          ) : (
                            <>
                              {entry.lines.map((line, i) => (
                                <tr
                                  key={line.id}
                                  className={`border-b border-gray-50 hover:bg-gray-50/40 transition ${
                                    reversed ? "opacity-60" : ""
                                  }`}
                                >
                                  {i === 0 && headerCells(lineCount)}
                                  <td className="px-4 py-3">
                                    <div className="flex items-center gap-2">
                                      <p className="text-gray-800">
                                        {line.accountName}
                                      </p>
                                      <AccountTypeBadge
                                        type={line.accountType}
                                      />
                                    </div>
                                    <p className="text-xs text-gray-400">
                                      {line.accountCode} · {line.currency}
                                    </p>
                                  </td>
                                  <td className="px-4 py-3 text-gray-800 font-medium text-right whitespace-nowrap">
                                    {line.side === "DEBIT"
                                      ? formatAmount(line.amount)
                                      : "-"}
                                  </td>
                                  <td className="px-4 py-3 text-gray-800 font-medium text-right whitespace-nowrap">
                                    {line.side === "CREDIT"
                                      ? formatAmount(line.amount)
                                      : "-"}
                                  </td>
                                  <td className="px-4 py-3 text-gray-500 text-right whitespace-nowrap">
                                    {formatBaht(line.amountThb)}
                                  </td>
                                  {i === 0 && (
                                    <td
                                      rowSpan={lineCount}
                                      className="px-4 py-3 align-top"
                                    >
                                      {actions}
                                    </td>
                                  )}
                                </tr>
                              ))}
                              <tr className="border-b border-gray-50 bg-gray-50/40">
                                <td
                                  colSpan={6}
                                  className="px-4 py-2.5 text-right text-xs font-medium text-gray-500"
                                >
                                  รวม
                                </td>
                                <td className="px-4 py-2.5 text-right">
                                  <span
                                    className={`inline-flex items-center text-xs font-medium px-2 py-1 rounded-full ${
                                      balanced
                                        ? "bg-emerald-50 text-emerald-600"
                                        : "bg-red-50 text-red-500"
                                    }`}
                                  >
                                    {balanced ? "สมดุล" : "ไม่สมดุล"}
                                  </span>
                                </td>
                                <td />
                                <td className="px-4 py-2.5 text-right text-xs text-gray-500 whitespace-nowrap">
                                  {formatBaht(totals.debit)}
                                </td>
                                <td />
                              </tr>
                            </>
                          )}
                          {expanded && (
                            <tr className="bg-gray-50/60 border-b border-gray-100">
                              <td colSpan={10} className="px-6 py-4">
                                {detail.length === 0 ? (
                                  <p className="text-xs text-gray-400">
                                    ไม่มีรายละเอียดเพิ่มเติมจาก Statement
                                  </p>
                                ) : (
                                  <>
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
                                      รายละเอียดรายการจาก Statement
                                    </p>
                                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-2">
                                      {detail.map((row) => (
                                        <div
                                          key={row.label}
                                          className="flex items-baseline justify-between gap-3 text-xs"
                                        >
                                          <span className="text-gray-400">
                                            {row.label}
                                          </span>
                                          <span
                                            className={`font-medium text-right whitespace-nowrap ${
                                              row.label.includes("กำไร/ขาดทุน")
                                                ? row.value.startsWith("-")
                                                  ? "text-red-500"
                                                  : "text-emerald-600"
                                                : "text-gray-700"
                                            }`}
                                          >
                                            {row.value}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          </>
        )}
      </div>

      {actionError && (
        <div className="mt-4 px-4 py-3 rounded-lg bg-red-50 text-red-600 text-sm">
          {actionError}
        </div>
      )}

      {reverseTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/40 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setReverseTarget(null);
          }}
        >
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-800">
                กลับรายการบัญชี
              </h3>
              <button
                type="button"
                onClick={() => setReverseTarget(null)}
                className="text-gray-400 hover:text-gray-600 transition p-1"
                aria-label="ปิดหน้าต่าง"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-gray-600 leading-relaxed">
                จะสร้างรายการกลับรายการของ '
                <span className="font-medium text-gray-800">
                  {reverseTarget.description}
                </span>
                ' (วันที่ {reverseTarget.entryDate}) ระบบจะกลับด้านเดบิต/เครดิต
                ทุกรายการ และทำเครื่องหมายรายการเดิมเป็น "กลับรายการแล้ว"
              </p>
              {actionError && (
                <div className="mt-3 px-3 py-2.5 rounded-lg bg-red-50 text-red-600 text-sm">
                  {actionError}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-100">
              <button
                type="button"
                onClick={confirmReverse}
                disabled={isReversing}
                className="flex-1 bg-blue-900 hover:bg-blue-950 text-white text-sm font-medium py-2.5 rounded-lg transition disabled:opacity-60"
              >
                {isReversing ? "กำลังกลับรายการ..." : "ยืนยันการกลับรายการ"}
              </button>
              <button
                type="button"
                onClick={() => setReverseTarget(null)}
                className="text-sm font-medium px-4 py-2.5 rounded-lg text-gray-500 hover:bg-gray-50 transition"
              >
                ยกเลิก
              </button>
            </div>
          </div>
        </div>
      )}

      {editingEntry && user?.accessToken && (
        <EditJournalEntryModal
          entry={editingEntry}
          accessToken={user.accessToken}
          onClose={() => setEditingEntry(null)}
          onSuccess={handleActionSuccess}
        />
      )}

      {isManualModalOpen && user?.accessToken && (
        <ManualJournalEntryModal
          isOpen={isManualModalOpen}
          accessToken={user.accessToken}
          onClose={() => setIsManualModalOpen(false)}
          onSuccess={handleActionSuccess}
        />
      )}

      {historyEntry && user?.accessToken && (
        <AuditHistoryModal
          entry={historyEntry}
          accessToken={user.accessToken}
          onClose={() => setHistoryEntry(null)}
        />
      )}
    </>
  );
}