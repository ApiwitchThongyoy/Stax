import { useCallback, useEffect, useState } from "react";
import {
  BookOpenText,
  CalendarDays,
  Coins,
  NotebookPen,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  fetchTradingJournal,
  updateJournalNote,
  type TradingJournalEntry,
  type TradingJournalHolding,
  type TradingJournalResponse,
  type TradingJournalSide,
} from "../../lib/server-api";

interface Props {
  onOpenSymbol: (symbol: string) => void;
}

const SIDE_OPTIONS: Array<{ value: "" | TradingJournalSide; label: string }> = [
  { value: "", label: "ทุกประเภท" },
  { value: "BUY", label: "ซื้อ" },
  { value: "SELL", label: "ขาย" },
  { value: "DIVIDEND", label: "ได้ปันผล" },
];

function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${Number(d)} ${["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."][Number(m) - 1]} ${y}`;
}

function fmtNum(s: string | null): string {
  if (s === null || s === "") return "-";
  const n = Number(s);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function sideLabel(side: TradingJournalSide): string {
  switch (side) {
    case "BUY":
      return "ซื้อ";
    case "SELL":
      return "ขาย";
    case "DIVIDEND":
      return "ได้ปันผล";
    default:
      return "อื่น ๆ";
  }
}

function sideBadge(side: TradingJournalSide) {
  if (side === "BUY") {
    return (
      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-600">
        ซื้อ
      </span>
    );
  }
  if (side === "SELL") {
    return (
      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-50 text-red-600">
        ขาย
      </span>
    );
  }
  if (side === "DIVIDEND") {
    return (
      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-800">
        ได้ปันผล
      </span>
    );
  }
  return (
    <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-600">
      {sideLabel(side)}
    </span>
  );
}

/**
 * สมุดบันทึกการซื้อขายหุ้นประจำวัน: ทุกรายการซื้อ/ขาย/ปันผลเรียงตามวันที่
 * (10 คอลัมน์ตามสเปก แบ่งหน้า 20 รายการ/หน้า) + สรุปหุ้นในพอร์ตรายตัวที่ยังถืออยู่
 * (คงเหลือ + ผลตอบแทน).
 * ทุกตัวเลขมาจาก GET /api/v1/trading-journal — ไม่คำนวณใหม่ใน React.
 */
const PAGE_SIZE = 20;
export default function TradingJournalPage({ onOpenSymbol }: Props) {
  const { user } = useAuth();
  const accessToken = user?.accessToken ?? null;

  const [data, setData] = useState<TradingJournalResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"" | TradingJournalSide>("");
  const [page, setPage] = useState(1);

  // Changing any filter re-queries the server — always start back at page 1.
  useEffect(() => {
    setPage(1);
  }, [from, to, symbol, side]);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      setData(
        await fetchTradingJournal(accessToken, {
          from: from || undefined,
          to: to || undefined,
          symbol: symbol || undefined,
          side: side || undefined,
        })
      );
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "ไม่สามารถโหลดข้อมูลได้");
    } finally {
      setLoading(false);
    }
  }, [accessToken, from, to, symbol, side]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleNoteSaved = useCallback(
    (transactionId: string, note: string | null) => {
      setData((prev) =>
        prev
          ? {
              ...prev,
              entries: prev.entries.map((e) =>
                e.transactionId === transactionId ? { ...e, note } : e
              ),
            }
          : prev
      );
    },
    []
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white animate-pulse">
          <p className="text-2xl font-bold">สมุดบันทึกการซื้อขาย</p>
          <p className="text-blue-200/80 text-sm mt-1">กำลังโหลดข้อมูล...</p>
        </div>
        {[1, 2, 3].map((n) => (
          <div key={n} className="rounded-xl bg-gray-100 animate-pulse h-32" />
        ))}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <div className="bg-white rounded-xl border border-gray-100 px-6 py-10 text-center">
          <RefreshCw className="w-8 h-8 text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-600">
            โหลดสมุดบันทึกการซื้อขายไม่สำเร็จ
          </p>
          <p className="text-xs text-gray-400 mt-1">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-blue-900 hover:text-blue-700 transition"
          >
            ลองใหม่
          </button>
        </div>
      </div>
    );
  }

  const { entries, holdings, totals } = data;

  // Client-side paging over the server's full filtered list (20 rows/page).
  // safePage clamps after filters shrink the list while a later page was open.
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageRows = entries.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <div className="space-y-6">
      {/* Banner */}
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs uppercase tracking-wider text-blue-200/80">
          ตารางบันทึกการซื้อขายหุ้นประจำวัน
        </p>
        <p className="text-2xl font-bold mt-0.5">สมุดบันทึกการซื้อขาย</p>
        <p className="text-blue-200/80 text-sm mt-1">
          {totals.tradeCount} รายการ · ซื้อ {totals.buyCount} · ขาย{" "}
          {totals.sellCount} · ปันผล {totals.dividendCount}
        </p>
      </div>

      {/* Filters */}
      <section className="bg-white rounded-xl border border-gray-100 px-5 py-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-gray-500 font-medium">ตั้งแต่</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-2.5 py-2 text-gray-800"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-gray-500 font-medium">ถึง</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-2.5 py-2 text-gray-800"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-gray-500 font-medium">หุ้น</span>
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="เช่น NVDA"
              className="text-xs border border-gray-200 rounded-lg px-2.5 py-2 text-gray-800 w-28"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-gray-500 font-medium">ประเภท</span>
            <select
              value={side}
              onChange={(e) => setSide(e.target.value as "" | TradingJournalSide)}
              className="text-xs border border-gray-200 rounded-lg px-2.5 py-2 text-gray-800"
            >
              {SIDE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {(from || to || symbol || side) && (
            <button
              type="button"
              onClick={() => {
                setFrom("");
                setTo("");
                setSymbol("");
                setSide("");
              }}
              className="text-xs font-medium text-blue-900 hover:text-blue-700 transition px-2.5 py-2"
            >
              ล้างตัวกรอง
            </button>
          )}
        </div>
      </section>

      {/* สรุปหุ้นในพอร์ตรายตัว */}
      <section className="bg-white rounded-xl border border-gray-100 overflow-hidden bg-clip-border">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
          <Wallet className="w-4 h-4 text-blue-900" />
          <h2 className="text-sm font-semibold text-gray-800">
            สรุปหุ้นในพอร์ตรายตัว
          </h2>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">
            {holdings.length} ตัว
          </span>
        </div>
        {holdings.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Coins className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-600">
              ยังไม่มีหุ้นในพอร์ต
            </p>
            <p className="text-xs text-gray-400 mt-1">
              นำเข้า statement เพื่อดูสรุปการถือครอง
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 p-5">
            {holdings.map((h) => (
              <HoldingCard
                key={h.symbol}
                holding={h}
                onOpen={() => onOpenSymbol(h.symbol)}
              />
            ))}
          </div>
        )}
        {holdings.length > 0 && (
          <div className="px-5 pb-3">
            <p className="text-[11px] text-gray-400">
              มูลค่าตลาดอ้างอิงราคาปิดตลาดรายวัน (ไม่ใช่ราคา real-time) ·
              แสดงเฉพาะหุ้นที่ยังถืออยู่
              (หุ้นที่ขายหมดแล้วอยู่ในตารางด้านล่าง)
            </p>
          </div>
        )}
      </section>

      {/* ตารางบันทึกการซื้อขาย */}
      <section className="bg-white rounded-xl border border-gray-100 overflow-hidden bg-clip-border">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <BookOpenText className="w-4 h-4 text-blue-900" />
            <h2 className="text-sm font-semibold text-gray-800">
              บันทึกการซื้อขาย
            </h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">
              {entries.length} รายการ
            </span>
          </div>
          <CalendarDays className="w-4 h-4 text-gray-300" />
        </div>
        {entries.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <BookOpenText className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-600">
              ยังไม่มีรายการซื้อขายในช่วงที่เลือก
            </p>
            <p className="text-xs text-gray-400 mt-1">
              เปลี่ยนตัวกรองหรือนำเข้า statement ใหม่
            </p>
          </div>
        ) : (
          <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs whitespace-nowrap">
              <thead>
                <tr className="bg-gray-50 text-left text-gray-500">
                  <th className="px-3 py-2 font-medium">วัน/เดือน/ปี</th>
                  <th className="px-3 py-2 font-medium">ซื้อ/ขาย/ได้ปันผล</th>
                  <th className="px-3 py-2 font-medium">ชื่อย่อหุ้น</th>
                  <th className="px-3 py-2 font-medium text-right">ราคา</th>
                  <th className="px-3 py-2 font-medium text-right">
                    เงินปันผล/หุ้น
                  </th>
                  <th className="px-3 py-2 font-medium text-right">จำนวนหุ้น</th>
                  <th className="px-3 py-2 font-medium text-right">จำนวนเงิน</th>
                  <th className="px-3 py-2 font-medium text-right">
                    ค่าธรรมเนียม/ภาษี
                  </th>
                  <th className="px-3 py-2 font-medium text-right">
                    มูลค่าสุทธิ
                  </th>
                  <th className="px-3 py-2 font-medium text-right">
                    ต้นทุนเฉลี่ย/หุ้น
                  </th>
                  <th className="px-3 py-2 font-medium" aria-label="จดบันทึก" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {pageRows.map((e) => (
                  <JournalRow
                    key={e.transactionId}
                    entry={e}
                    onOpenSymbol={onOpenSymbol}
                    accessToken={accessToken}
                    onNoteSaved={handleNoteSaved}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {entries.length > PAGE_SIZE ? (
            <div className="flex items-center justify-between px-5 py-3 border-t border-gray-50">
              <p className="text-[11px] text-gray-500 tabular-nums">
                รายการ {pageStart + 1}–
                {Math.min(pageStart + PAGE_SIZE, entries.length)} จาก{" "}
                {entries.length} รายการ
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage(safePage - 1)}
                  disabled={safePage <= 1}
                  className="text-xs font-medium text-blue-900 hover:text-blue-700 disabled:opacity-40 disabled:pointer-events-none transition px-2.5 py-1.5"
                >
                  ก่อนหน้า
                </button>
                <span className="text-[11px] text-gray-500 tabular-nums">
                  หน้า {safePage}/{pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setPage(safePage + 1)}
                  disabled={safePage >= pageCount}
                  className="text-xs font-medium text-blue-900 hover:text-blue-700 disabled:opacity-40 disabled:pointer-events-none transition px-2.5 py-1.5"
                >
                  ถัดไป
                </button>
              </div>
            </div>
          ) : null}
          </>
        )}
        <div className="px-5 py-2.5 border-t border-gray-50">
          <p className="text-[11px] text-gray-400">
            ตัวเลขทั้งหมดมาจากเซิร์ฟเวอร์โดยตรง — ต้นทุนเฉลี่ย/หุ้นคือราคาเฉลี่ย
            ณ เวลาทำรายการนั้น (ไม่คำนวณใหม่ในหน้านี้) ·
            วันที่คือวันทำรายการจากสมุดรายวัน ·
            สมุดเล่มนี้แสดงเฉพาะการซื้อขายหุ้น (ซื้อ/ขาย/ปันผล) · แสดง 20
            รายการ/หน้า
          </p>
        </div>
      </section>
    </div>
  );
}

function JournalRow({
  entry: e,
  onOpenSymbol,
  accessToken,
  onNoteSaved,
}: {
  entry: TradingJournalEntry;
  onOpenSymbol: (symbol: string) => void;
  accessToken: string | null;
  onNoteSaved: (transactionId: string, note: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const openEditor = () => {
    setDraft(e.note ?? "");
    setSaveError(null);
    setEditing(true);
  };

  const save = async () => {
    if (!accessToken || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await updateJournalNote(accessToken, e.transactionId, draft);
      onNoteSaved(e.transactionId, saved);
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  };

  const noteButton = (
    <button
      type="button"
      onClick={openEditor}
      title="จดบันทึก"
      className="inline-flex items-center justify-center w-6 h-6 rounded text-gray-300 hover:text-blue-900 hover:bg-blue-50 transition"
    >
      <NotebookPen className="w-3.5 h-3.5" />
    </button>
  );

  const noteRows = (
    <>
      {e.note && !editing ? (
        <tr className="bg-amber-50/50">
          <td colSpan={11} className="px-3 py-1.5">
            <button
              type="button"
              onClick={openEditor}
              title="แก้ไขบันทึก"
              className="flex items-start gap-1.5 text-left text-[11px] text-gray-600 hover:text-gray-800 transition"
            >
              <NotebookPen className="w-3 h-3 mt-0.5 shrink-0 text-amber-600" />
              <span className="whitespace-normal break-words">{e.note}</span>
            </button>
          </td>
        </tr>
      ) : null}
      {editing ? (
        <tr className="bg-blue-50/50">
          <td colSpan={11} className="px-3 py-2">
            <textarea
              value={draft}
              onChange={(ev) => setDraft(ev.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="จดบันทึกของฉันเกี่ยวกับรายการนี้… (เหตุผลซื้อ/ขาย บทเรียน ความรู้สึก)"
              className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-2 text-gray-800 whitespace-normal"
            />
            {saveError ? (
              <p className="text-[11px] text-red-500 mt-1">{saveError}</p>
            ) : null}
            <div className="flex items-center gap-2 mt-1.5">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="text-xs font-medium text-white bg-blue-900 hover:bg-blue-800 disabled:opacity-50 rounded-lg px-3 py-1.5 transition"
              >
                {saving ? "กำลังบันทึก…" : "บันทึก"}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={saving}
                className="text-xs font-medium text-gray-500 hover:text-gray-700 transition px-2 py-1.5"
              >
                ยกเลิก
              </button>
              {e.note ? (
                <span className="text-[10px] text-gray-400">
                  ล้างข้อความแล้วกดบันทึกเพื่อลบโน้ต
                </span>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );

  return (
    <>
      <tr className="hover:bg-gray-50/60">
        <td className="px-3 py-2 text-gray-500">{fmtDate(e.date)}</td>
        <td className="px-3 py-2">{sideBadge(e.side)}</td>
        <td className="px-3 py-2">
          {e.symbol ? (
            <button
              type="button"
              onClick={() => onOpenSymbol(e.symbol as string)}
              className="font-semibold text-blue-900 hover:text-blue-700 hover:underline transition"
            >
              {e.symbol}
            </button>
          ) : (
            <span className="text-gray-400">-</span>
          )}
        </td>
        <td className="px-3 py-2 text-right text-gray-800 tabular-nums">
          {e.side === "BUY" || e.side === "SELL" ? (
            <>
              {fmtNum(e.price)}
              {e.currency ? (
                <span className="ml-1 text-[10px] text-gray-400 font-normal">
                  {e.currency}
                </span>
              ) : null}
            </>
          ) : (
            "-"
          )}
        </td>
        <td className="px-3 py-2 text-right text-gray-800 tabular-nums">-</td>
        <td className="px-3 py-2 text-right text-gray-800 tabular-nums">
          {e.quantity !== null ? fmtNum(e.quantity) : "-"}
        </td>
        <td className="px-3 py-2 text-right text-gray-800 tabular-nums">
          {fmtNum(e.amount)}
        </td>
        <td className="px-3 py-2 text-right text-gray-500 tabular-nums">
          {e.fees !== null ? fmtNum(e.fees) : "-"}
        </td>
        <td className="px-3 py-2 text-right text-gray-800 font-medium tabular-nums">
          {fmtNum(e.netAmount)}
        </td>
        <td className="px-3 py-2 text-right text-gray-800 tabular-nums">
          {e.avgCostAtTime !== null && e.avgCostAtTime !== undefined
            ? Number(e.avgCostAtTime).toLocaleString("en-US", {
                maximumFractionDigits: 4,
              })
            : "-"}
        </td>
        <td className="px-1 py-2 text-center">{noteButton}</td>
      </tr>
      {noteRows}
    </>
  );
}

function HoldingCard({
  holding: h,
  onOpen,
}: {
  holding: TradingJournalHolding;
  onOpen: () => void;
}) {
  const unrealized = h.unrealizedPnl ? Number(h.unrealizedPnl) : null;
  const realized = h.realizedPnlThb ? Number(h.realizedPnlThb) : null;
  return (
    <div className="border border-gray-100 rounded-xl px-4 py-3.5 hover:border-blue-100 transition">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onOpen}
          className="text-sm font-bold text-blue-900 hover:text-blue-700 hover:underline transition"
        >
          {h.symbol}
        </button>
        <span className="text-[10px] text-gray-400">
          {h.tradeCount} รายการ · ซื้อ {h.buyCount} · ขาย {h.sellCount}
          {h.dividendCount > 0 ? ` · ปันผล ${h.dividendCount}` : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-2 text-xs">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-gray-400">หุ้นคงเหลือ</span>
          <span className="text-gray-800 font-medium tabular-nums">
            {h.quantity !== null ? fmtNum(h.quantity) : "-"}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-gray-400">ต้นทุนเฉลี่ย</span>
          <span className="text-gray-800 font-medium tabular-nums">
            {h.avgCost !== null ? fmtNum(h.avgCost) : "-"}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-gray-400">มูลค่าตลาด (ราคาปิด)</span>
          <span className="text-gray-800 font-medium tabular-nums">
            {h.marketValue !== null ? fmtNum(h.marketValue) : "-"}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-gray-400">ผลตอบแทนยังไม่ขาย</span>
          <span
            className={`font-medium tabular-nums ${
              unrealized === null
                ? "text-gray-400"
                : unrealized >= 0
                  ? "text-emerald-600"
                  : "text-red-500"
            }`}
          >
            {unrealized === null ? (
              "-"
            ) : (
              <>
                {unrealized >= 0 ? <TrendingUp className="inline w-3 h-3 mr-0.5" /> : <TrendingDown className="inline w-3 h-3 mr-0.5" />}
                {fmtNum(h.unrealizedPnl)}
              </>
            )}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2 col-span-2">
          <span className="text-gray-400">กำไร/รายได้ที่รับรู้แล้ว (THB)</span>
          <span
            className={`font-medium tabular-nums ${
              realized === null
                ? "text-gray-400"
                : realized >= 0
                  ? "text-emerald-600"
                  : "text-red-500"
            }`}
          >
            {realized === null ? "-" : fmtNum(h.realizedPnlThb)}
          </span>
        </div>
      </div>
    </div>
  );
}
