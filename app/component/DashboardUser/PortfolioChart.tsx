import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  type CostBasisHolding,
  type StockPriceQuote,
  holdingMarketValue,
  quoteForSymbol,
} from "../../lib/server-api";

interface PortfolioChartProps {
  holdings: CostBasisHolding[];
  quotes: StockPriceQuote[];
  onOpenSymbol?: (symbol: string) => void;
}

interface Slice {
  symbol: string;
  value: number;
  currency: string;
}

const PALETTE = [
  "#1e3a8a",
  "#2563eb",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
];

const MAX_BARS = 8;

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * กราฟสัดส่วนพอร์ตหุ้น (display-only).
 * ใช้มูลค่าตลาดจาก helper เดิม `holdingMarketValue` (qty x ราคาปิดรายวัน)
 * ไม่คำนวณ P&L/FX ใหม่ — หุ้นที่ไม่มีราคาไม่รวมในกราฟ
 */
export default function PortfolioChart({
  holdings,
  quotes,
  onOpenSymbol,
}: PortfolioChartProps) {
  const { slices, total, missingCount } = useMemo(() => {
    const rows: Slice[] = [];
    let missing = 0;
    for (const h of holdings) {
      const quote = quoteForSymbol(quotes, h.symbol);
      const mv = holdingMarketValue(h, quote);
      const v = mv === null ? NaN : Number(mv);
      if (!quote || !Number.isFinite(v)) {
        missing += 1;
        continue;
      }
      rows.push({ symbol: h.symbol, value: v, currency: quote.currency });
    }
    rows.sort((a, b) => b.value - a.value);
    const sum = rows.reduce((acc, r) => acc + r.value, 0);
    return { slices: rows, total: sum, missingCount: missing };
  }, [holdings, quotes]);

  if (slices.length === 0) {
    return (
      <div className="px-5 pt-5">
        <div className="rounded-xl border border-gray-100 bg-gray-50/60 px-4 py-6 text-center">
          <p className="text-sm font-medium text-gray-600">
            ยังคำนวณสัดส่วนพอร์ตไม่ได้
          </p>
          <p className="text-xs text-gray-400 mt-1">
            ยังไม่มีราคาปิดรายวันสำหรับหุ้นที่ถืออยู่ — ตารางด้านล่างยังแสดงต้นทุนเฉลี่ยได้ตามปกติ
          </p>
        </div>
      </div>
    );
  }

  const bars = slices.slice(0, MAX_BARS);
  const othersCount = slices.length - bars.length;
  const currency = slices[0]?.currency ?? "";
  const withPct = slices.map((s) => ({
    ...s,
    pct: total > 0 ? (s.value / total) * 100 : 0,
  }));

  const handleSelect = (symbol: string) => {
    if (onOpenSymbol) onOpenSymbol(symbol);
  };

  return (
    <div className="px-5 pt-5">
      <div className="rounded-xl border border-gray-100 p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">
              สัดส่วนพอร์ตหุ้น
            </h3>
            <p className="text-[11px] text-gray-400">
              ตามมูลค่าตลาด (ราคาปิดรายวัน) · รวม {fmt(total)}{" "}
              {currency}
              {missingCount > 0
                ? ` · ไม่รวม ${missingCount} ตัวที่ยังไม่มีราคา`
                : ""}
            </p>
          </div>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">
            {slices.length} หุ้น
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
          {/* โดนัทสัดส่วนรายตัว */}
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip
                  contentStyle={{
                    borderRadius: 8,
                    border: "1px solid #e5e7eb",
                    fontSize: 12,
                  }}
                  formatter={(value, name) => {
                    const row = withPct.find((s) => s.symbol === name);
                    const num =
                      typeof value === "number" ? value : Number(value);
                    return [
                      `${fmt(num)} ${currency} (${row ? row.pct.toFixed(1) : "-"}%)`,
                      "มูลค่าตลาด",
                    ];
                  }}
                />
                <Pie
                  data={withPct}
                  dataKey="value"
                  nameKey="symbol"
                  innerRadius="58%"
                  outerRadius="88%"
                  paddingAngle={2}
                  stroke="#ffffff"
                  strokeWidth={2}
                  onClick={(data) => {
                    const sym = (data as { symbol?: string } | undefined)
                      ?.symbol;
                    if (sym) handleSelect(sym);
                  }}
                >
                  {withPct.map((s, i) => (
                    <Cell
                      key={s.symbol}
                      fill={PALETTE[i % PALETTE.length]}
                      style={{ cursor: onOpenSymbol ? "pointer" : "default" }}
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* แท่งมูลค่ารายตัว (Top 8) */}
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={bars}
                layout="vertical"
                margin={{ top: 0, right: 12, left: 8, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  horizontal={false}
                  stroke="#f3f4f6"
                />
                <XAxis
                  type="number"
                  hide
                  domain={[0, "dataMax"]}
                />
                <YAxis
                  type="category"
                  dataKey="symbol"
                  width={64}
                  tick={{ fontSize: 11, fill: "#4b5563" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: "#f9fafb" }}
                  contentStyle={{
                    borderRadius: 8,
                    border: "1px solid #e5e7eb",
                    fontSize: 12,
                  }}
                  formatter={(value) => [
                    `${fmt(Number(value))} ${currency}`,
                    "มูลค่าตลาด",
                  ]}
                />
                <Bar
                  dataKey="value"
                  radius={[0, 4, 4, 0]}
                  maxBarSize={18}
                  onClick={(data) => {
                    const sym = (data as { symbol?: string } | undefined)
                      ?.symbol;
                    if (sym) handleSelect(sym);
                  }}
                >
                  {bars.map((b, i) => (
                    <Cell
                      key={b.symbol}
                      fill={PALETTE[i % PALETTE.length]}
                      style={{ cursor: onOpenSymbol ? "pointer" : "default" }}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Legend รายตัว — คลิกเพื่อดูรายละเอียดหุ้น */}
        <div className="flex flex-wrap gap-1.5 mt-3">
          {withPct.map((s, i) => (
            <button
              key={s.symbol}
              type="button"
              onClick={() => handleSelect(s.symbol)}
              title={`${s.symbol}: ${fmt(s.value)} ${currency} (${s.pct.toFixed(1)}%) — คลิกเพื่อดูรายละเอียดหุ้น`}
              className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full bg-gray-50 hover:bg-gray-100 border border-gray-100 text-gray-700 transition"
            >
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
              />
              <span className="font-semibold">{s.symbol}</span>
              <span className="text-gray-400">{s.pct.toFixed(1)}%</span>
            </button>
          ))}
        </div>
        {othersCount > 0 && (
          <p className="text-[11px] text-gray-400 mt-2">
            กราฟแท่งแสดง {MAX_BARS} อันดับแรก · อีก {othersCount} ตัวดูได้จาก legend และตารางด้านล่าง
          </p>
        )}
        <p className="text-[11px] text-gray-400 mt-1">
          ราคาปิดรายวันเพื่อแสดงผลเท่านั้น ไม่ใช่ราคาเรียลไทม์ และไม่เกี่ยวข้องกับการคำนวณฐานภาษี
        </p>
      </div>
    </div>
  );
}
