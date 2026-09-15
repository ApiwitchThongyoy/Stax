import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  fetchAccountLedger,
  type GeneralLedgerAccount,
  type GeneralLedgerLineView,
} from "../../lib/server-api";
import {
  AccountTypeBadge,
  formatAmount,
  formatSignedAmount,
  formatBaht,
  PeriodFilter,
  defaultPeriod,
  LoadingRows,
  ErrorBox,
  EmptyState,
  SourceBadge,
  Panel,
} from "./shared";

interface AccountLedgerDetailProps {
  account: GeneralLedgerAccount;
  onBack: () => void;
}

function signedClass(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "text-gray-400";
  return n > 0 ? "text-emerald-600" : n < 0 ? "text-red-600" : "text-gray-600";
}

export default function AccountLedgerDetail({
  account,
  onBack,
}: AccountLedgerDetailProps) {
  const { user } = useAuth();
  const [period, setPeriod] = useState(defaultPeriod());
  const [appliedFrom, setAppliedFrom] = useState(period.from);
  const [appliedTo, setAppliedTo] = useState(period.to);
  const [opening, setOpening] = useState("0");
  const [lines, setLines] = useState<GeneralLedgerLineView[]>([]);
  const [loadState, setLoadState] = useState<
    "loading" | "success" | "error"
  >("loading");
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    if (!user?.accessToken) return;
    setLoadState("loading");
    setLoadError("");
    try {
      const data = await fetchAccountLedger(
        user.accessToken,
        account.id,
        appliedFrom,
        appliedTo
      );
      setOpening(data.opening);
      setLines(data.lines);
      setLoadState("success");
    } catch {
      setLoadState("error");
      setLoadError("ดึงยอดรายบัญชีไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    }
  }, [user?.accessToken, account.id, appliedFrom, appliedTo]);

  useEffect(() => {
    void load();
  }, [load]);

  const searching = query.trim() !== "";
  const filteredLines = searching
    ? lines.filter((l) => {
        const q = query.trim().toLowerCase();
        return [String(l.entryNo), l.entryDate, l.description, l.memo ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(q);
      })
    : lines;

  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-800 hover:underline"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        กลับไปยังผังบัญชี
      </button>

      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">
          {account.code} · {account.currency}
        </p>
        <h1 className="text-xl font-semibold mb-1.5">{account.name}</h1>
        <div className="flex items-center gap-2 mt-1">
          <AccountTypeBadge type={account.type} />
          <span className="text-sm text-blue-200">
            ยอดยกมาต้นงวด: {formatAmount(opening)} {account.currency}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mt-6">
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
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหารายการ เลขที่ หรือ memo…"
            className="w-full pl-9 pr-3 py-2 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
          />
        </div>
      </div>

      <div className="mt-6">
        <Panel
          title="รายการเคลื่อนไหวของบัญชี"
          actions={
            searching ? (
              <span className="text-xs text-gray-500">
                พบ {filteredLines.length} จาก {lines.length} รายการ
              </span>
            ) : undefined
          }
        >
          {loadState === "loading" ? (
            <LoadingRows />
          ) : loadState === "error" ? (
            <ErrorBox message={loadError} onRetry={load} />
          ) : lines.length === 0 ? (
            <EmptyState
              title="ยังไม่มีรายการเคลื่อนไหวในช่วงเวลานี้"
              hint="ลองเปลี่ยนช่วงวันที่แล้วค้นหาใหม่"
            />
          ) : filteredLines.length === 0 ? (
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
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                    <th className="px-5 py-3 font-medium">วันที่</th>
                    <th className="px-5 py-3 font-medium">เลขที่</th>
                    <th className="px-5 py-3 font-medium">รายการ</th>
                    <th className="px-5 py-3 font-medium">แหล่ง</th>
                    <th className="px-5 py-3 font-medium">memo</th>
                    <th className="px-5 py-3 font-medium text-right">เดบิต</th>
                    <th className="px-5 py-3 font-medium text-right">เครดิต</th>
                    <th className="px-5 py-3 font-medium text-right">
                      ยอดรวม (THB)
                    </th>
                    <th className="px-5 py-3 font-medium text-right">
                      ยอดคงเหลือ
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLines.map((l) => (
                    <tr
                      key={l.lineId}
                      className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60 transition"
                    >
                      <td className="px-5 py-3.5 text-gray-500 whitespace-nowrap">
                        {l.entryDate}
                      </td>
                      <td className="px-5 py-3.5 text-gray-500">{l.entryNo}</td>
                      <td className="px-5 py-3.5">
                        <p className="text-gray-800 font-medium">
                          {l.description}
                        </p>
                      </td>
                      <td className="px-5 py-3.5">
                        <SourceBadge source={l.sourceType} />
                      </td>
                      <td className="px-5 py-3.5 text-gray-400 text-xs">
                        {l.memo || "-"}
                      </td>
                      <td className="px-5 py-3.5 text-gray-800 font-medium text-right whitespace-nowrap">
                        {l.side === "DEBIT" ? formatAmount(l.amount) : "-"}
                      </td>
                      <td className="px-5 py-3.5 text-gray-800 font-medium text-right whitespace-nowrap">
                        {l.side === "CREDIT" ? formatAmount(l.amount) : "-"}
                      </td>
                      <td className="px-5 py-3.5 text-gray-600 text-right whitespace-nowrap">
                        {formatBaht(l.amountThb)}
                      </td>
                      <td
                        className={`px-5 py-3.5 font-semibold text-right whitespace-nowrap ${signedClass(
                          l.runningBalance
                        )}`}
                      >
                        {formatSignedAmount(l.runningBalance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}