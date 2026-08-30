// src/components/Dashboard/DailyCalendarExport.tsx
//
// ฟีเจอร์ "Daily Calendar & Export"
// - แสดงยอดเงินสุทธิรายวันและกำไรสะสม (cumulative P&L) ในรูปแบบปฏิทินรายเดือน
// - คลิกวันที่เพื่อดูรายการย่อยของวันนั้น
// - ส่งออกสรุปรายเดือนเป็น CSV หรือ Excel (.xlsx)

import { useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  FileText,
  CalendarDays,
  X,
} from "lucide-react";
import type { Transaction } from "../../lib/Financeutils";
import { parseRateString, formatTHB } from "../../lib/Financeutils";

interface DailyCalendarExportProps {
  transactions: Transaction[];
}

interface DaySummary {
  dateKey: string; // yyyy-mm-dd
  income: number;
  expense: number;
  netFlow: number;
  dailyPnl: number;
  cumulativePnl: number;
  transactions: Transaction[];
}

const THAI_MONTHS = [
  "มกราคม",
  "กุมภาพันธ์",
  "มีนาคม",
  "เมษายน",
  "พฤษภาคม",
  "มิถุนายน",
  "กรกฎาคม",
  "สิงหาคม",
  "กันยายน",
  "ตุลาคม",
  "พฤศจิกายน",
  "ธันวาคม",
];

const THAI_WEEKDAYS = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function dateKeyOf(year: number, month0: number, day: number): string {
  return `${year}-${pad2(month0 + 1)}-${pad2(day)}`;
}

