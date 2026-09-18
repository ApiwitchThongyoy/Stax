import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import {
  fetchBalanceSheet,
  type GeneralLedgerBalanceSheet,
  type GeneralLedgerBalanceSheetRow,
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

function SheetSection({
  title,
  rows,
  showNetIncome,
  netIncome,
}: {
  title: string;
  rows: GeneralLedgerBalanceSheetRow[];
  showNetIncome?: boolean;
  netIncome?: string | null;
}) {
  return (
    <>
      <tr className="bg-gray-50/80">
        <td
          colSpan={4}
          className="px-5 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide"
        >
          {title}
        </td>
      </tr>
      {rows.map((row) => (
        <tr
          key={`${row.accountId}-${title}-${row.currency}`}
          className="border-b border-gray-50 hover:bg-gray-50/60 transition"
        >
          <td className="px-5 py-3 text-gray-500 whitespace-nowrap">{row.code}</td>
          <td className="px-5 py-3 text-gray-800 font-medium">{row.name}</td>
          <td className="px-5 py-3 text-gray-500">{row.currency}</td>
          <td className="px-5 py-3 text-gray-700 font-medium text-right whitespace-nowrap">
            {formatAmount(row.balance)}
            <span className="block text-xs font-normal text-gray-400">
              {formatBaht(row.balanceThb)}
            </span>
          </td>
        </tr>
      ))}
      {showNetIncome && netIncome != null && (
        <tr className="border-b border-gray-50 bg-blue-50/40">
          <td className="px-5 py-3 text-gray-500">—</td>
          <td className="px-5 py-3 text-blue-800 font-medium">
            กำไร(ขาดทุน)สุทธิงวดนี้
          </td>
          <td className="px-5 py-3 text-blue-500" />
          <td className="px-5 py-3 text-blue-700 font-semibold text-right whitespace-nowrap">
            {formatSignedBaht(netIncome)}
          </td>
        </tr>
      )}
    </>
  );
}

export default function BalanceSheetTab() {
  const { user } = useAuth();
  const [report, setReport] = useState<GeneralLedgerBalanceSheet | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "success" | "error">(
    "loading"
  );
  const [loadError, setLoadError] = useState("");
  const [period, setPeriod] = useState(defaultPeriod());
  const [appliedTo, setAppliedTo] = useState(period.to);

  const load = useCallback(async () => {
    if (!user?.accessToken) return;
    setLoadState("loading");
    setLoadError("");
    try {
      const data = await fetchBalanceSheet(user.accessToken, appliedTo);
      setReport(data);
      setLoadState("success");
    } catch {
      setLoadState("error");
      setLoadError("ดึงงบดุลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    }
  }, [user?.accessToken, appliedTo]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">Balance Sheet</p>
        <h1 className="text-xl font-semibold mb-1.5">งบดุล</h1>
        <p className="text-sm text-blue-200">
          ฐานะการเงิน ณ วันที่ระบุ: สินทรัพย์ = หนี้สิน + ส่วนทุน (+กำไรสะสมงวดนี้)
        </p>
      </div>

      <div className="mt-6">
        <PeriodFilter
          asOf
          from={period.from}
          to={period.to}
          onFromChange={(v) => setPeriod((p) => ({ ...p, from: v }))}
          onToChange={(v) => setPeriod((p) => ({ ...p, to: v }))}
          onApply={() => setAppliedTo(period.to)}
          onClear={() => {
            const d = defaultPeriod();
            setPeriod(d);
            setAppliedTo(d.to);
          }}
        />
      </div>

      <div className="mt-6">
        <Panel
          title="งบดุล ณ วันที่"
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
                  ? "งบดุลสมดุล"
                  : "งบดุลไม่สมดุล — โปรดตรวจสอบรายการ"}
              </span>
            ) : undefined
          }
        >
          {loadState === "loading" ? (
            <LoadingRows />
          ) : loadState === "error" ? (
            <ErrorBox message={loadError} onRetry={load} />
          ) : !report ||
            (report.assets.length === 0 &&
              report.liabilities.length === 0 &&
              report.equity.length === 0) ? (
            <EmptyState
              title="ยังไม่มีข้อมูลงบดุล ณ วันที่นี้"
              hint="ลองเปลี่ยนวันที่แล้วค้นหาใหม่"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                    <th className="px-5 py-3 font-medium">รหัส</th>
                    <th className="px-5 py-3 font-medium">ชื่อบัญชี</th>
                    <th className="px-5 py-3 font-medium">สกุล</th>
                    <th className="px-5 py-3 font-medium text-right">ยอดคงเหลือ</th>
                  </tr>
                </thead>
                <tbody>
                  <SheetSection title="สินทรัพย์" rows={report.assets} />
                  <SheetSection title="หนี้สิน" rows={report.liabilities} />
                  <SheetSection
                    title="ส่วนทุน"
                    rows={report.equity}
                    showNetIncome
                    netIncome={report.netIncomeThb}
                  />
                </tbody>
                <tfoot>
                  <tr className="border-t bg-gray-50/60">
                    <td
                      className="px-5 py-3 text-sm font-semibold text-gray-700"
                      colSpan={3}
                    >
                      รวมสินทรัพย์ / รวมหนี้สินและส่วนทุน (ตามสกุล)
                    </td>
                    <td className="px-5 py-3 text-gray-800 font-semibold text-right whitespace-nowrap">
                      {formatAmount(report.totalAssets)} /{" "}
                      {formatAmount(report.totalEquityAndLiabilities)}
                    </td>
                  </tr>
                  <tr className="border-t bg-blue-50/50">
                    <td
                      className="px-5 py-3 text-sm font-semibold text-gray-700"
                      colSpan={3}
                    >
                      รวมฐานบาท
                      <span
                        className={`ml-2 inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${
                          report.balancedThb
                            ? "bg-emerald-50 text-emerald-600"
                            : "bg-red-50 text-red-500"
                        }`}
                      >
                        {report.balancedThb ? "สมดุล" : "ไม่สมดุล"}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-gray-800 font-semibold text-right whitespace-nowrap">
                      {formatBaht(report.totalAssetsThb)} /{" "}
                      {formatBaht(report.totalEquityAndLiabilitiesThb)}
                    </td>
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