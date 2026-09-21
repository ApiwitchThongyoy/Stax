import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Plus, X, RotateCcw, Search, Edit3, History, CheckCircle2, FileText } from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  fetchAccounts,
  fetchJournal,
  reverseJournalEntry,
  type GeneralLedgerAccount,
  type GeneralLedgerJournalEntry,
} from "../../lib/server-api";
import {
  isReferenceOnlySkip,
  getEntryMoneyFlow,
  classifyEntryCategory,
  getEntryExplanation,
} from "../../lib/general-ledger";
import {
  EditJournalEntryModal,
  ManualJournalEntryModal,
  AuditHistoryModal,
  JournalNoteModal,
} from "../Journal/JournalActionModals";
import JournalEntryModal from "./JournalEntryModal";
import {
  PeriodFilter,
  defaultPeriod,
  LoadingRows,
  ErrorBox,
  EmptyState,
  SourceBadge,
  ReversedBadge,
  formatAmount,
  formatBaht,
  Panel,
} from "./shared";

interface JournalTabProps {
  onNavigateToArchive?: () => void;
}

export default function JournalTab({ onNavigateToArchive }: JournalTabProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<GeneralLedgerAccount[]>([]);
  const [entries, setEntries] = useState<GeneralLedgerJournalEntry[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "success" | "error">(
    "loading"
  );
  const [loadError, setLoadError] = useState("");
  const [period, setPeriod] = useState(defaultPeriod());
  const [appliedFrom, setAppliedFrom] = useState(period.from);
  const [appliedTo, setAppliedTo] = useState(period.to);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [reverseTarget, setReverseTarget] =
    useState<GeneralLedgerJournalEntry | null>(null);
  const [isReversing, setIsReversing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [query, setQuery] = useState("");
  const [editingEntry, setEditingEntry] = useState<GeneralLedgerJournalEntry | null>(null);
  const [historyEntry, setHistoryEntry] = useState<GeneralLedgerJournalEntry | null>(null);
  const [noteEntry, setNoteEntry] = useState<GeneralLedgerJournalEntry | null>(null);
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState("");

  const handleActionSuccess = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(""), 4000);
    void loadAll();
  };

  const handleUnauthorized = useCallback(() => {
    logout();
    navigate("/login", { replace: true });
  }, [logout, navigate]);

  const loadAll = useCallback(async () => {
    if (!user?.accessToken) return;
    setLoadState("loading");
    setLoadError("");
    try {
      const [accRows, items] = await Promise.all([
        fetchAccounts(user.accessToken),
        fetchJournal(user.accessToken, appliedFrom, appliedTo),
      ]);
      setAccounts(accRows);
      const sorted = [...items].sort(
        (a, b) =>
          a.entryDate.localeCompare(b.entryDate) || a.entryNo - b.entryNo
      );
      setEntries(sorted);
      setLoadState("success");
    } catch {
      setLoadState("error");
      setLoadError("ดึงรายการบัญชีไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    }
  }, [user?.accessToken, appliedFrom, appliedTo]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const openReverseModal = (entry: GeneralLedgerJournalEntry) => {
    setActionError("");
    setReverseTarget(entry);
  };

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
      setActionError(
        err instanceof Error ? err.message : "กลับรายการไม่สำเร็จ"
      );
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

  const isReversed = (entry: GeneralLedgerJournalEntry) =>
    entry.status.toUpperCase() === "REVERSED";

  /** Client-side search across description/symbol/accounts/memo/entry no./skipReason. */
  const matchesSearch = (entry: GeneralLedgerJournalEntry, q: string) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
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
    return haystack.includes(needle);
  };

  const searching = query.trim() !== "";
  const filteredEntries = searching
    ? entries.filter((e) => matchesSearch(e, query))
    : entries;

  return (
    <>
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">Journal Entries</p>
        <h1 className="text-xl font-semibold mb-1.5">
          บันทึกรายการบัญชี (Journal)
        </h1>
        <p className="text-sm text-blue-200">
          บันทึกรายการทั้งหมดจาก Statement และรายการที่บันทึกด้วยมือ — ทุกรายการใน Statement ถูกบันทึกครบถ้วน (รวมถึงรายการอ้างอิงที่ไม่ลงเดบิต/เครดิตซ้ำ)
        </p>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3 mt-6">
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
        <button
          type="button"
          onClick={() => {
            setActionError("");
            setIsManualModalOpen(true);
          }}
          className="flex items-center gap-1.5 bg-blue-900 hover:bg-blue-800 text-white text-xs font-semibold px-3.5 py-2 rounded-lg shadow-xs transition"
        >
          <Plus className="w-3.5 h-3.5" />
          + เพิ่มรายการเอง
        </button>
      </div>

      {toastMessage && (
        <div className="mt-3 p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl flex items-center gap-2 shadow-xs transition">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span className="font-medium">{toastMessage}</span>
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
              title="ยังไม่มีรายการบัญชีในช่วงเวลานี้"
              hint="นำเข้า Statement โดยลากไฟล์ PDF ลงในหน้าแดชบอร์ด เพื่อสร้างรายการบัญชีอัตโนมัติ"
              hintButtonLabel={
                onNavigateToArchive ? "ไปที่คลัง Statement" : undefined
              }
              onHintClick={onNavigateToArchive}
            />
          </Panel>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="ค้นหารายการ — ชื่อหุ้น, บัญชี, หมายเหตุ, เลขที่"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
                />
              </div>
              {searching && (
                <>
                  <span className="text-xs text-gray-500">
                    พบ {filteredEntries.length} จาก {entries.length} รายการ
                  </span>
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-3 py-2 rounded-lg transition"
                  >
                    ล้าง
                  </button>
                </>
              )}
            </div>
            {filteredEntries.length === 0 ? (
              <Panel>
                <div className="px-5 py-12 text-center">
                  <Search className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                  <p className="text-sm font-medium text-gray-600">
                    ไม่พบรายการที่ค้นหา
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    ลองเปลี่ยนคำค้นหา
                  </p>
                </div>
              </Panel>
            ) : (
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
                        <th className="px-4 py-3 font-medium">หมายเหตุ</th>
                        <th className="px-4 py-3 font-medium text-right">เดบิต</th>
                        <th className="px-4 py-3 font-medium text-right">เครดิต</th>
                        <th className="px-4 py-3 font-medium text-right">
                          จำนวน (THB)
                        </th>
                        <th className="px-4 py-3 font-medium text-right">การจัดการ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredEntries.map((entry) => {
                        const totals = entryTotals(entry);
                        const reversed = isReversed(entry);
                        const balanced =
                          Math.abs(totals.debit - totals.credit) < 0.005;
                        const skipped = entry.postingState === "SKIPPED";
                        const isRef = skipped && isReferenceOnlySkip(entry.skipReason);
                        const lineCount = skipped ? 1 : entry.lines.length;
                        const catInfo = classifyEntryCategory(entry);
                        const moneyFlow = getEntryMoneyFlow(entry);
                        const isEdited = Boolean(entry.updatedAt && entry.updatedAt !== entry.createdAt);
                        const noteInfo = getEntryExplanation(entry);

                        const actions = (
                          <div className="flex items-center justify-end gap-1.5">
                            {noteInfo.hasExplanation && (
                              <button
                                type="button"
                                onClick={() => setNoteEntry(entry)}
                                title="ดูหมายเหตุ"
                                aria-label="ดูหมายเหตุ"
                                className="inline-flex items-center gap-1 text-xs font-medium text-amber-800 border border-amber-200 hover:bg-amber-50 px-2 py-1 rounded-lg transition"
                              >
                                <FileText className="w-3 h-3" />
                                หมายเหตุ
                              </button>
                            )}
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
                                onClick={() => openReverseModal(entry)}
                                className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 border border-gray-200 hover:bg-gray-50 px-2 py-1 rounded-lg transition"
                              >
                                <RotateCcw className="w-3 h-3" />
                                กลับรายการ
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
                              <div className="flex items-center gap-1.5">
                                <p
                                  className={`text-sm font-medium ${
                                    reversed
                                      ? "text-gray-400 line-through"
                                      : "text-gray-800"
                                  }`}
                                >
                                  {entry.description}
                                </p>
                                {noteInfo.hasExplanation && (
                                  <button
                                    type="button"
                                    onClick={() => setNoteEntry(entry)}
                                    title="ดูหมายเหตุ"
                                    aria-label="ดูหมายเหตุ"
                                    className="inline-flex items-center justify-center p-1 rounded-md text-amber-700 hover:text-amber-900 bg-amber-50 hover:bg-amber-100 border border-amber-200/80 transition shrink-0"
                                  >
                                    <FileText className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
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
                            <td rowSpan={rowSpan} className="px-4 py-3 align-top">
                              <SourceBadge source={entry.sourceType} />
                            </td>
                            <td rowSpan={rowSpan} className="px-4 py-3 align-top">
                              <div className="flex flex-wrap items-center gap-1.5">
                                {skipped ? (
                                  isRef ? (
                                    <span className="inline-flex items-center text-xs font-medium px-2 py-1 rounded-full bg-purple-50 text-purple-700">
                                      บันทึกแล้ว (รายการอ้างอิง)
                                    </span>
                                  ) : (
                                    <>
                                      <span className="inline-flex items-center text-xs font-medium px-2 py-1 rounded-full bg-amber-50 text-amber-700">
                                        บันทึกแล้ว (ยังไม่มีคู่บัญชี)
                                      </span>
                                      <span className="inline-flex items-center text-xs font-medium px-1.5 py-0.5 rounded-md bg-amber-100/70 text-amber-800 border border-amber-200">
                                        ต้องตรวจสอบ
                                      </span>
                                    </>
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
                          entry.lines.length === 0 ? (
                            <tr
                              key={entry.id}
                              className={`border-b border-gray-50 hover:bg-gray-50/40 transition ${
                                reversed ? "opacity-60" : ""
                              }`}
                            >
                              {headerCells(1)}
                              <td className="px-4 py-3 text-xs text-gray-300">
                                -
                              </td>
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
                              <td className="px-4 py-3 align-top">
                                {actions}
                              </td>
                            </tr>
                          ) : (
                            entry.lines.map((line, i) => (
                              <tr
                                key={line.id}
                                className={`border-b border-gray-50 hover:bg-gray-50/40 transition ${
                                  reversed ? "opacity-60" : ""
                                }`}
                              >
                                {i === 0 && headerCells(lineCount)}
                                <td className="px-4 py-3">
                                  <p className="text-gray-800">
                                    {line.accountName}
                                  </p>
                                  <p className="text-xs text-gray-400">
                                    {line.accountCode} · {line.currency}
                                  </p>
                                </td>
                                <td className="px-4 py-3 text-xs text-gray-400">
                                  {line.memo || "-"}
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
                            ))
                          )
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}
          </>
        )}
      </div>

      {actionError && (
        <div className="mt-4 px-4 py-3 rounded-lg bg-red-50 text-red-600 text-sm">
          {actionError}
        </div>
      )}

      {isModalOpen && (
        <JournalEntryModal
          accounts={accounts}
          onClose={() => setIsModalOpen(false)}
          onSaved={() => {
            setIsModalOpen(false);
            void loadAll();
          }}
        />
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
          onSuccess={(msg) => {
            setEditingEntry(null);
            handleActionSuccess(msg);
          }}
        />
      )}

      {isManualModalOpen && user?.accessToken && (
        <ManualJournalEntryModal
          isOpen={isManualModalOpen}
          accessToken={user.accessToken}
          onClose={() => setIsManualModalOpen(false)}
          onSuccess={(msg) => {
            setIsManualModalOpen(false);
            handleActionSuccess(msg);
          }}
        />
      )}

      {historyEntry && user?.accessToken && (
        <AuditHistoryModal
          entry={historyEntry}
          accessToken={user.accessToken}
          onClose={() => setHistoryEntry(null)}
        />
      )}

      {noteEntry && (
        <JournalNoteModal
          entry={noteEntry}
          onClose={() => setNoteEntry(null)}
        />
      )}
    </>
  );
}