function escapeCsvCell(value: string | number): string {
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export default function DailyCalendarExport({
  transactions,
}: DailyCalendarExportProps) {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth0, setViewMonth0] = useState(today.getMonth()); // 0-indexed
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState<"csv" | "xlsx" | null>(null);

  // รวมรายการต่อวัน (คำนวณเป็นหน่วยบาท เพื่อให้เทียบกันได้ข้ามสกุลเงิน)
  const dayMap = useMemo(() => {
    const map = new Map<
      string,
      { income: number; expense: number; dailyPnl: number; items: Transaction[] }
    >();

    const sorted = [...transactions].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0
    );

    for (const t of sorted) {
      const rate = parseRateString(t.rate);
      const amountTHB = t.amount * rate;
      const pnlTHB = t.pnlAmount * rate;

      const entry = map.get(t.date) ?? {
        income: 0,
        expense: 0,
        dailyPnl: 0,
        items: [],
      };

      if (amountTHB >= 0) entry.income += amountTHB;
      else entry.expense += Math.abs(amountTHB);

      entry.dailyPnl += pnlTHB;
      entry.items.push(t);
      map.set(t.date, entry);
    }

    return map;
  }, [transactions]);

  // สร้างลำดับกำไรสะสม (running total) ตามวันที่จากทุก transaction ที่มีอยู่จริง
  const cumulativeByDate = useMemo(() => {
    const dateKeys = [...dayMap.keys()].sort();
    const running = new Map<string, number>();
    let cumulative = 0;
    for (const key of dateKeys) {
      cumulative += dayMap.get(key)!.dailyPnl;
      running.set(key, cumulative);
    }
    return running;
  }, [dayMap]);

  // หากำไรสะสม ณ วันที่ที่กำหนด โดย carry-forward จากวันล่าสุดที่มีข้อมูลก่อนหน้า
  function cumulativeAsOf(dateKey: string): number {
    const keys = [...cumulativeByDate.keys()].sort();
    let value = 0;
    for (const key of keys) {
      if (key > dateKey) break;
      value = cumulativeByDate.get(key)!;
    }
    return value;
  }

  const daysInMonth = new Date(viewYear, viewMonth0 + 1, 0).getDate();
  const firstWeekday = new Date(viewYear, viewMonth0, 1).getDay(); // 0=อา

  const monthDays: DaySummary[] = useMemo(() => {
    const list: DaySummary[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const key = dateKeyOf(viewYear, viewMonth0, d);
      const entry = dayMap.get(key);
      list.push({
        dateKey: key,
        income: entry?.income ?? 0,
        expense: entry?.expense ?? 0,
        netFlow: (entry?.income ?? 0) - (entry?.expense ?? 0),
        dailyPnl: entry?.dailyPnl ?? 0,
        cumulativePnl: cumulativeAsOf(key),
        transactions: entry?.items ?? [],
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewYear, viewMonth0, daysInMonth, dayMap]);

  const monthTotals = useMemo(() => {
    return monthDays.reduce(
      (acc, d) => {
        acc.income += d.income;
        acc.expense += d.expense;
        acc.pnl += d.dailyPnl;
        return acc;
      },
      { income: 0, expense: 0, pnl: 0 }
    );
  }, [monthDays]);

  const monthEndCumulative =
    monthDays.length > 0 ? monthDays[monthDays.length - 1].cumulativePnl : 0;

  const selectedDay = monthDays.find((d) => d.dateKey === selectedDateKey);

  function goToPrevMonth() {
    setSelectedDateKey(null);
    if (viewMonth0 === 0) {
      setViewMonth0(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth0((m) => m - 1);
    }
  }

  function goToNextMonth() {
    setSelectedDateKey(null);
    if (viewMonth0 === 11) {
      setViewMonth0(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth0((m) => m + 1);
    }
  }

  function buildExportRows() {
    return monthDays.map((d) => ({
      วันที่: d.dateKey,
      เงินเข้า: Number(d.income.toFixed(2)),
      เงินออก: Number(d.expense.toFixed(2)),
      ยอดสุทธิรายวัน: Number(d.netFlow.toFixed(2)),
      "กำไร/ขาดทุนรายวัน": Number(d.dailyPnl.toFixed(2)),
      กำไรสะสม: Number(d.cumulativePnl.toFixed(2)),
    }));
  }

  function handleExportCsv() {
    setExportBusy("csv");
    try {
      const rows = buildExportRows();
      const headers = Object.keys(rows[0] ?? {
        วันที่: "",
        เงินเข้า: "",
        เงินออก: "",
        ยอดสุทธิรายวัน: "",
        "กำไร/ขาดทุนรายวัน": "",
        กำไรสะสม: "",
      });
      const lines = [
        headers.map(escapeCsvCell).join(","),
        ...rows.map((row) =>
          headers.map((h) => escapeCsvCell((row as Record<string, unknown>)[h] as string | number)).join(",")
        ),
      ];
      // ใส่ BOM เพื่อให้ Excel เปิดภาษาไทยได้ถูกต้อง
      const csvContent = "\uFEFF" + lines.join("\r\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `รายงานรายวัน_${viewYear}-${pad2(viewMonth0 + 1)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setExportBusy(null);
    }
  }

  async function handleExportExcel() {
    setExportBusy("xlsx");
    try {
      // ต้องติดตั้งไลบรารี xlsx ในโปรเจกต์: npm install xlsx
      const XLSX = await import("xlsx");
      const rows = buildExportRows();
      const worksheet = XLSX.utils.json_to_sheet(rows);
      worksheet["!cols"] = [
        { wch: 12 },
        { wch: 14 },
        { wch: 14 },
        { wch: 16 },
        { wch: 18 },
        { wch: 14 },
      ];
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        workbook,
        worksheet,
        `${viewYear}-${pad2(viewMonth0 + 1)}`
      );
      XLSX.writeFile(
        workbook,
        `รายงานรายวัน_${viewYear}-${pad2(viewMonth0 + 1)}.xlsx`
      );
    } finally {
      setExportBusy(null);
    }
  }

  // ตำแหน่งของ cell ว่างก่อนวันที่ 1 ของเดือน
  const leadingBlanks = Array.from({ length: firstWeekday });

  return (
    <div className="space-y-6">
      {/* Header + month nav + export */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-900 flex items-center justify-center shrink-0">
              <CalendarDays className="w-4 h-4 text-white" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-800">
                ปฏิทินยอดเงินรายวัน
              </h2>
              <p className="text-xs text-gray-400">
                สรุปยอดเงินและกำไรสะสมรายวัน
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={exportBusy !== null}
              className="flex items-center gap-1.5 border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-3 py-2 rounded-lg transition disabled:opacity-50 cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5 " />
              {exportBusy === "csv" ? "กำลังส่งออก..." : "ส่งออก CSV"}
            </button>
            <button
              type="button"
              onClick={handleExportExcel}
              disabled={exportBusy !== null}
              className="flex items-center gap-1.5 bg-blue-900 hover:bg-blue-950 text-white text-xs font-medium px-3 py-2 rounded-lg transition disabled:opacity-50 cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              {exportBusy === "xlsx" ? "กำลังส่งออก..." : "ส่งออก Excel"}
            </button>
          </div>
        </div>

        {/* Month navigator */}
        <div className="flex items-center justify-between mt-5 mb-3">
          <button
            type="button"
            onClick={goToPrevMonth}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:bg-gray-50 transition"
            aria-label="เดือนก่อนหน้า"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <p className="text-sm font-semibold text-gray-800">
            {THAI_MONTHS[viewMonth0]} {viewYear + 543}
          </p>
          <button
            type="button"
            onClick={goToNextMonth}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:bg-gray-50 transition"
            aria-label="เดือนถัดไป"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Weekday header */}
        <div className="grid grid-cols-7 gap-2 mb-2">
          {THAI_WEEKDAYS.map((w) => (
            <div
              key={w}
              className="text-center text-xs sm:text-sm font-semibold text-gray-500 py-1.5"
            >
              {w}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-2">
          {leadingBlanks.map((_, i) => (
            <div key={`blank-${i}`} className="rounded-lg" />
          ))}
          {monthDays.map((d) => {
            const dayNum = Number(d.dateKey.split("-")[2]);
            const hasActivity = d.transactions.length > 0;
            const isSelected = d.dateKey === selectedDateKey;
            const isPositive = d.netFlow >= 0;

            return (
              <button
                key={d.dateKey}
                type="button"
                onClick={() =>
                  setSelectedDateKey(isSelected ? null : d.dateKey)
                }
                className={`min-h-19 sm:min-h-23 rounded-lg border p-2 flex flex-col items-start justify-between text-left transition ${
                  isSelected
                    ? "border-blue-900 bg-blue-50"
                    : hasActivity
                    ? "border-gray-200 hover:border-blue-300 bg-white"
                    : "border-gray-100 bg-gray-50/50 hover:bg-gray-50"
                }`}
              >
                <span
                  className={`text-sm sm:text-base font-semibold ${
                    hasActivity ? "text-gray-800" : "text-gray-300"
                  }`}
                >
                  {dayNum}
                </span>
                {hasActivity && (
                  <span
                    className={`text-xs sm:text-sm font-bold leading-tight break-all ${
                      isPositive ? "text-emerald-600" : "text-red-500"
                    }`}
                  >
                    {isPositive ? "+" : "-"}
                    {Math.abs(d.netFlow).toLocaleString(undefined, {
                      maximumFractionDigits: 0,
                    })}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Month summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <p className="text-xs text-gray-400 mb-1.5">เงินเข้ารวมทั้งเดือน</p>
          <p className="text-lg font-semibold text-emerald-600">
            {formatTHB(monthTotals.income)}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <p className="text-xs text-gray-400 mb-1.5">เงินออกรวมทั้งเดือน</p>
          <p className="text-lg font-semibold text-red-500">
            {formatTHB(monthTotals.expense)}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <p className="text-xs text-gray-400 mb-1.5">กำไรสะสม ณ สิ้นเดือน</p>
          <p
            className={`text-lg font-semibold ${
              monthEndCumulative >= 0 ? "text-gray-800" : "text-red-600"
            }`}
          >
            {formatTHB(monthEndCumulative)}
          </p>
        </div>
      </div>

      {/* Selected day detail */}
      {selectedDay && (
        <div className="bg-white rounded-xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-800">
              รายการวันที่ {selectedDay.dateKey}
            </h3>
            <button
              type="button"
              onClick={() => setSelectedDateKey(null)}
              className="text-gray-400 hover:text-gray-600 transition"
              aria-label="ปิด"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {selectedDay.transactions.length === 0 ? (
            <p className="text-xs text-gray-400">ไม่มีรายการในวันนี้</p>
          ) : (
            <div className="space-y-2">
              {selectedDay.transactions.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between border-b border-gray-50 last:border-0 pb-2 last:pb-0"
                >
                  <div>
                    <p className="text-sm text-gray-800 font-medium">
                      {t.description}
                    </p>
                    {t.subLabel && (
                      <p className="text-xs text-gray-400">{t.subLabel}</p>
                    )}
                  </div>
                  <div className="text-right">
                    {t.income && (
                      <p className="text-sm text-emerald-600 font-medium">
                        {t.income}
                      </p>
                    )}
                    {t.expense && (
                      <p className="text-sm text-red-500 font-medium">
                        {t.expense}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-100 text-xs">
            <span className="text-gray-400">ยอดสุทธิวันนี้</span>
            <span
              className={`font-semibold ${
                selectedDay.netFlow >= 0 ? "text-emerald-600" : "text-red-500"
              }`}
            >
              {formatTHB(selectedDay.netFlow)}
            </span>
          </div>
          <div className="flex items-center justify-between mt-1 text-xs">
            <span className="text-gray-400">กำไรสะสม ณ วันนี้</span>
            <span
              className={`font-semibold ${
                selectedDay.cumulativePnl >= 0
                  ? "text-gray-700"
                  : "text-red-500"
              }`}
            >
              {formatTHB(selectedDay.cumulativePnl)}
            </span>
          </div>
        </div>
      )}

      <p className="flex items-center gap-1.5 text-[11px] text-gray-400">
        <Download className="w-3 h-3" />
        การส่งออกจะรวมข้อมูลทั้งเดือนที่กำลังแสดงอยู่บนปฏิทิน
      </p>
    </div>
  );
}