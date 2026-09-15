import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Activity,
  Coins,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  fetchPortfolioDetail,
  type CapitalLedgerRow,
  type PortfolioDetail,
} from "../../lib/server-api";

interface StockDetailPageProps {
  symbol: string;
  onBack: () => void;
}

/**
 * Per-stock case-by-case view: all of THIS symbol's ledger rows plus the current
 * holding, latest price and server-authoritative realized totals. Everything is
 * rendered verbatim from GET /api/v1/portfolio/:symbol — no P&L/tax recompute in
 * React (same honesty rules as the rest of the app).
 */
export default function StockDetailPage({
  symbol,
  onBack,
}: StockDetailPageProps) {
  const { user } = useAuth();
  const accessToken = user?.accessToken ?? null;

  const [detail, setDetail] = useState<PortfolioDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      setDetail(await fetchPortfolioDetail(accessToken, symbol));
    } catch (e) {
      setDetail(null);
      const raw = e instanceof Error ? e.message : "ไม่สามารถโหลดข้อมูลได้";
      setNotFound(raw.includes("not found") ? true : false);
      setError(raw);
    } finally {
      setLoading(false);
    }
  }, [accessToken, symbol]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRetry = () => {
    void load();
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-900 hover:text-blue-700 transition"
        >
          <ArrowLeft className="w-4 h-4" />
          กลับหน้าหลัก
        </button>
        <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white animate-pulse">
          <p className="text-2xl font-bold">{symbol}</p>
          <p className="text-blue-200/80 text-sm mt-1">กำลังโหลดข้อมูล...</p>
        </div>
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            className="rounded-xl bg-gray-100 animate-pulse h-32"
          />
        ))}
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-900 hover:text-blue-700 transition"
        >
          <ArrowLeft className="w-4 h-4" />
          กลับหน้าหลัก
        </button>
        <div className="bg-white rounded-xl border border-gray-100 px-6 py-12 text-center">
          <TrendingDown className="w-8 h-8 text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-600">
            ไม่พบหุ้น {symbol} ในบัญชีของคุณ
          </p>
          <p className="text-xs text-gray-400 mt-1">
            ไม่พบธุรกรรมหรือการถือครองสำหรับสัญลักษณ์นี้
          </p>
        </div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-900 hover:text-blue-700 transition"
        >
          <ArrowLeft className="w-4 h-4" />
          กลับหน้าหลัก
        </button>
        <div className="bg-white rounded-xl border border-gray-100 px-6 py-10 text-center">
          <RefreshCw className="w-8 h-8 text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-600">
            โหลดข้อมูลหุ้น {symbol} ไม่สำเร็จ
          </p>
          <p className="text-xs text-gray-400 mt-1">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-blue-900 hover:text-blue-700 transition"
          >
            ลองใหม่
          </button>
        </div>
      </div>
    );
  }

  const { holding, quote, totals, trades } = detail;
  const hasQuote = quote !== null;
  const marketValue = holding?.marketValue
    ? Number(holding.marketValue)
    : null;
  const unrealized = holding?.unrealizedPnl
    ? Number(holding.unrealizedPnl)
    : null;
  const realized = totals.totalRealizedThb
    ? Number(totals.totalRealizedThb)
    : null;

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-900 hover:text-blue-700 transition"
      >
        <ArrowLeft className="w-4 h-4" />
        กลับหน้าหลัก
      </button>

      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-blue-200/80">
              รายละเอียดหุ้นรายตัว
            </p>
            <p className="text-2xl font-bold mt-0.5">{detail.symbol}</p>
          </div>
          <div className="flex items-center gap-6 text-right">
            <div>
              <p className="text-[11px] text-blue-200/80">ถือครอง</p>
              <p className="text-lg font-semibold">
                {holding ? fmtQty(holding.quantity) : "—"}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-blue-200/80">ราคาปัจจุบัน</p>
              <p className="text-lg font-semibold">
                {hasQuote
                  ? `${quote!.currency} ${fmt(quote!.close)}`
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-blue-200/80">
                กำไร/ขาดทุนที่รับรู้แล้ว (บาท)
              </p>
              <p
                className={`text-lg font-semibold ${
                  realized == null
                    ? "text-blue-200/80"
                    : realized >= 0
                      ? "text-emerald-300"
                      : "text-red-300"
                }`}
              >
                {realized == null ? "ยังคำนวณไม่ได้" : `${realized >= 0 ? "+" : ""}${fmt(realized)}`}
              </p>
            </div>
          </div>
        </div>
        {quote && (
          <p className="text-[11px] text-blue-200/70 mt-2">
            ราคาวันที่ {fmtDate(quote.priceDate)} · แหล่งอ้างอิง{" "}
            {quote.source ?? "ราคารายวัน"} — เพื่อแสดงผลประกอบเท่านั้น
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* การถือครอง */}
        <section className="bg-white rounded-xl border border-gray-100 overflow-hidden bg-clip-border">
          <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
            <Coins className="w-4 h-4 text-blue-900" />
            <h2 className="text-sm font-semibold text-gray-800">การถือครอง</h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">
              ต้นทุนเฉลี่ย
            </span>
          </div>
          {holding ? (
            <div className="px-5 py-4 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">จำนวนหน่วย (ถืออยู่)</span>
                <span className="text-gray-800 font-semibold">
                  {fmtQty(holding.quantity)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">ต้นทุนเฉลี่ย/หน่วย</span>
                <span className="text-gray-800 font-medium">
                  {fmt(holding.avgCost)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">ต้นทุนรวม</span>
                <span className="text-gray-800 font-semibold">
                  {fmt(holding.totalCost)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">ซื้อสะสม (หน่วย)</span>
                <span className="text-gray-800 font-medium">
                  {fmtQty(holding.cumQuantity)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">เงินลงทุนสะสม</span>
                <span className="text-gray-800 font-medium">
                  {fmt(holding.cumCost)}
                </span>
              </div>
              <p className="text-[11px] text-gray-400 pt-2 border-t border-gray-50">
                อัปเดตล่าสุด {fmtDate(holding.updatedAt)}
              </p>
            </div>
          ) : (
            <div className="px-5 py-8 text-center">
              <p className="text-sm font-medium text-gray-600">
                ไม่ได้ถือหุ้นตัวนี้แล้ว
              </p>
              <p className="text-xs text-gray-400 mt-1">
                ขายหมดแล้ว หรือเป็นหุ้นที่เคยมีธุรกรรมแต่ไม่มีคงค้าง
              </p>
            </div>
          )}
        </section>

        {/* ราคาและมูลค่าตลาด */}
        <section className="bg-white rounded-xl border border-gray-100 overflow-hidden bg-clip-border">
          <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
            <Activity className="w-4 h-4 text-blue-900" />
            <h2 className="text-sm font-semibold text-gray-800">
              ราคาและมูลค่าตลาด
            </h2>
          </div>
          <div className="px-5 py-4 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">ราคาปัจจุบัน</span>
              <span className="text-gray-800 font-semibold">
                {hasQuote ? `${quote!.currency} ${fmt(quote!.close)}` : "—"}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">มูลค่าตลาด</span>
              <span className="text-gray-800 font-medium">
                {marketValue != null
                  ? `${quote!.currency} ${fmt(marketValue)}`
                  : "—"}
              </span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-gray-500">กำไร/ขาดทุน (ยังไม่รับรู้)</span>
              <span
                className={`inline-flex items-center gap-1 font-semibold ${
                  unrealized == null
                    ? "text-gray-300"
                    : unrealized >= 0
                      ? "text-emerald-600"
                      : "text-red-600"
                }`}
              >
                {unrealized == null ? (
                  "—"
                ) : (
                  <>
                    {unrealized >= 0 ? (
                      <TrendingUp className="w-3.5 h-3.5" />
                    ) : (
                      <TrendingDown className="w-3.5 h-3.5" />
                    )}
                    {unrealized >= 0 ? "+" : ""}
                    {quote?.currency ?? ""} {fmt(unrealized)}
                  </>
                )}
              </span>
            </div>
            <p className="text-[11px] text-gray-400 pt-2 border-t border-gray-50">
              (ราคาปิด − ต้นทุนเฉลี่ย) × จำนวนถืออยู่ · อิงราคาปิดรายวัน{" "}
              {quote ? `วันที่ ${fmtDate(quote.priceDate)}` : "ที่ยังไม่มี"}
              — เพื่อแสดงผลประกอบเท่านั้น
            </p>
          </div>
        </section>

        {/* กำไร/ขาดทุนที่รับรู้แล้ว */}
        <section className="bg-white rounded-xl border border-gray-100 overflow-hidden bg-clip-border">
          <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
            <TrendingUp className="w-4 h-4 text-blue-900" />
            <h2 className="text-sm font-semibold text-gray-800">
              กำไร/ขาดทุนที่รับรู้แล้ว
            </h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">
              บาท
            </span>
          </div>
          <div className="px-5 py-4 space-y-3">
            <div>
              <p className="text-xl font-bold">
                {realized == null ? (
                  <span className="text-gray-400">ยังคำนวณไม่ได้</span>
                ) : (
                  <span
                    className={
                      realized >= 0 ? "text-emerald-600" : "text-red-600"
                    }
                  >
                    {realized >= 0 ? "+" : ""}
                    {fmt(realized)} ฿
                  </span>
                )}
              </p>
              <p className="text-[11px] text-gray-400 mt-1">
                รวมจาก SELL {totals.computableSellCount} รายการที่คำนวณได้ (THB)
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-gray-50">
              <div>
                <p className="text-lg font-bold text-gray-800">
                  {totals.sellCount}
                </p>
                <p className="text-[11px] text-gray-500">รายการขาย (SELL)</p>
              </div>
              <div>
                <p className="text-lg font-bold text-gray-800">
                  {totals.buyCount}
                </p>
                <p className="text-[11px] text-gray-500">รายการซื้อ (BUY)</p>
              </div>
            </div>
            {totals.nonComputableSellCount > 0 && (
              <div className="bg-amber-50 border border-amber-200 text-amber-700 text-xs px-3 py-2 rounded-lg">
                SELL ที่ยังคำนวณไม่ได้ {totals.nonComputableSellCount} รายการ
                (ขาดประวัติต้นทุนก่อนหน้า) — ไม่นับรวมในยอดด้านบน
              </div>
            )}
            {totals.sellCount === 0 && (
              <p className="text-[11px] text-gray-400">
                ยังไม่มีการขายหุ้นตัวนี้ กำไร/ขาดทุนที่รับรู้แล้วจึงยังไม่มี
              </p>
            )}
          </div>
        </section>
      </div>

      {/* ธุรกรรมทั้งหมดของหุ้นตัวนี้ */}
      <section className="bg-white rounded-xl border border-gray-100 overflow-hidden bg-clip-border">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Coins className="w-4 h-4 text-blue-900" />
            <h2 className="text-sm font-semibold text-gray-800">
              ธุรกรรมทั้งหมดของ {detail.symbol}
            </h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">
              {totals.tradeCount} รายการ
            </span>
          </div>
          {totals.cashCount > 0 && (
            <span className="text-[11px] text-gray-400">
              รวมเงิน/รายได้อื่น {totals.cashCount} รายการ
            </span>
          )}
        </div>
        {trades.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Coins className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-600">
              ยังไม่มีธุรกรรมในระบบ
            </p>
            <p className="text-xs text-gray-400 mt-1">
              นำเข้า statement ที่มีหุ้นตัวนี้เพื่อดูรายละเอียด
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs whitespace-nowrap">
              <thead>
                <tr className="bg-gray-50 text-left text-gray-500">
                  <th className="px-3 py-2 font-medium">วันที่</th>
                  <th className="px-3 py-2 font-medium">รายการ</th>
                  <th className="px-3 py-2 font-medium">ฝั่ง</th>
                  <th className="px-3 py-2 font-medium text-right">จำนวน</th>
                  <th className="px-3 py-2 font-medium text-right">
                    ราคา/หน่วย
                  </th>
                  <th className="px-3 py-2 font-medium text-right">
                    มูลค่ารวม
                  </th>
                  <th className="px-3 py-2 font-medium text-right">
                    ค่าธรรมเนียม
                  </th>
                  <th className="px-3 py-2 font-medium text-right">
                    เงินเข้า/ออก
                  </th>
                  <th className="px-3 py-2 font-medium text-right">
                    อัตรา FX
                  </th>
                  <th className="px-3 py-2 font-medium text-right">
                    กำไร/ขาดทุน (THB)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {trades.map((r) => (
                  <TradeRow key={r.transactionId} row={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function TradeRow({ row: r }: { row: CapitalLedgerRow }) {
  return (
    <tr className="hover:bg-gray-50/60">
      <td className="px-3 py-2 text-gray-500">{r.transactionDate}</td>
      <td className="px-3 py-2 text-gray-800 font-medium">
        {r.symbol ? `${r.symbol} · ${r.section ?? ""}` : r.section}
      </td>
      <td className="px-3 py-2">
        {r.side === "BUY" ? (
          <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-600">
            BUY
          </span>
        ) : r.side === "SELL" ? (
          <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-50 text-red-600">
            SELL
          </span>
        ) : (
          <span className="text-gray-300">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right text-gray-700">
        {r.quantity ?? "—"}
      </td>
      <td className="px-3 py-2 text-right text-gray-700">
        {r.unitPrice ?? "—"}
      </td>
      <td className="px-3 py-2 text-right text-gray-700">
        {r.grossAmount ?? "—"}
      </td>
      <td className="px-3 py-2 text-right text-gray-700">{r.fees ?? "—"}</td>
      <td
        className={`px-3 py-2 text-right font-medium ${
          r.type === "CASH_OUT" ? "text-red-500" : "text-emerald-600"
        }`}
      >
        {r.type === "CASH_OUT" ? "-" : "+"}
        {Number(r.amountForeign).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}{" "}
        {r.currency}
      </td>
      <td className="px-3 py-2 text-right text-gray-700">
        {r.fxRateEffective ?? "—"}
      </td>
      <td
        className={`px-3 py-2 text-right font-medium ${
          r.realizedGainLossThb != null &&
          Number(r.realizedGainLossThb) >= 0
            ? "text-emerald-600"
            : r.realizedGainLossThb != null
              ? "text-red-500"
              : "text-gray-300"
        }`}
      >
        {r.realizedGainLossThb != null
          ? `${Number(r.realizedGainLossThb) >= 0 ? "+" : ""}${Number(r.realizedGainLossThb).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}`
          : "—"}
      </td>
    </tr>
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

function fmtQty(v: string | number | undefined | null): string {
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