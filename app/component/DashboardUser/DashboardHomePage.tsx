import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowRight,
  Coins,
  RefreshCw,
  UploadCloud,
  Wallet,
} from "lucide-react";
import { useAuth } from "../../lib/auth";
import type { Transaction } from "../../lib/Financeutils";
import {
  type CashSummary,
  type CashSummaryQuery,
  type CashExchangeDirectionTotals,
  type CashSummaryExchangeRow,
  type CashSummaryExchangeTotal,
  type CostBasisHolding,
  type GeneralLedgerSummary,
  type ServerDocumentMeta,
  type StockPriceQuote,
  fetchCashSummary,
  fetchCostBasis,
  fetchLedgerSummary,
  fetchStockQuotes,
  holdingCurrencyCode,
  holdingMarketValue,
  holdingTotalCost,
  holdingUnrealizedPnl,
  quoteForSymbol,
} from "../../lib/server-api";
import PortfolioChart from "./PortfolioChart";

export type DashboardNav = "gl" | "upload" | "archive" | "cashflow";

interface DashboardHomePageProps {
  transactions: Transaction[];
  documents: ServerDocumentMeta[];
  onNavigate: (nav: DashboardNav) => void;
  /** เจาะดูหุ้นรายตัว (คลิกที่สัญลักษณ์ใน "การถือครองหุ้น") */
  onOpenSymbol: (symbol: string) => void;
}

const QUICK_ACTIONS: {
  nav: DashboardNav;
  label: string;
  icon: typeof UploadCloud;
}[] = [
  { nav: "upload", label: "อัปโหลด Statement", icon: UploadCloud },
  { nav: "archive", label: "คลัง Statement", icon: Archive },
];

