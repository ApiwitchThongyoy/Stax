import { useCallback, useEffect, useState } from "react";
import {
  NotebookPen,
  X,
  RotateCcw,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Search,
  CalendarDays,
  CircleHelp,
} from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  fetchJournal,
  reverseJournalEntry,
  type GeneralLedgerJournalEntry,
} from "../../lib/server-api";
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

const THAI_MONTHS = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค.",
];

function sideLabel(side: string | null): string {
  return side ? SIDE_LABELS[side] ?? side : "-";
}

/** Translate the server row category into a friendly Thai label. */
function friendlyCategory(category: string | null): string {
  if (!category) return "ไม่ระบุ";
  return CATEGORY_LABELS[category] ?? category;
}

function formatThaiDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${THAI_MONTHS[m - 1] ?? m} ${y}`;
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

/** Client-side search across description/symbol/accounts/memo/entry no. */
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

/** Group entries by date; newest date first. */
function groupEntriesByDate(
  entries: GeneralLedgerJournalEntry[]
): [string, GeneralLedgerJournalEntry[]][] {
  const groups = new Map<string, GeneralLedgerJournalEntry[]>();
  for (const e of entries) {
    const arr = groups.get(e.entryDate) ?? [];
    arr.push(e);
    groups.set(e.entryDate, arr);
  }
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

/** Count the journal visibility counters from the loaded entries. */
function summaryOf(entries: GeneralLedgerJournalEntry[]) {
  return {
    total: entries.length,
    posted: entries.filter((e) => e.postingState === "POSTED").length,
    skipped: entries.filter((e) => e.postingState === "SKIPPED").length,
    reversed: entries.filter((e) => e.status.toUpperCase() === "REVERSED").length,
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
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [reverseTarget, setReverseTarget] =
    useState<GeneralLedgerJournalEntry | null>(null);
  const [isReversing, setIsReversing] = useState(false);
  const [actionError, setActionError] = useState("");

  const loadAll = useCallback(async () => {
    if (!user?.accessToken) return;
    setLoadState("loading");
    setLoadError("");
    try {
      const items = await fetchJournal(user.accessToken, appliedFrom, appliedTo, {
        sourceType: appliedSource === "" ? undefined : appliedSource,
        postingState: appliedPosting === "" ? undefined : appliedPosting,
      });
      const sorted = [...items].sort(
        (a, b) =>
          b.entryDate.localeCompare(a.entryDate) || b.entryNo - a.entryNo
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
  const groups = groupEntriesByDate(filtered);
  const searching = query.trim() !== "";

  const toggleCollapsed = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const collapseAll = () =>
    setCollapsedIds(new Set(filtered.map((e) => e.id)));
  const expandAll = () => setCollapsedIds(new Set());

  const inputClass =
    "px-3 py-2 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition";

  return (
    <>
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">Journal (สมุดรายวัน)</p>
        <h1 className="text-xl font-semibold mb-1.5">สมุดรายวัน (Journal)</h1>
        <p className="text-sm text-blue-200">
          บันทึกรายการทั้งหมดจาก Statement และรายการที่บันทึกด้วยมือ — ทุก
          รายการใน Statement ลงในสมุดรายวัน (รวมรายการที่ข้ามไม่ลงบัญชี)
        </p>
      </div>

      {/* Counters */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
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
          <p className="text-xs text-gray-400">ข้าม (ไม่ลงบัญชี)</p>
          <p className="text-2xl font-semibold text-amber-600 mt-1">
            {summary.skipped}
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
            <option value="SKIPPED">ข้าม (ไม่ลงบัญชี)</option>
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
          onClick={collapseAll}
          className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-3 py-2 rounded-lg transition"
        >
          ยุบทั้งหมด
        </button>
        <button
          type="button"
          onClick={expandAll}
          className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-3 py-2 rounded-lg transition"
        >
          ขยายทั้งหมด
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
            • <span className="font-medium">ข้าม (ไม่ลงบัญชี)</span> = บันทึกใน
            สมุดรายวันครบถ้วนแต่ไม่มีรายการบัญชีคู่ (เช่น รายการที่ระบบไม่คำนวณ
            กำไร/ขาดทุน)
          </p>
          <p>
            • <span className="font-medium">ข้อมูลเก่า (backfilled)</span> =
            รายการที่นำเข้าก่อนระบบลงบัญชีอัตโนมัติ — ตัวเลขและรายละเอียดอยู่ครบ
            แต่ยังไม่มีคู่เดบิต/เครดิต สามารถกดย้อนกลับเพื่อดูรายละเอียดได้
          </p>
        </div>
      )}

      <div className="mt-6 space-y-4">
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
            <p className="text-xs text-gray-500">
              พบ {filtered.length} รายการ
              {searching ? ` จาก ${entries.length} รายการในกรอบเวลานี้` : ""}
            </p>
            {groups.map(([date, groupEntries]) => (
              <section key={date} className="mb-6 last:mb-0">
                <div className="flex items-center justify-between mb-2 px-1">
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-700">
                    <CalendarDays className="w-4 h-4 text-gray-400" />
                    {formatThaiDate(date)}
                  </h3>
                  <span className="text-xs text-gray-400">
                    {groupEntries.length} รายการ
                  </span>
                </div>
                <div className="space-y-4">
                  {groupEntries.map((entry) => {
                    const totals = entryTotals(entry);
                    const reversed = isReversed(entry);
                    const balanced =
                      Math.abs(totals.debit - totals.credit) < 0.005;
                    const skipped = entry.postingState === "SKIPPED";
                    const detail = detailRows(entry);
                    const summaryText = tradeSummary(entry);
                    const showSubtitle = summaryText !== entry.description;
                    const collapsed = collapsedIds.has(entry.id);
                    return (
                      <div
                        key={entry.id}
                        className={`bg-white rounded-xl border overflow-hidden ${
                          reversed || skipped
                            ? "border-gray-100"
                            : "border-gray-100"
                        } ${reversed ? "opacity-70" : ""}`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 border-b border-gray-100">
                          <div className="flex items-start gap-2.5 min-w-0">
                            <NotebookPen
                              className={`mt-0.5 w-4 h-4 shrink-0 ${
                                skipped
                                  ? "text-amber-500"
                                  : reversed
                                    ? "text-gray-300"
                                    : "text-blue-800"
                              }`}
                            />
                            <div className="min-w-0">
                              <p
                                className={`text-sm font-semibold truncate ${
                                  reversed
                                    ? "text-gray-400 line-through"
                                    : "text-gray-800"
                                }`}
                              >
                                #{entry.entryNo} · {summaryText}
                              </p>
                              {showSubtitle && (
                                <p className="text-xs text-gray-400 truncate">
                                  {entry.description}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <SourceBadge source={entry.sourceType} />
                            {skipped && (
                              <span className="inline-flex items-center text-xs font-medium px-2 py-1 rounded-full bg-amber-50 text-amber-600">
                                ข้ามไม่ลงบัญชี
                              </span>
                            )}
                            {reversed && <ReversedBadge />}
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
                            <button
                              type="button"
                              onClick={() => toggleCollapsed(entry.id)}
                              aria-label={
                                collapsed ? "ขยายรายละเอียด" : "ยุบรายละเอียด"
                              }
                              className="text-gray-400 hover:text-gray-600 p-1 rounded-lg transition"
                            >
                              {collapsed ? (
                                <ChevronDown className="w-4 h-4" />
                              ) : (
                                <ChevronUp className="w-4 h-4" />
                              )}
                            </button>
                          </div>
                        </div>

                        {skipped && (
                          <div className="px-5 py-3 bg-amber-50/60 border-b border-amber-100">
                            <p className="text-xs text-amber-700">
                              <span className="font-medium">ไม่ลงบัญชี:</span>{" "}
                              {entry.skipReason === "backfilled-record-only"
                                ? "ข้อมูลเก่า — นำเข้าก่อนระบบลงบัญชีอัตโนมัติ ยังไม่มีรายการบัญชีคู่"
                                : entry.skipReason || "รายการนี้ถูกข้ามการลงบัญชี"}
                            </p>
                          </div>
                        )}

                        {collapsed ? (
                          <button
                            type="button"
                            onClick={() => toggleCollapsed(entry.id)}
                            className="w-full px-5 py-3 text-left text-xs text-gray-400 hover:bg-gray-50 transition"
                          >
                            กดเพื่อดูรายละเอียด — ข้อมูล Statement และคู่
                            เดบิต/เครดิต
                          </button>
                        ) : (
                          <>
                            {detail.length > 0 && (
                              <div className="px-5 py-4 border-b border-gray-100">
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
                              </div>
                            )}

                            {!skipped ? (
                              <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="text-left text-xs text-gray-400 border-b border-gray-50">
                                      <th className="px-5 py-2 font-medium">
                                        บัญชี
                                      </th>
                                      <th className="px-5 py-2 font-medium">
                                        หมายเหตุ
                                      </th>
                                      <th className="px-5 py-2 font-medium text-right">
                                        เดบิต
                                      </th>
                                      <th className="px-5 py-2 font-medium text-right">
                                        เครดิต
                                      </th>
                                      <th className="px-5 py-2 font-medium text-right">
                                        จำนวน (THB)
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {entry.lines.map((line) => (
                                      <tr
                                        key={line.id}
                                        className="border-b border-gray-50 last:border-0"
                                      >
                                        <td className="px-5 py-2.5">
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
                                        <td className="px-5 py-2.5 text-xs text-gray-400">
                                          {line.memo || "-"}
                                        </td>
                                        <td className="px-5 py-2.5 text-gray-800 font-medium text-right whitespace-nowrap">
                                          {line.side === "DEBIT"
                                            ? formatAmount(line.amount)
                                            : "-"}
                                        </td>
                                        <td className="px-5 py-2.5 text-gray-800 font-medium text-right whitespace-nowrap">
                                          {line.side === "CREDIT"
                                            ? formatAmount(line.amount)
                                            : "-"}
                                        </td>
                                        <td className="px-5 py-2.5 text-gray-500 text-right whitespace-nowrap">
                                          {formatBaht(line.amountThb)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                  <tfoot>
                                    <tr className="border-t border-gray-50">
                                      <td className="px-5 py-2.5 text-xs font-medium text-gray-500">
                                        รวม{" "}
                                        {totals.debit.toLocaleString(undefined, {
                                          minimumFractionDigits: 2,
                                          maximumFractionDigits: 2,
                                        })}
                                      </td>
                                      <td />
                                      <td />
                                      <td className="px-5 py-2.5 text-right">
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
                                      <td className="px-5 py-2.5 text-right text-xs text-gray-500 whitespace-nowrap">
                                        {formatBaht(totals.debit)}
                                      </td>
                                    </tr>
                                  </tfoot>
                                </table>
                              </div>
                            ) : (
                              <div className="px-5 py-4 text-xs text-gray-400">
                                รายการนี้ถูกบันทึกในสมุดรายวันไว้ครบถ้วนแต่ไม่มีการลงบัญชีคู่
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
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
    </>
  );
}