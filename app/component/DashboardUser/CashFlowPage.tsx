// Cash Flow detail page — 3 views of equity money movements:
//   1. ตั้งแต่เปิดบัญชี (all-time monthly overview + chronological rows)
//   2. รายเดือน (single month detail)
//   3. ตัดยอด ณ วันที่ (as-of cutoff detail)
//
// Server-authoritative; no P&L or tax computation in React.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, CircleHelp, Wallet } from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  type CashSummary,
  type CashSummaryQuery,
  fetchCashSummary,
} from "../../lib/server-api";

type CashView = "all" | "month" | "asOf" | "exchange";

interface Props {
  onBack?: () => void;
}

export default function CashFlowPage({ onBack }: Props) {
  const { user } = useAuth();
  const accessToken = user?.accessToken ?? null;

  const [view, setView] = useState<CashView>("all");
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}`;
  });
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));

  const [data, setData] = useState<CashSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showExchangeLegend, setShowExchangeLegend] = useState(false);

  const loadData = useCallback(
    async (v: CashView) => {
      if (!accessToken) return;
      setLoading(true);
      setError(null);
      try {
        const query: CashSummaryQuery = { withDetail: true };
        if (v === "month" && month) {
          query.month = month;
        }
        if (v === "asOf" && asOf) {
          query.asOf = asOf;
        }
        const res = await fetchCashSummary(accessToken, query);
        setData(res);
      } catch {
        setError("โหลดข้อมูลไม่สำเร็จ");
      } finally {
        setLoading(false);
      }
    },
    [accessToken, month, asOf]
  );

  // Initial load + reload on view/scope change
  useEffect(() => {
    void loadData(view);
  }, [loadData, view]);

  const totalIn = data?.totalCashInThb ?? "0";
  const totalOut = data?.totalCashOutThb ?? "0";
  const totalNet = data?.totalNetThb ?? "0";
  const rows = data?.rows ?? [];
  const exchanges = data?.exchanges ?? [];
  const exchangeTotals = data?.exchangeTotals ?? [];
  const dirTotals = data?.exchangeDirectionTotals ?? { intoThbTotal: "0", intoThbCount: 0, outOfThbTotal: "0", outOfThbCount: 0, netThb: "0", moreInThanOut: false };

  // Running net (THB) per row — display-only, computed from already-sorted rows
  const runningBalance = useMemo(() => {
    let cum = 0;
    return rows.map((r) => {
      const amt = Number(r.amountThb) || 0;
      cum += r.type === "CASH_IN" ? amt : -amt;
      return cum;
    });
  }, [rows]);

  const fmtDate = (iso: string) => {
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${Number(d)} ${["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."][Number(m) - 1]} ${y}`;
  };
  const fmtAmount = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const fmtNum = (s: string | null) => (s === null || s === "" ? "-" : Number(s).toLocaleString("en-US", { maximumFractionDigits: 8 }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <div className="flex items-center gap-2 mb-1.5">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="p-1 -ml-1 hover:bg-white/10 rounded-lg transition"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <Wallet className="w-5 h-5" />
          <h1 className="text-xl font-semibold">
            {view === "exchange" ? "การแลกเปลี่ยนสกุลเงิน" : "เงินเข้า / เงินออก"}
          </h1>
        </div>
        <p className="text-sm text-blue-200">
          {view === "exchange"
            ? "รายการแลกเปลี่ยนสกุลเงินทั้งหมด (ย้ายเงินสดระหว่างสกุล) — ไม่ใช่รายรับ/รายจ่าย ไม่รวม BUY/SELL"
            : "ดูยอดรวมและรายการธุรกรรมเงินฝาก-ถอน (โอนเข้า/ออกบัญชี) เฉพาะ equity money movements — ไม่รวม BUY/SELL"}
        </p>

        {/* View switcher */}
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          {(["all", "month", "asOf", "exchange"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`text-xs px-3 py-1.5 rounded-full font-medium transition ${
                view === v
                  ? "bg-white text-blue-900"
                  : "bg-white/10 text-white hover:bg-white/20"
              }`}
            >
              {v === "all"
                ? "ตั้งแต่เปิดบัญชี"
                : v === "month"
                  ? "รายเดือน"
                  : v === "asOf"
                    ? "ตัดยอด ณ วันที่"
                    : "แลกเปลี่ยนสกุลเงิน"}
            </button>
          ))}
        </div>

        {/* Scope inputs */}
        <div className="flex items-center gap-2 mt-3">
          {view === "month" && (
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="text-xs bg-white/10 border border-white/20 rounded px-2 py-1.5 text-white placeholder-white/50"
            />
          )}
          {view === "asOf" && (
            <input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="text-xs bg-white/10 border border-white/20 rounded px-2 py-1.5 text-white placeholder-white/50"
            />
          )}
          <button
            type="button"
            onClick={() => void loadData(view)}
            className="text-xs px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded font-medium transition"
          >
            รีเฟรช
          </button>
        </div>
      </div>

      {loading && (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
          <p className="text-sm text-gray-500">กำลังโหลด...</p>
        </div>
      )}

      {error && (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
          <p className="text-sm text-gray-600">{error}</p>
          <button
            type="button"
            onClick={() => void loadData(view)}
            className="inline-flex items-center gap-1.5 mt-4 bg-blue-900 hover:bg-blue-950 text-white text-xs font-medium px-4 py-2 rounded-lg transition"
          >
            ลองอีกครั้ง
          </button>
        </div>
      )}

      {!loading && !error && data && (
        <>
          {/* Money in/out — shown only outside the dedicated exchange view */}
          {view !== "exchange" && (
          <section className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <div className="grid grid-cols-3 gap-4 px-5 py-5 border-b border-gray-50">
              <div>
                <p className="text-[11px] text-gray-400 mb-1">
                  {view === "all" ? "เงินเข้าทั้งหมด" : view === "asOf" ? `เงินเข้าสะสม (${fmtDate(asOf)})` : "เงินเข้า (เฉพาะช่วง)"}
                </p>
                <p className="text-lg font-semibold text-emerald-600">
                  +{totalIn === "0" ? "-" : totalIn}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-gray-400 mb-1">
                  {view === "all" ? "เงินออกทั้งหมด" : view === "asOf" ? `เงินออกสะสม (${fmtDate(asOf)})` : "เงินออก (เฉพาะช่วง)"}
                </p>
                <p className="text-lg font-semibold text-red-600">
                  -{totalOut === "0" ? "-" : totalOut}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-gray-400 mb-1">
                  {view === "asOf" ? `ยอดสุทธิสะสม (${fmtDate(asOf)})` : "ยอดสุทธิ"}
                </p>
                <p
                  className={`text-lg font-semibold ${
                    Number(totalNet) >= 0 ? "text-blue-900" : "text-red-600"
                  }`}
                >
                  {totalNet === "0" ? "-" : totalNet}
                </p>
              </div>
            </div>

            {/* Detail rows table (month) */}
            {view === "month" && (
              <>
                <div className="px-5 py-3 border-b border-gray-50 flex items-center gap-2">
                  <p className="text-xs font-semibold text-gray-700">
                    รายการในเดือน {month} ({rows.length} รายการ)
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                        <th className="px-5 py-3 font-medium">วันที่</th>
                        <th className="px-5 py-3 font-medium">ประเภท</th>
                        <th className="px-5 py-3 font-medium">สกุลเงิน</th>
                        <th className="px-5 py-3 font-medium text-right">
                          จำนวนเงินต่างประเทศ
                        </th>
                        <th className="px-5 py-3 font-medium text-right">
                          จำนวนเงิน (THB)
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr>
                          <td
                            colSpan={5}
                            className="px-5 py-8 text-center text-xs text-gray-400"
                          >
                            ไม่พบรายการเงินเข้า/ออกในขอบเขตนี้
                          </td>
                        </tr>
                      ) : (
                        rows.map((r) => (
                          <tr
                            key={r.transactionId}
                            className="border-b border-gray-50 last:border-0"
                          >
                            <td className="px-5 py-3.5 text-gray-800 font-medium whitespace-nowrap">
                              {r.transactionDate}
                            </td>
                            <td className="px-5 py-3.5">
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                  r.type === "CASH_IN"
                                    ? "bg-emerald-50 text-emerald-700"
                                    : "bg-red-50 text-red-700"
                                }`}
                              >
                                {r.type === "CASH_IN" ? "เงินเข้า" : "เงินออก"}
                              </span>
                            </td>
                            <td className="px-5 py-3.5 text-gray-600 text-xs">
                              {r.currency}
                            </td>
                            <td className="px-5 py-3.5 text-right text-gray-800 font-medium">
                              {r.amountForeign}
                            </td>
                            <td
                              className={`px-5 py-3.5 text-right font-semibold ${
                                r.type === "CASH_IN"
                                  ? "text-emerald-600"
                                  : "text-red-600"
                              }`}
                            >
                              {r.type === "CASH_IN" ? "+" : "-"}
                              {r.amountThb}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* Detail rows table (as of) */}
            {view === "asOf" && (
              <>
                <div className="px-5 py-3 border-b border-gray-50">
                  <p className="text-xs font-semibold text-gray-700">
                    รายการตัดยอดถึงวันที่ {fmtDate(asOf)} ({rows.length} รายการ)
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                        <th className="px-5 py-3 font-medium">วันที่</th>
                        <th className="px-5 py-3 font-medium">ประเภท</th>
                        <th className="px-5 py-3 font-medium">สกุลเงิน</th>
                        <th className="px-5 py-3 font-medium text-right">
                          จำนวนเงินต่างประเทศ
                        </th>
                        <th className="px-5 py-3 font-medium text-right">
                          จำนวนเงิน (THB)
                        </th>
                        <th className="px-5 py-3 font-medium text-right">
                          ยอดสะสม (THB)
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr>
                          <td
                            colSpan={6}
                            className="px-5 py-8 text-center text-xs text-gray-400"
                          >
                            ไม่พบรายการเงินเข้า/ออกก่อนวันที่นี้
                          </td>
                        </tr>
                      ) : (
                        rows.map((r, i) => (
                          <tr
                            key={r.transactionId}
                            className="border-b border-gray-50 last:border-0"
                          >
                            <td className="px-5 py-3.5 text-gray-800 font-medium whitespace-nowrap">
                              {fmtDate(r.transactionDate)}
                            </td>
                            <td className="px-5 py-3.5">
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                  r.type === "CASH_IN"
                                    ? "bg-emerald-50 text-emerald-700"
                                    : "bg-red-50 text-red-700"
                                }`}
                              >
                                {r.type === "CASH_IN" ? "เงินเข้า" : "เงินออก"}
                              </span>
                            </td>
                            <td className="px-5 py-3.5 text-gray-600 text-xs">
                              {r.currency}
                            </td>
                            <td className="px-5 py-3.5 text-right text-gray-800 font-medium">
                              {r.amountForeign}
                            </td>
                            <td
                              className={`px-5 py-3.5 text-right font-semibold ${
                                r.type === "CASH_IN"
                                  ? "text-emerald-600"
                                  : "text-red-600"
                              }`}
                            >
                              {r.type === "CASH_IN" ? "+" : "-"}
                              {r.amountThb}
                            </td>
                            <td
                              className={`px-5 py-3.5 text-right font-medium tabular-nums ${
                                runningBalance[i] >= 0
                                  ? "text-blue-900"
                                  : "text-red-600"
                              }`}
                            >
                              {fmtAmount(runningBalance[i])}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* Monthly breakdown table + detail rows (all view) */}
            {view === "all" && (
              <>
                <div className="overflow-x-auto border-b border-gray-50">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                        <th className="px-5 py-3 font-medium">เดือน</th>
                        <th className="px-5 py-3 font-medium text-right">
                          เงินเข้า
                        </th>
                        <th className="px-5 py-3 font-medium text-right">
                          เงินออก
                        </th>
                        <th className="px-5 py-3 font-medium text-right">
                          สุทธิ
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.months.map((m) => (
                        <tr
                          key={m.month}
                          className="border-b border-gray-50 last:border-0"
                        >
                          <td className="px-5 py-3.5 text-gray-800 font-medium">
                            {m.month}
                          </td>
                          <td className="px-5 py-3.5 text-right text-emerald-600 font-medium">
                            +{m.cashInThb}
                          </td>
                          <td className="px-5 py-3.5 text-right text-red-600 font-medium">
                            -{m.cashOutThb}
                          </td>
                          <td className="px-5 py-3.5 text-right text-gray-800 font-semibold">
                            {m.netThb}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="px-5 py-3 border-b border-gray-50">
                  <p className="text-xs font-semibold text-gray-700">
                    รายการทั้งหมด ({rows.length} รายการ · เรียงตามวันที่)
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                        <th className="px-5 py-3 font-medium">วันที่</th>
                        <th className="px-5 py-3 font-medium">ประเภท</th>
                        <th className="px-5 py-3 font-medium">สกุลเงิน</th>
                        <th className="px-5 py-3 font-medium text-right">
                          จำนวนเงินต่างประเทศ
                        </th>
                        <th className="px-5 py-3 font-medium text-right">
                          จำนวนเงิน (THB)
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr>
                          <td
                            colSpan={5}
                            className="px-5 py-8 text-center text-xs text-gray-400"
                          >
                            ยังไม่มีรายการเงินเข้า/ออกในบัญชี
                          </td>
                        </tr>
                      ) : (
                        rows.map((r) => (
                          <tr
                            key={r.transactionId}
                            className="border-b border-gray-50 last:border-0"
                          >
                            <td className="px-5 py-3.5 text-gray-800 font-medium whitespace-nowrap">
                              {r.transactionDate}
                            </td>
                            <td className="px-5 py-3.5">
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                  r.type === "CASH_IN"
                                    ? "bg-emerald-50 text-emerald-700"
                                    : "bg-red-50 text-red-700"
                                }`}
                              >
                                {r.type === "CASH_IN" ? "เงินเข้า" : "เงินออก"}
                              </span>
                            </td>
                            <td className="px-5 py-3.5 text-gray-600 text-xs">
                              {r.currency}
                            </td>
                            <td className="px-5 py-3.5 text-right text-gray-800 font-medium">
                              {r.amountForeign}
                            </td>
                            <td
                              className={`px-5 py-3.5 text-right font-semibold ${
                                r.type === "CASH_IN"
                                  ? "text-emerald-600"
                                  : "text-red-600"
                              }`}
                            >
                              {r.type === "CASH_IN" ? "+" : "-"}
                              {r.amountThb}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div className="px-5 py-2.5 border-t border-gray-50">
              <p className="text-[11px] text-gray-400">
                {view === "all"
                  ? "แสดงเฉพาะรายการโอนเงินเข้าออกบัญชี (equity money movements) เป็นจำนวนเงินบาทตามอัตราที่บันทึก — ตารางล่างเรียงตามวันที่ (เก่าก่อน)"
                  : view === "asOf"
                    ? `เงินเข้า/ออกสะสมถึงวันที่ ${fmtDate(asOf)} — เรียงตามวันที่ (คอลัมน์ยอดสะสม = ยอดสุทธิสะสมถึงแต่ละรายการ)`
                    : `รายการเงินเข้า/ออกในเดือน ${month} — เรียงตามวันที่`}
              </p>
            </div>
          </section>
          )}

          {/* Currency exchange — shown only in the dedicated exchange view */}
          {view === "exchange" && (
          <section className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-50 flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-gray-800">
                การแลกเปลี่ยนสกุลเงิน
              </p>
              <button
                type="button"
                onClick={() => setShowExchangeLegend((s) => !s)}
                className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-blue-900 font-medium transition"
              >
                <CircleHelp className="w-3.5 h-3.5" />
                วิธีอ่าน
              </button>
              {exchangeTotals.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {exchangeTotals.map((t) => (
                    <span
                      key={t.currency}
                      className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-900 font-medium"
                    >
                      รวม {t.currency} {fmtAmount(Number(t.totalForeign))} (
                      {fmtAmount(Number(t.totalThb))} THB)
                    </span>
                  ))}
                </div>
              )}
            </div>

            {showExchangeLegend && (
              <div className="px-5 py-3 border-b border-blue-100 bg-blue-50/70 text-xs text-gray-600 space-y-1.5">
                <p className="font-semibold text-blue-900">วิธีอ่านตารางแลกเปลี่ยน</p>
                <p>
                  •{" "}
                  <span className="text-gray-800 font-medium">จำนวนเงินต้นทาง</span>{" "}
                  = เงินที่จ่ายออกไป (สกุลฝั่งซ้ายของทิศทาง) ·{" "}
                  <span className="text-gray-800 font-medium">จำนวนเงินปลายทาง</span>{" "}
                  = เงินที่ได้รับกลับมา (สกุลฝั่งขวา)
                </p>
                <p>
                  • <span className="font-medium">อัตรา</span> = อัตราแลกเปลี่ยนที่
                  broker คิด ณ วันแลก (บาทต่อดอลลาร์) — ตัวเลขจริงจาก statement
                  ไม่คำนวณใหม่
                </p>
                <p>
                  • การแลกเปลี่ยนเป็นการย้ายเงินสดระหว่างสกุล{" "}
                  <span className="font-medium">ไม่ใช่รายรับ/รายจ่าย</span>
                </p>
              </div>
            )}

            {(dirTotals.intoThbCount > 0 || dirTotals.outOfThbCount > 0) && (
              <div className="px-5 py-4 border-b border-gray-50 bg-gray-50/40">
                <p className="text-[11px] text-gray-500 font-medium mb-2">เปรียบเทียบทิศทาง</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-white border border-gray-100 rounded-lg px-4 py-3 text-center">
                    <p className="text-[11px] text-gray-500 font-medium">เงินกลับเข้าบาท</p>
                    <p className="text-base font-bold text-gray-800 tabular-nums">
                      {fmtAmount(Number(dirTotals.intoThbTotal))}{" "}
                      <span className="text-xs font-medium">THB</span>
                    </p>
                    <p className="text-[11px] text-gray-400">{dirTotals.intoThbCount} ครั้ง</p>
                  </div>
                  <div className="bg-white border border-gray-100 rounded-lg px-4 py-3 text-center">
                    <p className="text-[11px] text-gray-500 font-medium">เงินออกจากบาท</p>
                    <p className="text-base font-bold text-gray-800 tabular-nums">
                      {fmtAmount(Number(dirTotals.outOfThbTotal))}{" "}
                      <span className="text-xs font-medium">THB</span>
                    </p>
                    <p className="text-[11px] text-gray-400">{dirTotals.outOfThbCount} ครั้ง</p>
                  </div>
                </div>
                <p className={`text-xs font-semibold text-center mt-2 ${dirTotals.moreInThanOut ? "text-emerald-600" : "text-red-500"}`}>
                  {dirTotals.moreInThanOut
                    ? `→ กลับเข้ามากว่า ${fmtAmount(Math.abs(Number(dirTotals.netThb)))} บาท`
                    : `→ ออกไปมากกว่า ${fmtAmount(Math.abs(Number(dirTotals.netThb)))} บาท`}
                </p>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                    <th className="px-5 py-3 font-medium">วันที่</th>
                    <th className="px-5 py-3 font-medium">ทิศทาง</th>
                    <th className="px-5 py-3 font-medium text-right">
                      จำนวนเงินต้นทาง
                    </th>
                    <th className="px-5 py-3 font-medium text-right">
                      จำนวนเงินปลายทาง
                    </th>
                    <th className="px-5 py-3 font-medium text-right">อัตรา</th>
                  </tr>
                </thead>
                <tbody>
                  {exchanges.length === 0 ? (
                    <tr>
                      <td
                        colSpan={5}
                        className="px-5 py-8 text-center text-xs text-gray-400"
                      >
                        ยังไม่มีรายการแลกเปลี่ยนสกุลเงิน
                      </td>
                    </tr>
                  ) : (
                    exchanges.map((x) => (
                      <tr
                        key={x.transactionId}
                        className="border-b border-gray-50 last:border-0"
                      >
                        <td className="px-5 py-3.5 text-gray-800 font-medium whitespace-nowrap">
                          {fmtDate(x.transactionDate)}
                        </td>
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${x.fromCurrency === "THB" ? "bg-blue-50 text-blue-900" : "bg-gray-100 text-gray-700"}`}>
                            {x.fromCurrency ?? "ไม่ทราบสกุล"}
                          </span>
                          <span className="text-gray-400 mx-1">→</span>
                          <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${x.toCurrency === "THB" ? "bg-blue-50 text-blue-900" : "bg-gray-100 text-gray-700"}`}>
                            {x.toCurrency ?? "-"}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-right text-gray-800 font-medium whitespace-nowrap">
                          {fmtNum(x.fromAmount)}{" "}
                          <span className="text-[11px] text-gray-400 font-normal">{x.fromCurrency ?? ""}</span>
                        </td>
                        <td className="px-5 py-3.5 text-right text-gray-800 font-medium whitespace-nowrap">
                          {fmtNum(x.toAmount)}{" "}
                          <span className="text-[11px] text-gray-400 font-normal">{x.toCurrency ?? ""}</span>
                        </td>
                        <td className="px-5 py-3.5 text-right text-gray-600 text-xs tabular-nums">
                          {fmtNum(x.rate)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-2.5 border-t border-gray-50">
              <p className="text-[11px] text-gray-400">
                รายการแลกเปลี่ยนสกุลเงินทั้งหมด (ทุกช่วงเวลา) — เป็นการย้าย
                เงินสดระหว่างสกุล ไม่ใช่รายรับ/รายจ่าย
              </p>
            </div>
          </section>
          )}
        </>
      )}
    </div>
  );
}