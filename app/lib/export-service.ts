import { eq } from "drizzle-orm";
import { db } from "./drizzle-db";
import { capitalTransactions } from "../db/schema";

export type ExportFormat = "csv" | "xlsx";

export interface ExportOptions {
  userId: string;
  format: ExportFormat;
  dateFrom?: string;
  dateTo?: string;
}

export interface ExportResult {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

interface ExportRow {
  วันที่: string;
  ประเภท: string;
  สกุลเงิน: string;
  "จำนวนเงิน (ต่างชาติ)": number;
  "อัตราแลกเปลี่ยน": number;
  "จำนวนเงิน (บาท)": number;
  "แหล่งที่มา": string;
}

const TYPE_LABELS: Record<string, string> = {
  CASH_IN: "เงินเข้า",
  CASH_OUT: "เงินออก",
};

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  const d = dateStr.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return dateStr;
}

function toNumber(value: string | number | null | undefined): number {
  const num = typeof value === "number" ? value : parseFloat(value ?? "");
  return Number.isNaN(num) ? 0 : num;
}

function escapeCsvCell(value: string | number): string {
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

async function queryTransactions(userId: string, dateFrom?: string, dateTo?: string) {
  const conditions = [eq(capitalTransactions.userId, userId)];

  if (dateFrom) {
    const { gte } = await import("drizzle-orm");
    conditions.push(gte(capitalTransactions.transactionDate, dateFrom));
  }
  if (dateTo) {
    const { lte } = await import("drizzle-orm");
    conditions.push(lte(capitalTransactions.transactionDate, dateTo));
  }

  const { and } = await import("drizzle-orm");
  const rows = await db
    .select()
    .from(capitalTransactions)
    .where(and(...conditions))
    .execute();

  return rows;
}

function buildExportRows(
  rows: Awaited<ReturnType<typeof queryTransactions>>
): ExportRow[] {
  return rows.map((row) => ({
    วันที่: formatDate(row.transactionDate),
    ประเภท: TYPE_LABELS[row.type] ?? row.type,
    สกุลเงิน: row.currency,
    "จำนวนเงิน (ต่างชาติ)": toNumber(row.amountForeign),
    "อัตราแลกเปลี่ยน": toNumber(row.fxRateEffective ?? row.fxRateBot),
    "จำนวนเงิน (บาท)": toNumber(row.amountThb),
    "แหล่งที่มา": row.sourceType,
  }));
}

function generateCsv(rows: ExportRow[]): Buffer {
  const headers = [
    "วันที่",
    "ประเภท",
    "สกุลเงิน",
    "จำนวนเงิน (ต่างชาติ)",
    "อัตราแลกเปลี่ยน",
    "จำนวนเงิน (บาท)",
    "แหล่งที่มา",
  ];

  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) =>
      headers.map((h) => escapeCsvCell((row as unknown as Record<string, unknown>)[h] as string | number)).join(",")
    ),
  ];

  // BOM for UTF-8 so Excel opens Thai text correctly
  const csvContent = "\uFEFF" + lines.join("\r\n");
  return Buffer.from(csvContent, "utf-8");
}

async function generateXlsx(rows: ExportRow[]): Promise<Buffer> {
  const XLSX = await import("xlsx");

  const data = rows.length > 0
    ? rows
    : [{ วันที่: "ไม่มีธุรกรรม", ประเภท: "", สกุลเงิน: "", "จำนวนเงิน (ต่างชาติ)": "", "อัตราแลกเปลี่ยน": "", "จำนวนเงิน (บาท)": "", "แหล่งที่มา": "" }];

  const worksheet = XLSX.utils.json_to_sheet(data);

  worksheet["!cols"] = [
    { wch: 14 }, // วันที่
    { wch: 12 }, // ประเภท
    { wch: 12 }, // สกุลเงิน
    { wch: 20 }, // จำนวนเงิน (ต่างชาติ)
    { wch: 16 }, // อัตราแลกเปลี่ยน
    { wch: 18 }, // จำนวนเงิน (บาท)
    { wch: 20 }, // แหล่งที่มา
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Capital Transactions");

  const buffer: Buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  });

  return buffer;
}

/**
 * Export capital transactions for a specific user.
 * Enforces user isolation — only exports data belonging to the authenticated user.
 *
 * @param options.userId - Authenticated user's ID (from JWT)
 * @param options.format - "csv" or "xlsx"
 * @param options.dateFrom - Optional start date (YYYY-MM-DD)
 * @param options.dateTo - Optional end date (YYYY-MM-DD)
 * @returns ExportResult with buffer, content type, and filename
 */
export async function exportCapitalTransactions(
  options: ExportOptions
): Promise<ExportResult> {
  const { userId, format, dateFrom, dateTo } = options;

  if (!userId) {
    throw new Error("userId is required for export");
  }

  const rows = await queryTransactions(userId, dateFrom, dateTo);
  const exportRows = buildExportRows(rows);

  const timestamp = new Date().toISOString().slice(0, 10);
  let buffer: Buffer;
  let contentType: string;
  let extension: string;

  if (format === "xlsx") {
    buffer = await generateXlsx(exportRows);
    contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    extension = "xlsx";
  } else {
    buffer = generateCsv(exportRows);
    contentType = "text/csv; charset=utf-8";
    extension = "csv";
  }

  const filename = `capital_transactions_${timestamp}.${extension}`;

  return { buffer, contentType, filename };
}
