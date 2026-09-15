import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import {
  fetchTrialBalance,
  type GeneralLedgerTrialBalance,
} from "../../lib/server-api";
import {
  AccountTypeBadge,
  formatAmount,
  formatBaht,
  formatSignedAmount,
  PeriodFilter,
  defaultPeriod,
  LoadingRows,
  ErrorBox,
  EmptyState,
  Panel,
} from "./shared";

export default function TrialBalanceTab() {
  const { user } = useAuth();
  const [report, setReport] = useState<GeneralLedgerTrialBalance | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "success" | "error">(
    "loading"
  );
  const [loadError, setLoadError] = useState("");
  const [period, setPeriod] = useState(defaultPeriod());
  const [appliedFrom, setAppliedFrom] = useState(period.from);
  const [appliedTo, setAppliedTo] = useState(period.to);

  const load = useCallback(async () => {
    if (!user?.accessToken) return;
    setLoadState("loading");
    setLoadError("");
    try {
      const data = await fetchTrialBalance(
        user.accessToken,
        appliedFrom,
        appliedTo
      );
      setReport(data);
      setLoadState("success");
    } catch {
      setLoadState("error");
      setLoadError("ดึงงบทดลองไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    }
  }, [user?.accessToken, appliedFrom, appliedTo]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">Trial Balance</p>
        <h1 className="text-xl font-semibold mb-1.5">งบทดลอง</h1>
        <p className="text-sm text-blue-200">
          สรุปยอดเดบิต/เครดิตของทุกบัญชีเพื่อตรวจสอบความสมดุลของระบบบัญชีแบบคู่
        </p>
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

      <div className="mt-6">
        <Panel
          title="งบทดลอง"
          actions={
            loadState === "success" && report ? (
              <span
                className={`inline-flex items-center text-xs font-medium px-2 py-1 rounded-full ${
                  report.balanced
                    ? "bg-emerald-50 text-emerald-600"
                    : "bg-red-50 text-red-500"
                }`}
              >
                {report.balanced
                  ? "งบทดลองสมดุล"
                  : "งบทดลองไม่สมดุล — โปรดตรวจสอบรายการ"}
              </span>
            ) : undefined
          }
        >
          {loadState === "loading" ? (
            <LoadingRows />
          ) : loadState === "error" ? (
            <ErrorBox message={loadError} onRetry={load} />
          ) : !report || report.rows.length === 0 ? (
            <EmptyState
              title="ยังไม่มีข้อมูลงบทดลองในช่วงเวลานี้"
              hint="ลองเปลี่ยนช่วงวันที่แล้วค้นหาใหม่"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                    <th className="px-5 py-3 font-medium">รหัส</th>
                    <th className="px-5 py-3 font-medium">ชื่อบัญชี</th>
                    <th className="px-5 py-3 font-medium">ประเภท</th>
                    <th className="px-5 py-3 font-medium">สกุล</th>
                    <th className="px-5 py-3 font-medium text-right">เดบิต</th>
                    <th className="px-5 py-3 font-medium text-right">เครดิต</th>
                    <th className="px-5 py-3 font-medium text-right">คงเหลือ</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr
                      key={`${row.accountId}-${row.currency}`}
                      className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60 transition"
                    >
                      <td className="px-5 py-3.5 text-gray-500 whitespace-nowrap">
                        {row.code}
                      </td>
                      <td className="px-5 py-3.5 text-gray-800 font-medium">
                        {row.name}
                      </td>
                      <td className="px-5 py-3.5">
                        <AccountTypeBadge type={row.type} />
                      </td>
                      <td className="px-5 py-3.5 text-gray-500">{row.currency}</td>
                      <td className="px-5 py-3.5 text-gray-800 text-right whitespace-nowrap">
                        {formatAmount(row.debit)}
                        <span className="block text-xs font-normal text-gray-400">
                          {formatBaht(row.debitThb)}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-gray-800 text-right whitespace-nowrap">
                        {formatAmount(row.credit)}
                        <span className="block text-xs font-normal text-gray-400">
                          {formatBaht(row.creditThb)}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-gray-600 text-right whitespace-nowrap">
                        {formatSignedAmount(row.balance)}
                        <span className="block text-xs font-normal text-gray-400">
                          {formatBaht(row.balanceThb)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-gray-50/60">
                    <td
                      className="px-5 py-3 text-sm font-semibold text-gray-700"
                      colSpan={4}
                    >
                      ยอดรวมตามสกุล (ไม่บวกข้ามสกุล)
                    </td>
                    <td className="px-5 py-3 text-gray-800 font-semibold text-right whitespace-nowrap">
                      {formatAmount(report.totalDebit)}
                    </td>
                    <td className="px-5 py-3 text-gray-800 font-semibold text-right whitespace-nowrap">
                      {formatAmount(report.totalCredit)}
                    </td>
                    <td />
                  </tr>
                  <tr className="border-t bg-blue-50/50">
                    <td
                      className="px-5 py-3 text-sm font-semibold text-gray-700"
                      colSpan={4}
                    >
                      ยอดรวมฐานบาท
                      <span
                        className={`ml-2 inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${
                          report.balancedThb
                            ? "bg-emerald-50 text-emerald-600"
                            : "bg-red-50 text-red-500"
                        }`}
                      >
                        {report.balancedThb ? "สมดุล" : "ไม่สมดุล"}
                      </span>
                      {report.totalsByCurrency.length > 0 && (
                        <span className="block text-xs font-normal text-gray-400 mt-0.5">
                          {report.totalsByCurrency
                            .map((t) => `${t.currency} ${formatAmount(t.debit)}`)
                            .join(" + ")}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-gray-800 font-semibold text-right whitespace-nowrap">
                      {formatBaht(report.totalDebitThb)}
                    </td>
                    <td className="px-5 py-3 text-gray-800 font-semibold text-right whitespace-nowrap">
                      {formatBaht(report.totalCreditThb)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}