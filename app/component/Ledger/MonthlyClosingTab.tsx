import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  fetchMonthlyClosing,
  type GeneralLedgerMonthlyClosing,
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
  Panel,
} from "./shared";

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

function thaiMonthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return `${THAI_MONTHS[m - 1] ?? m} ${y}`;
}

export default function MonthlyClosingTab() {
  const { user } = useAuth();
  const [report, setReport] = useState<GeneralLedgerMonthlyClosing | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "success" | "error">(
    "loading"
  );
  const [loadError, setLoadError] = useState("");
  const [period, setPeriod] = useState(defaultPeriod());
  const [appliedFrom, setAppliedFrom] = useState(period.from);
  const [appliedTo, setAppliedTo] = useState(period.to);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user?.accessToken) return;
    setLoadState("loading");
    setLoadError("");
    try {
      const data = await fetchMonthlyClosing(
        user.accessToken,
        appliedFrom,
        appliedTo
      );
      setReport(data);
      setLoadState("success");
    } catch {
      setLoadState("error");
      setLoadError("ดึงงบปิดเดือนไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    }
  }, [user?.accessToken, appliedFrom, appliedTo]);

  useEffect(() => {
    void load();
  }, [load]);

  const balancedMonths =
    report?.months.filter((m) => m.balanced).length ?? 0;

  return (
    <>
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">Monthly Closing</p>
        <h1 className="text-xl font-semibold mb-1.5">งบปิดเดือน</h1>
        <p className="text-sm text-blue-200">
          สรุปยอดคงเหลือรายบัญชีเป็นรายเดือน — ยอดเปิดของเดือนถัดไปต้องเท่ากับ
          ยอดปิดของเดือนก่อนหน้า (ความต่อเนื่อง)
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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3">
          <p className="text-xs text-gray-400">จำนวนเดือน</p>
          <p className="text-2xl font-semibold text-gray-800 mt-1">
            {report?.months.length ?? "-"}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3">
          <p className="text-xs text-gray-400">เดือนที่สมดุล (เดบิต=เครดิต)</p>
          <p className="text-2xl font-semibold text-emerald-600 mt-1">
            {loadState === "success" ? `${balancedMonths}/${report?.months.length ?? 0}` : "-"}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3">
          <p className="text-xs text-gray-400">ความต่อเนื่อง</p>
          <p className="text-2xl font-semibold mt-1">
            <span
              className={`inline-flex items-center text-xs font-medium px-2 py-1 rounded-full ${
                report?.continuity.ok
                  ? "bg-emerald-50 text-emerald-600"
                  : "bg-red-50 text-red-500"
              }`}
            >
              {report
                ? report.continuity.ok
                  ? "ต่อเนื่อง"
                  : `พบ ${report.continuity.issues.length} รายการขัดแย้ง`
                : "-"}
            </span>
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3">
          <p className="text-xs text-gray-400">จำนวนรายการ (บรรทัด)</p>
          <p className="text-2xl font-semibold text-gray-800 mt-1">
            {report
              ? report.months.reduce((s, m) => s + m.lineCount, 0)
              : "-"}
          </p>
        </div>
      </div>

      <div className="mt-6 space-y-6">
        <Panel
          title="เดือน (ตามช่วงที่เลือก)"
          actions={
            loadState === "success" && report ? (
              <span className="text-xs text-gray-400">
                ช่วง: {appliedFrom} ถึง {appliedTo}
              </span>
            ) : undefined
          }
        >
          {loadState === "loading" ? (
            <LoadingRows />
          ) : loadState === "error" ? (
            <ErrorBox message={loadError} onRetry={load} />
          ) : !report || report.months.length === 0 ? (
            <EmptyState
              title="ยังไม่มีข้อมูลรายเดือนในช่วงเวลานี้"
              hint="ลองเปลี่ยนช่วงวันที่แล้วค้นหาใหม่"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                    <th className="px-5 py-3 font-medium">เดือน</th>
                    <th className="px-5 py-3 font-medium text-right">
                      ยอดปิดรวม (ตามสกุล)
                    </th>
                    <th className="px-5 py-3 font-medium text-right">
                      เดบิต = เครดิต
                    </th>
                    <th className="px-5 py-3 font-medium text-right">
                      จำนวนรายการ
                    </th>
                    <th className="px-5 py-3 font-medium text-right">ดูบัญชี</th>
                  </tr>
                </thead>
                <tbody>
                  {report.months.map((m) => {
                    const open = selectedMonth === m.month;
                    return (
                      <>
                        <tr
                          key={m.month}
                          className={`border-b border-gray-50 last:border-0 hover:bg-gray-50/60 transition ${
                            open ? "bg-blue-50/40" : ""
                          }`}
                        >
                          <td className="px-5 py-3.5 text-gray-800 font-medium whitespace-nowrap">
                            {thaiMonthLabel(m.month)}
                            <span className="block text-xs font-normal text-gray-400">
                              {m.month}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 text-right whitespace-nowrap">
                            <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                              {m.totalsByCurrency.length === 0 ? (
                                <span className="text-xs text-gray-300">-</span>
                              ) : (
                                m.totalsByCurrency.map((t) => (
                                  <span
                                    key={t.currency}
                                    className="inline-flex items-center gap-1 text-xs text-gray-600"
                                  >
                                    <span className="text-gray-400">
                                      {t.currency}
                                    </span>
                                    {formatSignedAmount(t.closing)}
                                  </span>
                                ))
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3.5 text-right">
                            {m.lineCount === 0 ? (
                              <span className="text-xs text-gray-300">
                                ไม่มีรายการ
                              </span>
                            ) : (
                              <span
                                className={`inline-flex items-center text-xs font-medium px-2 py-1 rounded-full ${
                                  m.balanced
                                    ? "bg-emerald-50 text-emerald-600"
                                    : "bg-red-50 text-red-500"
                                }`}
                              >
                                {m.balanced
                                  ? m.balancedThb
                                    ? "สมดุล"
                                    : "สมดุล? (บาทไม่ครบ)"
                                  : "ไม่สมดุล"}
                              </span>
                            )}
                          </td>
                          <td className="px-5 py-3.5 text-gray-600 text-right">
                            {m.lineCount}
                          </td>
                          <td className="px-5 py-3.5 text-right">
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedMonth(open ? null : m.month)
                              }
                              className="inline-flex items-center gap-1 text-xs font-medium text-blue-800 hover:underline"
                            >
                              {open ? (
                                <ChevronUp className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                              )}
                              {open ? "ซ่อน" : "ดูบัญชี"}
                            </button>
                          </td>
                        </tr>
                        {open && (
                          <tr className="bg-gray-50/40 border-b border-gray-100">
                            <td colSpan={5} className="px-5 py-4">
                              <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="text-left text-xs text-gray-400 border-b border-gray-50">
                                      <th className="px-4 py-2 font-medium">
                                        รหัส
                                      </th>
                                      <th className="px-4 py-2 font-medium">
                                        ชื่อบัญชี
                                      </th>
                                      <th className="px-4 py-2 font-medium">
                                        ประเภท
                                      </th>
                                      <th className="px-4 py-2 font-medium">
                                        สกุล
                                      </th>
                                      <th className="px-4 py-2 font-medium text-right">
                                        ยอดเปิด
                                      </th>
                                      <th className="px-4 py-2 font-medium text-right">
                                        เคลื่อนไหว
                                      </th>
                                      <th className="px-4 py-2 font-medium text-right">
                                        ยอดปิด
                                      </th>
                                      <th className="px-4 py-2 font-medium text-right">
                                        จำนวนบรรทัด
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {m.rows.map((r) => (
                                      <tr
                                        key={`${m.month}-${r.accountId}-${r.currency}`}
                                        className="border-b border-gray-50 last:border-0"
                                      >
                                        <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">
                                          {r.code}
                                        </td>
                                        <td className="px-4 py-2.5 text-gray-800 font-medium">
                                          {r.name}
                                        </td>
                                        <td className="px-4 py-2.5">
                                          <AccountTypeBadge type={r.type} />
                                        </td>
                                        <td className="px-4 py-2.5 text-gray-500">
                                          {r.currency}
                                        </td>
                                        <td className="px-4 py-2.5 text-gray-600 text-right whitespace-nowrap">
                                          {formatSignedAmount(r.opening)}
                                        </td>
                                        <td className="px-4 py-2.5 text-gray-600 text-right whitespace-nowrap">
                                          {formatSignedAmount(r.netMovement)}
                                        </td>
                                        <td className="px-4 py-2.5 text-gray-800 font-medium text-right whitespace-nowrap">
                                          {formatSignedAmount(r.closing)}
                                        </td>
                                        <td className="px-4 py-2.5 text-gray-500 text-right">
                                          {r.lineCount}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="ความต่อเนื่องระหว่างเดือน">
          {loadState === "loading" ? (
            <LoadingRows />
          ) : loadState === "error" ? (
            <ErrorBox message={loadError} onRetry={load} />
          ) : !report ? (
            <EmptyState
              title="ยังไม่มีข้อมูล"
              hint="ลองเปลี่ยนช่วงวันที่แล้วค้นหาใหม่"
            />
          ) : report.continuity.ok ? (
            <div className="px-5 py-6 text-center">
              <p className="text-sm font-medium text-emerald-600">
                ต่อเนื่อง — ยอดเปิดของเดือนถัดไป = ยอดปิดของเดือนก่อนหน้า ทุกบัญชีทุกสกุล
              </p>
              <p className="text-xs text-gray-400 mt-1">
                ยอดแต่ละเดือนคำนวณจากประวัติทั้งหมดถึงสิ้นเดือน (ไม่ใช่แค่ช่วงที่เลือก)
                การเลือกจาก/ถึงจึงเปลี่ยนเพียงเดือนที่แสดงรายงาน ไม่เปลี่ยนตัวเลข
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                    <th className="px-5 py-3 font-medium">เดือน</th>
                    <th className="px-5 py-3 font-medium">บัญชี</th>
                    <th className="px-5 py-3 font-medium">สกุล</th>
                    <th className="px-5 py-3 font-medium text-right">
                      ยอดปิดเดือนก่อน (expected)
                    </th>
                    <th className="px-5 py-3 font-medium text-right">
                      ยอดเปิดเดือนนี้ (actual)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.continuity.issues.map((iss) => (
                    <tr
                      key={`${iss.month}-${iss.accountId}-${iss.currency}`}
                      className="border-b border-gray-50 last:border-0"
                    >
                      <td className="px-5 py-3 text-gray-600 whitespace-nowrap">
                        {thaiMonthLabel(iss.month)}
                      </td>
                      <td className="px-5 py-3 text-gray-800">
                        {iss.accountId}
                      </td>
                      <td className="px-5 py-3 text-gray-500">{iss.currency}</td>
                      <td className="px-5 py-3 text-right text-gray-700 whitespace-nowrap">
                        {formatAmount(iss.expected)}
                      </td>
                      <td className="px-5 py-3 text-right text-red-600 whitespace-nowrap">
                        {formatAmount(iss.actual)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-5 py-3 text-xs text-gray-400 border-t border-gray-100">
                รายการข้างต้นบ่งชี้ว่าข้อมูลขาดความต่อเนื่อง (เช่น รายการถูกแก้ไข
                หรือยอดเปิดบัญชีเปลี่ยนแปลง)
              </p>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}