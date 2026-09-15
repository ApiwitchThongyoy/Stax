import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Plus, X, RotateCcw, ScrollText, Search } from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  fetchAccounts,
  fetchJournal,
  reverseJournalEntry,
  type GeneralLedgerAccount,
  type GeneralLedgerJournalEntry,
} from "../../lib/server-api";
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
          b.entryDate.localeCompare(a.entryDate) || b.entryNo - a.entryNo
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

  /** Client-side search across description/symbol/accounts/memo/entry no. */
  const matchesSearch = (entry: GeneralLedgerJournalEntry, q: string) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
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
          รายการที่ลงบัญชีแบบคู่ทั้งหมด — ทั้งรายการอัตโนมัติจาก Statement และ
          รายการที่บันทึกด้วยมือ
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
            setIsModalOpen(true);
          }}
          className="flex items-center gap-1.5 bg-blue-900 hover:bg-blue-950 text-white text-xs font-medium px-3 py-2 rounded-lg transition"
        >
          <Plus className="w-3.5 h-3.5" />
          บันทึกรายการใหม่
        </button>
      </div>

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
          filteredEntries.map((entry) => {
            const totals = entryTotals(entry);
            const reversed = isReversed(entry);
            const balanced = Math.abs(totals.debit - totals.credit) < 0.005;
            return (
              <div
                key={entry.id}
                className={`bg-white rounded-xl border overflow-hidden ${
                  reversed ? "border-gray-100 opacity-70" : "border-gray-100"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 border-b border-gray-100">
                  <div className="flex items-center gap-2.5">
                    <ScrollText
                      className={`w-4 h-4 ${
                        reversed ? "text-gray-300" : "text-blue-800"
                      }`}
                    />
                    <p
                      className={`text-sm font-semibold ${
                        reversed ? "text-gray-400 line-through" : "text-gray-800"
                      }`}
                    >
                      #{entry.entryNo} · {entry.description}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">
                      {entry.entryDate}
                    </span>
                    <SourceBadge source={entry.sourceType} />
                    {reversed && <ReversedBadge />}
                    {!reversed && (
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
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-400 border-b border-gray-50">
                        <th className="px-5 py-2 font-medium">บัญชี</th>
                        <th className="px-5 py-2 font-medium">หมายเหตุ</th>
                        <th className="px-5 py-2 font-medium text-right">เดบิต</th>
                        <th className="px-5 py-2 font-medium text-right">เครดิต</th>
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
                            <p className="text-gray-800">{line.accountName}</p>
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
                          รวม {totals.debit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
              </div>
            );
          })
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
    </>
  );
}