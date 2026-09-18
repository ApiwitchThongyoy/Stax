import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import {
  fetchIncomeStatement,
  type GeneralLedgerIncomeStatement,
} from "../../lib/server-api";
import {
  formatAmount,
  formatBaht,
  formatSignedBaht,
  PeriodFilter,
  defaultPeriod,
  LoadingRows,
  ErrorBox,
  EmptyState,
  Panel,
} from "./shared";

function MoneyRow({
  code,
  name,
  currency,
  amount,
  amountThb,
  colorClass,
}: {
  code: string;
  name: string;
  currency: string;
  amount: string;
  amountThb: string | null;
  colorClass: string;
}) {
  return (
    <tr className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60 transition">
      <td className="px-5 py-3 text-gray-500 whitespace-nowrap">{code}</td>
      <td className="px-5 py-3 text-gray-800 font-medium">{name}</td>
      <td className="px-5 py-3 text-gray-500">{currency}</td>
      <td
        className={`px-5 py-3 font-medium text-right whitespace-nowrap ${colorClass}`}
      >
        {formatAmount(amount)}
        <span className="block text-xs font-normal text-gray-400">
          {formatBaht(amountThb)}
        </span>
      </td>
    </tr>
  );
}

export default function IncomeStatementTab() {
  const { user } = useAuth();
  const [report, setReport] = useState<GeneralLedgerIncomeStatement | null>(
    null
  );
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
      const data = await fetchIncomeStatement(
        user.accessToken,
        appliedFrom,
        appliedTo
      );
      setReport(data);
      setLoadState("success");
    } catch {
      setLoadState("error");
      setLoadError("ดึงงบกำไรขาดทุนไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    }
  }, [user?.accessToken, appliedFrom, appliedTo]);

  useEffect(() => {
    void load();
  }, [load]);

  const netIncome = report ? Number(report.netIncomeThb) : 0;
  const isProfit = netIncome >= 0;

  return (
    <>
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">Income Statement</p>
        <h1 className="text-xl font-semibold mb-1.5">งบกำไรขาดทุน</h1>
        <p className="text-sm text-blue-200">
          รายได้และค่าใช้จ่ายในช่วงเวลา คำนวณจากรายการบัญชีที่ลงบันทึกแล้วเท่านั้น
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

      <div className="mt-6 space-y-6">
        {loadState === "loading" ? (
          <Panel>
            <LoadingRows />
          </Panel>
        ) : loadState === "error" ? (
          <Panel>
            <ErrorBox message={loadError} onRetry={load} />
          </Panel>
        ) : !report || report.lines.length === 0 ? (
          <Panel>
            <EmptyState
              title="ยังไม่มีข้อมูลงบกำไรขาดทุนในช่วงเวลานี้"
              hint="ลองเปลี่ยนช่วงวันที่แล้วค้นหาใหม่"
            />
          </Panel>
        ) : (
          <>
            <Panel title="รายได้">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                      <th className="px-5 py-2.5 font-medium">รหัส</th>
                      <th className="px-5 py-2.5 font-medium">ชื่อบัญชี</th>
                      <th className="px-5 py-2.5 font-medium">สกุล</th>
                      <th className="px-5 py-2.5 font-medium text-right">
                        จำนวนเงิน
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.lines
                      .filter((l) => l.type === "INCOME")
                      .map((l) => (
                        <MoneyRow
                          key={`${l.accountId}-${l.currency}`}
                          code={l.code}
                          name={l.name}
                          currency={l.currency}
                          amount={l.amount}
                          amountThb={l.amountThb}
                          colorClass="text-emerald-600"
                        />
                      ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t bg-gray-50/60">
                      <td
                        className="px-5 py-3 text-sm font-semibold text-gray-700"
                        colSpan={3}
                      >
                        รวมรายได้
                      </td>
                      <td className="px-5 py-3 text-emerald-600 font-semibold text-right whitespace-nowrap">
                        {formatAmount(report.totalIncome)}
                        <span className="block text-xs font-normal text-gray-400">
                          {formatBaht(report.totalIncomeThb)}
                        </span>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Panel>

            {report.dividendsBySymbol.length > 0 && (
              <Panel title="สรุปเงินปันผล (แยกตามหุ้น)">
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
                      {report.dividendsBySymbol.map((d) => (
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
                          <td className="px-5 py-3 text-emerald-600 font-medium text-right whitespace-nowrap">
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
                  แสดงเฉพาะรายการเงินปันผลที่บันทึกในงบการเงิน แยกตามหุ้นจาก
                  ข้อมูลบัญชีรายย่อย (server-side)
                </p>
              </Panel>
            )}

            <Panel title="ค่าใช้จ่าย">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                      <th className="px-5 py-2.5 font-medium">รหัส</th>
                      <th className="px-5 py-2.5 font-medium">ชื่อบัญชี</th>
                      <th className="px-5 py-2.5 font-medium">สกุล</th>
                      <th className="px-5 py-2.5 font-medium text-right">
                        จำนวนเงิน
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.lines
                      .filter((l) => l.type === "EXPENSE")
                      .map((l) => (
                        <MoneyRow
                          key={`${l.accountId}-${l.currency}`}
                          code={l.code}
                          name={l.name}
                          currency={l.currency}
                          amount={l.amount}
                          amountThb={l.amountThb}
                          colorClass="text-red-500"
                        />
                      ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t bg-gray-50/60">
                      <td
                        className="px-5 py-3 text-sm font-semibold text-gray-700"
                        colSpan={3}
                      >
                        รวมค่าใช้จ่าย
                      </td>
                      <td className="px-5 py-3 text-red-500 font-semibold text-right whitespace-nowrap">
                        {formatAmount(report.totalExpense)}
                        <span className="block text-xs font-normal text-gray-400">
                          {formatBaht(report.totalExpenseThb)}
                        </span>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Panel>

            <div
              className={`rounded-xl border p-4 ${
                isProfit
                  ? "bg-emerald-50 border-emerald-100"
                  : "bg-red-50 border-red-100"
              }`}
            >
              <p
                className={`text-xs font-medium ${
                  isProfit ? "text-emerald-700" : "text-red-600"
                }`}
              >
                {isProfit ? "กำไรสุทธิ" : "ขาดทุนสุทธิ"} (บาท)
              </p>
              <p
                className={`text-2xl font-semibold mt-1 ${
                  isProfit ? "text-emerald-600" : "text-red-600"
                }`}
              >
                {formatSignedBaht(report.netIncomeThb)}
              </p>
            </div>
          </>
        )}
      </div>
    </>
  );
}