export default function DashboardHomePage({
  transactions,
  documents,
  onNavigate,
  onOpenSymbol,
}: DashboardHomePageProps) {
  const { user } = useAuth();
  const accessToken = user?.accessToken ?? null;

  const [summary, setSummary] = useState<GeneralLedgerSummary | null>(null);
  const [holdings, setHoldings] = useState<CostBasisHolding[] | null>(null);
  const [quotes, setQuotes] = useState<StockPriceQuote[]>([]);
  const [cashSummary, setCashSummary] = useState<CashSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ---- สรุปเงินเข้า/ออก: สลับมุมมอง ----
  type CashView = "all" | "month" | "asOf" | "exchange";
  const [cashView, setCashView] = useState<CashView>("all");
  const [cashMonth, setCashMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}`;
  });
  const [cashAsOf, setCashAsOf] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [cashDetailLoading, setCashDetailLoading] = useState(false);

  /** เรียก cash-summary ด้วย scope (เดิม = all). */
  const fetchCash = useCallback(
    async (view: CashView, scope?: { month?: string; asOf?: string }) => {
      if (!accessToken) return;
      const query: CashSummaryQuery = { withDetail: true };
      if (view === "month" && scope?.month) {
        query.month = scope.month;
      }
      if (view === "asOf" && scope?.asOf) {
        query.asOf = scope.asOf;
      }
      const res = await fetchCashSummary(accessToken, query);
      setCashSummary(res);
    },
    [accessToken]
  );

  const loadCashView = useCallback(
    async (view: CashView) => {
      setCashView(view);
      if (view === "all") {
        await fetchCash("all");
      } else if (view === "month") {
        setCashDetailLoading(true);
        await fetchCash("month", { month: cashMonth });
        setCashDetailLoading(false);
      } else if (view === "asOf") {
        setCashDetailLoading(true);
        await fetchCash("asOf", { asOf: cashAsOf });
        setCashDetailLoading(false);
      } else if (view === "exchange") {
        setCashDetailLoading(true);
        await fetchCash("exchange");
        setCashDetailLoading(false);
      }
    },
    [fetchCash, cashMonth, cashAsOf]
  );

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    const [s, h, c] = await Promise.allSettled([
      fetchLedgerSummary(accessToken),
      fetchCostBasis(accessToken),
      fetchCashSummary(accessToken),
    ]);
    setSummary(s.status === "fulfilled" ? s.value : null);
    const holdingsValue = h.status === "fulfilled" ? h.value : null;
    setHoldings(holdingsValue);
    setCashSummary(c.status === "fulfilled" ? c.value : null);
    if (holdingsValue && holdingsValue.length > 0) {
      const q = await Promise.allSettled([
        fetchStockQuotes(
          accessToken,
          holdingsValue.map((x) => x.symbol)
        ),
      ]);
      setQuotes(q[0].status === "fulfilled" ? q[0].value : []);
    } else {
      setQuotes([]);
    }
    if (s.status === "rejected" && h.status === "rejected") {
      setError("โหลดข้อมูลภาพรวมไม่สำเร็จ (เซิร์ฟเวอร์ไม่ตอบกลับ)");
    }
    setLoading(false);
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const cashRows = cashSummary?.rows ?? [];

  // Currency-exchange strip reads the same cash-summary response (already
  // scoped to the selected view by the server) — display-only, no recompute.
  const exchanges = cashSummary?.exchanges ?? [];
  const exchangeTotals = cashSummary?.exchangeTotals ?? [];
  const dirTotals = cashSummary?.exchangeDirectionTotals ?? {
    intoThbTotal: "0",
    intoThbCount: 0,
    outOfThbTotal: "0",
    outOfThbCount: 0,
    netThb: "0",
    moreInThanOut: false,
  };

  // Running net (THB) per row — display-only, computed from pre-sorted rows
  const cashRunningBalance = useMemo(() => {
    let cum = 0;
    return cashRows.map((r) => {
      const amt = Number(r.amountThb) || 0;
      cum += r.type === "CASH_IN" ? amt : -amt;
      return cum;
    });
  }, [cashRows]);

  return (
    <div className="space-y-6">
      {/* Banner */}
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">หน้าหลัก</p>
        <h1 className="text-xl font-semibold mb-1.5">Dashboard</h1>
        <p className="text-sm text-blue-200">
          ภาพรวมพอร์ต เงินเข้า-ออก และงบการเงินของคุณ
        </p>
        <div className="flex flex-wrap gap-2 mt-4">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.nav}
              type="button"
              onClick={() => onNavigate(a.nav)}
              className="inline-flex items-center gap-1.5 bg-white/10 hover:bg-white/20 text-white text-xs font-medium px-3 py-2 rounded-lg transition"
            >
              <a.icon className="w-3.5 h-3.5" />
              {a.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white rounded-xl border border-gray-100 p-4 animate-pulse">
              <div className="h-3 w-24 bg-gray-200 rounded mb-3" />
              <div className="h-7 w-32 bg-gray-200 rounded mb-3" />
              <div className="h-3 w-40 bg-gray-200 rounded" />
            </div>
            <div className="bg-white rounded-xl border border-gray-100 p-4 animate-pulse">
              <div className="h-3 w-24 bg-gray-200 rounded mb-3" />
              <div className="h-7 w-32 bg-gray-200 rounded mb-3" />
              <div className="h-3 w-40 bg-gray-200 rounded" />
            </div>
            <div className="bg-white rounded-xl border border-gray-100 p-4 animate-pulse">
              <div className="h-3 w-24 bg-gray-200 rounded mb-3" />
              <div className="h-7 w-32 bg-gray-200 rounded mb-3" />
              <div className="h-3 w-40 bg-gray-200 rounded" />
            </div>
          </div>
          <div className="bg-white rounded-xl border border-gray-100 p-5 animate-pulse">
            <div className="h-4 w-40 bg-gray-200 rounded mb-4" />
            <div className="h-8 bg-gray-200 rounded" />
          </div>
        </div>
      )}

      {!loading && error && (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
          <p className="text-sm text-gray-600">โหลดข้อมูลไม่สำเร็จ</p>
          <p className="text-xs text-gray-400 mt-1">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 mt-4 bg-blue-900 hover:bg-blue-950 text-white text-xs font-medium px-4 py-2 rounded-lg transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            ลองอีกครั้ง
          </button>
        </div>
      )}

      {!loading && !error && (
        <>
          {/* สรุปงบการเงิน */}
          <section className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Wallet className="w-4 h-4 text-blue-900" />
                <h2 className="text-sm font-semibold text-gray-800">
                  สรุปงบการเงิน
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onNavigate("gl")}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-900 hover:text-blue-700 transition"
              >
                ดูบัญชีแยกประเภท
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
            {!summary || summary.totalsByCurrency.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <Wallet className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                <p className="text-sm font-medium text-gray-600">
                  {summary ? "ยังไม่มีข้อมูลงบการเงิน" : "โหลดข้อมูลงบการเงินไม่สำเร็จ"}
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  นำเข้า Statement เพื่อให้ระบบสร้างยอดบัญชีอัตโนมัติ
                </p>
              </div>
            ) : (
              <>
                {summary.totalsThb && (
                  <div className="mx-5 mt-5 rounded-xl bg-blue-50/60 border border-blue-100 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1">
                    <span className="text-xs font-semibold text-blue-900">
                      รวมทุกสกุลเป็นบาท
                    </span>
                    <span className="text-xs text-gray-600">
                      สินทรัพย์{" "}
                      <span className="font-semibold text-gray-800">
                        {fmtBaht(summary.totalsThb.assets)}
                      </span>
                    </span>
                    <span className="text-xs text-gray-600">
                      หนี้สิน{" "}
                      <span className="font-semibold text-gray-800">
                        {fmtBaht(summary.totalsThb.liabilities)}
                      </span>
                    </span>
                    <span className="text-xs text-gray-600">
                      ส่วนทุน{" "}
                      <span className="font-semibold text-gray-800">
                        {fmtBaht(summary.totalsThb.equity)}
                      </span>
                    </span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        summary.totalsThb.balanced
                          ? "bg-emerald-50 text-emerald-600"
                          : "bg-amber-50 text-amber-600"
                      }`}
                    >
                      {summary.totalsThb.balanced ? "สมดุล" : "ไม่สมดุล"}
                    </span>
                  </div>
                )}
                <div className="p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {summary.totalsByCurrency.map((t) => (
                  <div
                    key={t.currency}
                    className="rounded-xl border border-gray-100 p-4"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs text-gray-400">
                        งบดุล ({t.currency})
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          t.balanced
                            ? "bg-emerald-50 text-emerald-600"
                            : "bg-amber-50 text-amber-600"
                        }`}
                      >
                        {t.balanced ? "สมดุล" : "มีส่วนเกินสะสม"}
                      </span>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-500">
                          สินทรัพย์รวม
                        </span>
                        <span className="text-sm font-semibold text-gray-800 text-right">
                          {fmt(t.assets)}
                          <span className="block text-[11px] font-normal text-gray-400">
                            {fmtBaht(t.assetsThb)}
                          </span>
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-500">
                          หนี้สินรวม
                        </span>
                        <span className="text-sm font-semibold text-gray-800 text-right">
                          {fmt(t.liabilities)}
                          <span className="block text-[11px] font-normal text-gray-400">
                            {fmtBaht(t.liabilitiesThb)}
                          </span>
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-500">ส่วนทุน</span>
                        <span className="text-sm font-semibold text-gray-800 text-right">
                          {fmt(t.equity)}
                          <span className="block text-[11px] font-normal text-gray-400">
                            {fmtBaht(t.equityThb)}
                          </span>
                        </span>
                      </div>
                      {!t.balanced && (
                        <div className="border-t border-gray-100 pt-2 flex items-center justify-between">
                          <span className="text-xs text-gray-600">
                            ส่วนเกินสะสม
                          </span>
                          <span className="text-sm font-semibold text-blue-900">
                            {fmt(
                              (
                                Number(t.assets) -
                                Number(t.liabilities) -
                                Number(t.equity)
                              ).toFixed(2)
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                </div>
                </>
              )}
            </section>

          <div className="space-y-6">
            {/* การถือครองหุ้น */}
            <section className="bg-white rounded-xl border border-gray-100 overflow-hidden bg-clip-border">
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                <div className="flex items-center gap-2">
                  <Coins className="w-4 h-4 text-blue-900" />
                  <h2 className="text-sm font-semibold text-gray-800">
                    การถือครองหุ้น
                  </h2>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">
                    ต้นทุนเฉลี่ย
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate("gl")}
                  className="inline-flex items-center gap-1 text-xs font-medium text-blue-900 hover:text-blue-700 transition"
                >
                  ดูสมุดบัญชี
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
              {!holdings || holdings.length === 0 ? (
                <div className="px-5 py-10 text-center">
                  <Coins className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                  <p className="text-sm font-medium text-gray-600">
                    {holdings
                      ? "ยังไม่มีการถือครองหุ้น"
                      : "โหลดข้อมูลพอร์ตไม่สำเร็จ"}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    เมื่อมีการนำเข้า statement ที่มี BUY ระบบจะแสดงยอดคงค้างที่นี่
                  </p>
                </div>
              ) : (
                <>
                  <PortfolioChart
                    holdings={holdings}
                    quotes={quotes}
                    onOpenSymbol={onOpenSymbol}
                  />
                  <div className="overflow-auto max-h-72">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-white">
                      <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                        <th className="px-5 py-3 font-medium">สัญลักษณ์</th>
                        <th
                          className="px-5 py-3 font-medium text-right"
                          title="จำนวนหุ้นที่เหลือถืออยู่ ณ ปัจจุบัน"
                        >
                          จำนวนหน่วย (ถืออยู่)
                        </th>
                        <th
                          className="px-5 py-3 font-medium text-right"
                          title="ต้นทุนเฉลี่ยต่อ 1 หน่วย ที่ซื้อมาทั้งหมด"
                        >
                          ต้นทุนเฉลี่ย/หน่วย
                        </th>
                        <th
                          className="px-5 py-3 font-medium text-right"
                          title="จำนวนหน่วย × ต้นทุนเฉลี่ยต่อหน่วย = เงินที่ลงทุนสะสม"
                        >
                          ต้นทุนรวม
                        </th>
                        <th
                          className="px-5 py-3 font-medium text-right"
                          title="ราคาปิดล่าสุดของหุ้นตัวนี้ตามตลาด (อัปเดตรายวัน) — เพื่อแสดงผลเท่านั้น"
                        >
                          ราคาปัจจุบัน
                        </th>
                        <th
                          className="px-5 py-3 font-medium text-right"
                          title="ราคาปัจจุบัน × จำนวนหน่วยที่ถืออยู่ (สกุลเงินเดียวกับราคา)"
                        >
                          มูลค่าตลาด
                        </th>
                        <th
                          className="px-5 py-3 font-medium text-right"
                          title="(ราคาปัจจุบัน - ต้นทุนเฉลี่ย) × จำนวนหน่วย — กำไร/ขาดทุนที่ยังไม่รับรู้"
                        >
                          กำไร/ขาดทุน
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {holdings.map((h) => {
                        const quote = quoteForSymbol(quotes, h.symbol);
                        const marketValue = holdingMarketValue(h, quote);
                        const unrealized = holdingUnrealizedPnl(h, quote);
                        const pnl = unrealized !== null ? Number(unrealized) : null;
                        return (
                          <tr
                            key={h.symbol}
                            className="border-b border-gray-50 last:border-0"
                          >
                            <td className="px-5 py-3.5">
                              <button
                                type="button"
                                onClick={() => onOpenSymbol(h.symbol)}
                                title="ดูรายละเอียดหุ้นตัวนี้ (ธุรกรรม + กำไร/ขาดทุน)"
                                className="text-left group"
                              >
                                <p className="text-gray-800 font-semibold group-hover:text-blue-900 hover:underline transition">
                                  {h.symbol}
                                </p>
                                <p className="text-[11px] text-gray-400">
                                  อัปเดตล่าสุด {fmtDate(h.updatedAt)}
                                </p>
                              </button>
                            </td>
                            <td className="px-5 py-3.5 text-right text-gray-800 font-medium">
                              {fmtQty(h.quantity)}
                            </td>
                            <td className="px-5 py-3.5 text-right text-gray-800 font-medium">
                              {holdingCurrencyCode(h.symbol)}{" "}
                              {fmt(h.avgCost)}
                            </td>
                            <td className="px-5 py-3.5 text-right text-gray-800 font-semibold">
                              {holdingCurrencyCode(h.symbol)}{" "}
                              {fmt(holdingTotalCost(h))}
                            </td>
                            <td className="px-5 py-3.5 text-right text-gray-800 font-medium">
                              {quote ? (
                                <span className="inline-flex flex-col items-end">
                                  <span>
                                    {quote.currency}{" "}
                                    {fmt(String(quote.close))}
                                  </span>
                                  <span className="text-[11px] text-gray-400">
                                    ราคาวันที่ {fmtDate(quote.priceDate)}
                                  </span>
                                </span>
                              ) : (
                                <span className="text-gray-300">-</span>
                              )}
                            </td>
                            <td className="px-5 py-3.5 text-right text-gray-800 font-medium">
                              {quote && marketValue !== null ? (
                                `${quote.currency} ${fmt(marketValue)}`
                              ) : (
                                <span className="text-gray-300">-</span>
                              )}
                            </td>
                            <td className="px-5 py-3.5 text-right font-semibold">
                              {quote && pnl !== null ? (
                                <span
                                  className={
                                    pnl >= 0 ? "text-emerald-600" : "text-red-600"
                                  }
                                >
                                  {pnl >= 0 ? "+" : ""}
                                  {quote.currency} {fmt(unrealized ?? "")}
                                </span>
                              ) : (
                                <span className="text-gray-300">-</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="px-5 py-2.5 border-t border-gray-50">
                    <p className="text-[11px] text-gray-400">
                      จำนวนหน่วย = หุ้นที่เหลือถืออยู่ · ต้นทุนเฉลี่ย/หน่วย =
                      ราคาซื้อเฉลี่ยต่อ 1 หน่วย · ต้นทุนรวม = จำนวนหน่วย ×
                      ต้นทุนเฉลี่ย · ราคาปัจจุบัน/มูลค่าตลาด = ราคาปิดล่าสุดตาม
                      ตลาด (อัปเดตรายวัน) — เพื่อแสดงผลประกอบ · คลิกที่สัญลักษณ์เพื่อดูรายละเอียดหุ้นรายตัว ·
                      ตารางแสดง ~5 แถว เลื่อนลงเพื่อดูทั้งหมด
                    </p>
                  </div>
                </div>
                </>
              )}
            </section>

            {/* สรุปเงินเข้า/ออก */}
            <section className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                <div className="flex items-center gap-2">
                  <Wallet className="w-4 h-4 text-blue-900" />
                  <h2 className="text-sm font-semibold text-gray-800">
                    {cashView === "exchange"
                      ? "การแลกเปลี่ยนสกุลเงิน"
                      : "สรุปเงินเข้า/ออก"}
                  </h2>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">
                    {cashView === "exchange"
                      ? "ย้ายเงินระหว่างสกุล"
                      : "เฉพาะเงินเข้า/ออกบัญชี"}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onNavigate("cashflow")}
                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-900 hover:text-blue-700 transition"
                  >
                    ดูทั้งหมด
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* View switcher */}
              <div className="px-5 py-3 border-b border-gray-50 flex items-center gap-2 flex-wrap">
                {(["all", "month", "asOf", "exchange"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => loadCashView(v)}
                    className={`text-[11px] px-3 py-1.5 rounded-full font-medium transition ${
                      cashView === v
                        ? "bg-blue-900 text-white"
                        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}
                  >
                    {v === "all"
                      ? "ภาพรวม"
                      : v === "month"
                        ? "รายเดือน"
                        : v === "asOf"
                          ? "ตัดยอด ณ วันที่"
                          : "แลกเปลี่ยนสกุลเงิน"}
                  </button>
                ))}
                {cashView === "month" && (
                  <input
                    type="month"
                    value={cashMonth}
                    onChange={(e) => {
                      const v = e.target.value;
                      setCashMonth(v);
                      if (cashView === "month" && v) void loadCashView("month");
                    }}
                    className="ml-auto text-[11px] border border-gray-200 rounded px-2 py-1.5 text-gray-700"
                  />
                )}
                {cashView === "asOf" && (
                  <input
                    type="date"
                    value={cashAsOf}
                    onChange={(e) => {
                      const v = e.target.value;
                      setCashAsOf(v);
                      if (cashView === "asOf" && v) void loadCashView("asOf");
                    }}
                    className="ml-auto text-[11px] border border-gray-200 rounded px-2 py-1.5 text-gray-700"
                  />
                )}
              </div>

              {!cashSummary ? (
                <div className="px-5 py-10 text-center">
                  <Wallet className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                  <p className="text-sm font-medium text-gray-600">
                    โหลดข้อมูลสรุปเงินไม่สำเร็จ
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    รีเฟรชหน้านี้เพื่อลองอีกครั้ง
                  </p>
                </div>
              ) : cashDetailLoading ? (
                <div className="px-5 py-8 text-center">
                  <p className="text-xs text-gray-400">กำลังโหลด...</p>
                </div>
              ) : cashView === "exchange" ? (
                <ExchangeSection
                  exchanges={exchanges}
                  exchangeTotals={exchangeTotals}
                  dirTotals={dirTotals}
                  onViewAll={() => onNavigate("cashflow")}
                />
              ) : cashSummary.months.length === 0 &&
                (cashSummary.rows?.length ?? 0) === 0 ? (
                <div className="px-5 py-10 text-center">
                  <Wallet className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                  <p className="text-sm font-medium text-gray-600">
                    {cashView === "all"
                      ? "ยังไม่มีรายการเงินเข้า/ออก"
                      : "ไม่พบรายการเงินเข้า/ออกในช่วงนี้"}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    {cashView === "all"
                      ? "เงินฝากเข้าบัญชี (CASH_IN) และถอนออก (CASH_OUT) จะนับรวมที่นี่"
                      : cashView === "asOf"
                        ? "ลองเปลี่ยนวันที่ตัดยอดดูใหม่"
                        : "ลองเปลี่ยนเดือนดูใหม่"}
                  </p>
                </div>
              ) : (
                <div>
                  {/* Totals */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-5 py-4 border-b border-gray-50">
                    <div>
                      <p className="text-[11px] text-gray-400">
                        {cashView === "all"
                          ? "เงินเข้าทั้งหมด"
                          : cashView === "asOf"
                            ? `เงินเข้าสะสม (${fmtDate(cashAsOf)})`
                            : "เงินเข้า (เฉพาะช่วง)"}
                      </p>
                      <p className="text-sm font-semibold text-emerald-600">
                        +{fmt(cashSummary.totalCashInThb)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-gray-400">
                        {cashView === "all"
                          ? "เงินออกทั้งหมด"
                          : cashView === "asOf"
                            ? `เงินออกสะสม (${fmtDate(cashAsOf)})`
                            : "เงินออก (เฉพาะช่วง)"}
                      </p>
                      <p className="text-sm font-semibold text-red-600">
                        -{fmt(cashSummary.totalCashOutThb)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-gray-400">
                        {cashView === "asOf"
                          ? `ยอดสุทธิสะสม (${fmtDate(cashAsOf)})`
                          : "ยอดสุทธิ"}
                      </p>
                      <p
                        className={`text-sm font-semibold ${
                          Number(cashSummary.totalNetThb) >= 0
                            ? "text-blue-900"
                            : "text-red-600"
                        }`}
                      >
                        {fmt(cashSummary.totalNetThb)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-gray-400">
                        แลกเปลี่ยนสุทธิ
                      </p>
                      <p className="text-sm font-semibold text-gray-800 tabular-nums">
                        {Number(dirTotals.netThb) >= 0 ? "+" : "-"}
                        {fmt(Math.abs(Number(dirTotals.netThb)))}
                      </p>
                      <p className="text-[10px] text-gray-400">
                        กลับเข้า {dirTotals.intoThbCount} · ออก{" "}
                        {dirTotals.outOfThbCount} ครั้ง (ไม่รวมในยอดเงิน)
                      </p>
                    </div>
                  </div>

                  {cashView === "all" ? (
                    /* Monthly overview table + all-time chronological rows */
                    <>
                      <div className="overflow-auto max-h-72 border-b border-gray-50">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-white">
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
                            {cashSummary.months.map((m) => (
                              <tr
                                key={m.month}
                                className="border-b border-gray-50 last:border-0"
                              >
                                <td className="px-5 py-3.5 text-gray-800 font-medium">
                                  {fmtMonth(m.month)}
                                </td>
                                <td className="px-5 py-3.5 text-right text-emerald-600 font-medium">
                                  +{fmt(m.cashInThb)}
                                </td>
                                <td className="px-5 py-3.5 text-right text-red-600 font-medium">
                                  -{fmt(m.cashOutThb)}
                                </td>
                                <td className="px-5 py-3.5 text-right text-gray-800 font-semibold">
                                  {fmt(m.netThb)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="px-5 py-3 border-b border-gray-50">
                        <p className="text-xs font-semibold text-gray-700">
                          รายการทั้งหมด (
                          {cashRows.length} รายการ · เรียงตามวันที่)
                        </p>
                      </div>
                      <div className="overflow-auto max-h-72">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-white">
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
                            {(cashSummary.rows ?? []).length === 0 ? (
                              <tr>
                                <td
                                  colSpan={5}
                                  className="px-5 py-6 text-center text-xs text-gray-400"
                                >
                                  ยังไม่มีรายการเงินเข้า/ออกในบัญชี
                                </td>
                              </tr>
                            ) : (
                              cashRows.map((r) => (
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
                                      {r.type === "CASH_IN"
                                        ? "เงินเข้า"
                                        : "เงินออก"}
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
                                    {fmt(r.amountThb)}
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : cashView === "asOf" ? (
                    /* Detail rows table (as of) */
                    <>
                      <div className="px-5 py-3 border-b border-gray-50">
                        <p className="text-xs font-semibold text-gray-700">
                          รายการตัดยอดถึงวันที่ {fmtDate(cashAsOf)} ({cashRows.length} รายการ)
                        </p>
                      </div>
                      <div className="overflow-auto max-h-72">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-white">
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
                            {(cashSummary.rows ?? []).length === 0 ? (
                              <tr>
                                <td
                                  colSpan={6}
                                  className="px-5 py-6 text-center text-xs text-gray-400"
                                >
                                  ไม่พบรายการก่อนวันที่นี้
                                </td>
                              </tr>
                            ) : (
                              cashRows.map((r, i) => (
                                <tr
                                  key={r.transactionId}
                                  className="border-b border-gray-50 last:border-0"
                                >
                                  <td className="px-5 py-3.5 text-gray-800 font-medium">
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
                                    {fmt(r.amountThb)}
                                  </td>
                                  <td
                                    className={`px-5 py-3.5 text-right font-medium tabular-nums ${
                                      cashRunningBalance[i] >= 0
                                        ? "text-blue-900"
                                        : "text-red-600"
                                    }`}
                                  >
                                    {fmt(cashRunningBalance[i])}
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    /* Detail rows table (month) */
                    <>
                      <div className="px-5 py-3 border-b border-gray-50">
                        <p className="text-xs font-semibold text-gray-700">
                          รายการในเดือน {cashMonth} ({cashRows.length} รายการ)
                        </p>
                      </div>
                      <div className="overflow-auto max-h-72">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-white">
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
                            {(cashSummary.rows ?? []).length === 0 ? (
                              <tr>
                                <td
                                  colSpan={5}
                                  className="px-5 py-6 text-center text-xs text-gray-400"
                                >
                                  ไม่พบรายการ
                                </td>
                              </tr>
                            ) : (
                              cashRows.map((r) => (
                                <tr
                                  key={r.transactionId}
                                  className="border-b border-gray-50 last:border-0"
                                >
                                  <td className="px-5 py-3.5 text-gray-800 font-medium">
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
                                    {fmt(r.amountThb)}
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
                      {cashView === "all"
                        ? "รวมเฉพาะรายการโอนเงินเข้าออกบัญชี (ไม่รวม BUY/SELL) เป็นจำนวนเงินบาทตามอัตราที่บันทึก — ตารางล่างเรียงตามวันที่ (เก่าก่อน) · ตารางเลื่อนลงเพื่อดูทั้งหมด"
                        : cashView === "asOf"
                          ? "ยอดรวมเป็นยอดสะสมถึงวันที่ตัดยอด — คอลัมน์ยอดสะสม (THB) = ยอดสุทธิสะสมถึงแต่ละรายการ · ตารางเลื่อนลงเพื่อดูทั้งหมด"
                          : "แสดงเฉพาะรายการโอนเงินเข้าออกบัญชีในขอบเขตที่เลือก — เรียงตามวันที่ · ตารางเลื่อนลงเพื่อดูทั้งหมด"}
                    </p>
                  </div>
                </div>
              )}
            </section>
          </div>

        </>
      )}
    </div>
  );
}

/**
 * แถบสรุปการแลกเปลี่ยนสกุลเงินแบบย่อ (display-only).
 * ใช้ซ้ำในทั้ง 3 มุมมอง (ภาพรวม/รายเดือน/ตัดยอด) — ข้อมูลตาม scope ที่
 * server ส่งมาให้แล้ว ไม่คำนวณใหม่ ตารางเต็มดูที่หน้าเงินเข้า/ออก
 */
function ExchangeSection({
  exchanges,
  exchangeTotals,
  dirTotals,
  onViewAll,
}: {
  exchanges: CashSummaryExchangeRow[];
  exchangeTotals: CashSummaryExchangeTotal[];
  dirTotals: CashExchangeDirectionTotals;
  onViewAll: () => void;
}) {
  return (
    <div className="border-t border-gray-100 px-5 py-4">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <p className="text-xs font-semibold text-gray-700">
          การแลกเปลี่ยนสกุลเงิน
        </p>
        <button
          type="button"
          onClick={onViewAll}
          className="inline-flex items-center gap-1 text-xs font-medium text-blue-900 hover:text-blue-700 transition"
        >
          ดูทั้งหมด
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
      {exchangeTotals.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          {exchangeTotals.map((t) => (
            <span
              key={t.currency}
              className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-900 font-medium"
            >
              รวม {t.currency} {fmt(t.totalForeign)} ({fmt(t.totalThb)} THB)
            </span>
          ))}
        </div>
      )}
      {dirTotals.intoThbCount > 0 || dirTotals.outOfThbCount > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="border border-gray-100 rounded-lg px-3 py-2.5 text-center">
              <p className="text-[11px] text-gray-500 font-medium">
                เงินกลับเข้าบาท
              </p>
              <p className="text-sm font-bold text-gray-800 tabular-nums">
                {fmt(dirTotals.intoThbTotal)}{" "}
                <span className="text-[11px] font-medium">THB</span>
              </p>
              <p className="text-[11px] text-gray-400">
                {dirTotals.intoThbCount} ครั้ง
              </p>
            </div>
            <div className="border border-gray-100 rounded-lg px-3 py-2.5 text-center">
              <p className="text-[11px] text-gray-500 font-medium">
                เงินออกจากบาท
              </p>
              <p className="text-sm font-bold text-gray-800 tabular-nums">
                {fmt(dirTotals.outOfThbTotal)}{" "}
                <span className="text-[11px] font-medium">THB</span>
              </p>
              <p className="text-[11px] text-gray-400">
                {dirTotals.outOfThbCount} ครั้ง
              </p>
            </div>
          </div>
          <p
            className={`text-xs font-semibold text-center mt-2 ${
              dirTotals.moreInThanOut ? "text-emerald-600" : "text-red-500"
            }`}
          >
                          {dirTotals.moreInThanOut
                            ? `→ กลับเข้ามากว่า ${fmt(Math.abs(Number(dirTotals.netThb)))} บาท`
                            : `→ ออกไปมากกว่า ${fmt(Math.abs(Number(dirTotals.netThb)))} บาท`}
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-gray-400 text-center py-2">
                        ยังไม่มีรายการแลกเปลี่ยนสกุลเงินในช่วงนี้
                      </p>
                    )}
                    {exchanges.length > 0 && (
                      <div className="overflow-auto max-h-72 mt-3 border border-gray-100 rounded-lg">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-white">
                            <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                              <th className="px-4 py-2.5 font-medium">วันที่</th>
                              <th className="px-4 py-2.5 font-medium">ทิศทาง</th>
                              <th className="px-4 py-2.5 font-medium text-right">
                                จำนวนเงินต้นทาง
                              </th>
                              <th className="px-4 py-2.5 font-medium text-right">
                                จำนวนเงินปลายทาง
                              </th>
                              <th className="px-4 py-2.5 font-medium text-right">
                                อัตรา
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {exchanges.map((x) => (
                              <tr
                                key={x.transactionId}
                                className="border-b border-gray-50 last:border-0"
                              >
                                <td className="px-4 py-3 text-xs text-gray-800 font-medium whitespace-nowrap">
                                  {fmtDate(x.transactionDate)}
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap">
                                  <span
                                    className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${
                                      x.fromCurrency === "THB"
                                        ? "bg-blue-50 text-blue-900"
                                        : "bg-gray-100 text-gray-700"
                                    }`}
                                  >
                                    {x.fromCurrency ?? "ไม่ทราบสกุล"}
                                  </span>
                                  <span className="text-gray-400 mx-1">→</span>
                                  <span
                                    className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${
                                      x.toCurrency === "THB"
                                        ? "bg-blue-50 text-blue-900"
                                        : "bg-gray-100 text-gray-700"
                                    }`}
                                  >
                                    {x.toCurrency ?? "-"}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-right text-xs text-gray-800 font-medium whitespace-nowrap">
                                  {fmt(x.fromAmount)}{" "}
                                  <span className="text-[11px] text-gray-400 font-normal">
                                    {x.fromCurrency ?? ""}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-right text-xs text-gray-800 font-medium whitespace-nowrap">
                                  {fmt(x.toAmount)}{" "}
                                  <span className="text-[11px] text-gray-400 font-normal">
                                    {x.toCurrency ?? ""}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-right text-gray-600 text-xs tabular-nums">
                                  {x.rate == null ? "-" : fmt(x.rate)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
      <p className="text-[11px] text-gray-400 mt-2">
        การแลกเปลี่ยนเป็นการย้ายเงินสดระหว่างสกุล ไม่ใช่รายรับ/รายจ่าย
        {exchanges.length > 0 && ` · ${exchanges.length} รายการในขอบเขตนี้`}
      </p>
    </div>
  );
}

function fmt(v: string | number | undefined | null): string {
  const n = typeof v === "string" ? Number(v) : v ?? 0;
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function fmtBaht(v: string | number | undefined | null): string {
  const n = typeof v === "string" ? Number(v) : v ?? 0;
  if (!Number.isFinite(n)) return "-";
  return `฿${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtQty(v: string | undefined | null): string {
  const n = v === undefined || v === null ? 0 : Number(v);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });
}

function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function fmtDate(iso: string | undefined | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("th-TH");
}

function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-");
  if (!y || !m) return ym;
  const d = new Date(Number(y), Number(m) - 1, 1);
  if (Number.isNaN(d.getTime())) return ym;
  return d.toLocaleDateString("th-TH", {
    month: "short",
    year: "numeric",
  });
}