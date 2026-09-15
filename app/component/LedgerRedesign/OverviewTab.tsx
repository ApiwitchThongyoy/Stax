import { useCallback, useEffect, useState } from "react";
import { Coins, PieChart, RefreshCw, TrendingUp, Wallet } from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  type CostBasisHolding,
  type GeneralLedgerSummary,
  type StockPriceQuote,
  fetchCostBasis,
  fetchLedgerSummary,
  fetchStockQuotes,
  holdingCurrencyCode,
  holdingTotalCost,
} from "../../lib/server-api";
import PortfolioChart from "../DashboardUser/PortfolioChart";

const TYPE_LABELS: Record<string, string> = {
  ASSET: "สินทรัพย์",
  LIABILITY: "หนี้สิน",
  EQUITY: "ส่วนทุน",
  INCOME: "รายได้",
  EXPENSE: "ค่าใช้จ่าย",
};

export default function OverviewTab({
  onOpenSymbol,
}: {
  /** เจาะดูหุ้นรายตัว (เหมือนหน้าหลัก) — ไม่ส่งมาก็แสดงกราฟอย่างเดียว */
  onOpenSymbol?: (symbol: string) => void;
}) {
  const { user } = useAuth();
  const accessToken = user?.accessToken ?? null;

  const [summary, setSummary] = useState<GeneralLedgerSummary | null>(null);
  const [holdings, setHoldings] = useState<CostBasisHolding[] | null>(null);
  const [quotes, setQuotes] = useState<StockPriceQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const [s, h] = await Promise.all([
        fetchLedgerSummary(accessToken),
        fetchCostBasis(accessToken),
      ]);
      setSummary(s);
      setHoldings(h);
      if (h && h.length > 0) {
        const q = await Promise.allSettled([
          fetchStockQuotes(
            accessToken,
            h.map((x) => x.symbol)
          ),
        ]);
        setQuotes(q[0].status === "fulfilled" ? q[0].value : []);
      } else {
        setQuotes([]);
      }
    } catch {
      setError("โหลดข้อมูลภาพรวมไม่สำเร็จ (เซิร์ฟเวอร์ไม่ตอบกลับ)");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const balanceSheetRows =
    summary?.groups.filter(
      (g) => g.type === "ASSET" || g.type === "LIABILITY" || g.type === "EQUITY"
    ) ?? [];

  const totalsBar = summary?.totalsByCurrency ?? [];

  return (
    <div className="space-y-6">
      {/* Banner */}
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">ภาพรวมการเงิน</p>
        <h1 className="text-xl font-semibold mb-1.5">สถานะบัญชีโดยรวม</h1>
        <p className="text-sm text-blue-200">
          ยอดเงินสด สินทรัพย์ หนี้สิน ส่วนทุน และการถือครองหุ้น อ้างอิงจากข้อมูล
          ทางการเงินของท่านโดยตรง
        </p>
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

      {!loading && !error && summary && (
        <>
          {summary.totalsThb && (
            <div className="rounded-xl bg-blue-50/60 border border-blue-100 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1">
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
          {/* Per-currency balance sheet totals */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {totalsBar.length === 0 && (
              <div className="bg-white rounded-xl border border-gray-100 p-4 sm:col-span-full">
                <p className="text-sm text-gray-500">ยังไม่มีข้อมูลงบดุล</p>
              </div>
            )}
            {totalsBar.map((t) => (
              <div
                key={t.currency}
                className="bg-white rounded-xl border border-gray-100 p-4"
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
                    <span className="text-xs text-gray-500">หนี้สินรวม</span>
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
                        ส่วนเกินสะสม (สินทรัพย์ − หนี้สิน − ส่วนทุน)
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

          {/* Accounts by balance-sheet type */}
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
              <PieChart className="w-4 h-4 text-blue-900" />
              <h2 className="text-sm font-semibold text-gray-800">
                บัญชีแยกตามหมวด
              </h2>
            </div>
            {balanceSheetRows.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <Wallet className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                <p className="text-sm font-medium text-gray-600">
                  ยังไม่มีบัญชีสินทรัพย์/หนี้สิน/ส่วนทุน
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  เริ่มบันทึกหรือนำเข้า statement เพื่อให้ระบบสร้างยอดอัตโนมัติ
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                      <th className="px-5 py-3 font-medium">หมวด</th>
                      <th className="px-5 py-3 font-medium">บัญชี</th>
                      <th className="px-5 py-3 font-medium">สกุลเงิน</th>
                      <th className="px-5 py-3 font-medium text-right">
                        ยอดคงเหลือ
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {balanceSheetRows.map((g) => (
                      <tr
                        key={`${g.type}|${g.currency}|${g.total}`}
                        className="border-b border-gray-50 last:border-0"
                      >
                        <td className="px-5 py-3 align-top">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-medium">
                            {TYPE_LABELS[g.type]}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <div className="space-y-1">
                            {g.accounts.map((a) => (
                              <p key={a.code} className="text-gray-800 font-medium">
                                {a.code} · {a.name}
                              </p>
                            ))}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-gray-500 align-top">
                          {g.currency}
                        </td>
                        <td className="px-5 py-3 text-right align-top">
                          <span className="font-semibold text-gray-800">
                            {fmt(g.total)}
                          </span>
                          <span className="block text-xs font-normal text-gray-400">
                            {fmtBaht(g.totalThb)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Holdings */}
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
              <TrendingUp className="w-4 h-4 text-blue-900" />
              <h2 className="text-sm font-semibold text-gray-800">
                การถือครองหุ้น
              </h2>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">
                ต้นทุนเฉลี่ย
              </span>
            </div>
            {!holdings || holdings.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <Coins className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                <p className="text-sm font-medium text-gray-600">
                  ยังไม่มีการถือครองหุ้น
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
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
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
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map((h) => (
                      <tr
                        key={h.symbol}
                        className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60 transition"
                      >
                        <td className="px-5 py-3.5">
                          {onOpenSymbol ? (
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
                          ) : (
                            <>
                              <p className="text-gray-800 font-semibold">
                                {h.symbol}
                              </p>
                              <p className="text-[11px] text-gray-400">
                                อัปเดตล่าสุด {fmtDate(h.updatedAt)}
                              </p>
                            </>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-right text-gray-800 font-medium">
                          {fmtQty(h.quantity)}
                        </td>
                        <td className="px-5 py-3.5 text-right text-gray-800 font-medium">
                          {holdingCurrencyCode(h.symbol)} {fmt(h.avgCost)}
                        </td>
                        <td className="px-5 py-3.5 text-right text-gray-800 font-semibold">
                          {holdingCurrencyCode(h.symbol)}{" "}
                          {fmt(holdingTotalCost(h))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="px-5 py-2.5 border-t border-gray-50">
                  <p className="text-[11px] text-gray-400">
                    จำนวนหน่วย = หุ้นที่เหลือถืออยู่ · ต้นทุนเฉลี่ย/หน่วย =
                    ราคาซื้อเฉลี่ยต่อ 1 หน่วย · ต้นทุนรวม = จำนวนหน่วย ×
                    ต้นทุนเฉลี่ย สกุลเงินประมาณจากสัญลักษณ์ ·
                    คลิกที่สัญลักษณ์เพื่อดูรายละเอียดหุ้นรายตัว
                  </p>
                </div>
                </div>
              </>
            )}
          </div>
        </>
      )}
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

function fmtDate(iso: string | undefined | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("th-TH");
}