// หมายเหตุสำคัญ: ห้าม import "pdfjs-dist" แบบ static ที่ด้านบนไฟล์
// เพราะโปรเจกต์นี้ใช้ SSR (React Router v7) — ถ้า import แบบ static ตอน server
// จะพยายามรันโค้ดของ pdf.js ไปด้วย แล้วไปเจอ DOMMatrix ซึ่งมีแค่ในเบราว์เซอร์เท่านั้น
// จึงต้อง import "pdfjs-dist" แบบ dynamic ข้างในฟังก์ชันที่ถูกเรียกจากฝั่ง client เท่านั้น
async function loadPdfJs() {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).toString();
  return pdfjsLib;
}

export interface ExtractedTransaction {
  id: string;
  date: string; // dd/mm/yyyy ตามที่เจอในเอกสาร
  description: string;
  subLabel?: string;
  currency: string;
  amount: number; // บวก = เงินเข้า, ลบ = เงินออก
  rate?: string;
  section: string; // ป้ายกำกับที่มาของรายการ เช่น "เงินฝาก", "เงินปันผล"
  included: boolean; // ติ๊กเลือกไว้ให้ตอน preview
}

interface PositionedItem {
  x: number;
  str: string;
}

// ---------- Step 1: อ่านไฟล์ PDF แล้วจัดเรียงข้อความใหม่เป็น "แถว" ตามตำแหน่งจริงบนหน้ากระดาษ ----------
// เหตุผลที่ต้องทำแบบนี้แทนการดึง text ตรงๆ: ตารางใน PDF มักเก็บลำดับตัวอักษรไม่ตรงกับที่ตาเห็น
// (คอลัมน์ขวาอาจถูกเก็บไว้ก่อนคอลัมน์ซ้าย) การจัดกลุ่มตามแกน Y แล้วเรียงตามแกน X ในแต่ละกลุ่ม
// ทำให้ได้ข้อความที่เรียงจากซ้ายไปขวาเหมือนที่มองเห็นจริงในแต่ละบรรทัด
async function extractRows(file: File): Promise<string[]> {
  const pdfjsLib = await loadPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const rows: string[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    const rowMap = new Map<number, PositionedItem[]>();

    for (const item of content.items as any[]) {
      if (typeof item.str !== "string" || item.str.trim() === "") continue;
      const y = item.transform[5] as number;
      const x = item.transform[4] as number;
      // รวมรายการที่ตำแหน่ง Y ใกล้เคียงกัน (ในระยะ 3px) ให้อยู่แถวเดียวกัน
      const bucketKey = Math.round(y / 3) * 3;
      if (!rowMap.has(bucketKey)) rowMap.set(bucketKey, []);
      rowMap.get(bucketKey)!.push({ x, str: item.str });
    }

    // เรียงจากบนลงล่าง (ค่า Y มากกว่า = อยู่บนกว่าใน PDF)
    const sortedKeys = Array.from(rowMap.keys()).sort((a, b) => b - a);

    for (const key of sortedKeys) {
      const rowItems = rowMap.get(key)!.sort((a, b) => a.x - b.x);
      const rowText = rowItems
        .map((i) => i.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (rowText) rows.push(rowText);
    }
  }

  return rows;
}

// ---------- Helpers ----------
function toIsoDate(ddmmyyyy: string): string {
  const [d, m, y] = ddmmyyyy.split("/");
  return `${y}-${m}-${d}`;
}

function toNumber(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `extracted-${Date.now()}-${counter}`;
}

// ---------- Step 2: หา "อัตราแลกเปลี่ยนฐาน" จากหัวเอกสาร เช่น "USD/THB = 31.055" ----------
function extractBaseRates(fullText: string): Record<string, string> {
  const rates: Record<string, string> = { THB: "1" };
  const matches = fullText.matchAll(/([A-Z]{3})\/THB\s*=\s*([\d.]+)/g);
  for (const m of matches) {
    rates[m[1]] = m[2];
  }
  return rates;
}

// ---------- Step 3: ดึงรายการแต่ละประเภทจากแถวที่จัดเรียงแล้ว ----------
export function parseStatementRows(rows: string[]): ExtractedTransaction[] {
  const fullText = rows.join("\n");
  const baseRates = extractBaseRates(fullText);
  const results: ExtractedTransaction[] = [];

  const sectionSlice = (startMarker: string, endMarkers: string[]): string => {
    const startIdx = fullText.indexOf(startMarker);
    if (startIdx === -1) return "";
    let endIdx = fullText.length;
    for (const marker of endMarkers) {
      const idx = fullText.indexOf(marker, startIdx + startMarker.length);
      if (idx !== -1 && idx < endIdx) endIdx = idx;
    }
    return fullText.slice(startIdx, endIdx);
  };

  // --- เงินฝาก / เงินถอน ---
  const depositWithdrawBlock = sectionSlice("DEPOSIT & WITHDRAWAL RECORDS", [
    "CURRENCY EXCHANGE RECORDS",
    "DIVIDENDS",
  ]);
  if (depositWithdrawBlock) {
    const depositsIdx = depositWithdrawBlock.indexOf("Deposits");
    const withdrawalsIdx = depositWithdrawBlock.indexOf("Withdrawals");
    const rowPattern = /^(\d{2}\/\d{2}\/\d{4})\s+([A-Z]{3})\s+(.+?)\s+(-?[\d,]+\.\d{2})$/gm;

    for (const m of depositWithdrawBlock.matchAll(rowPattern)) {
      const [, date, currency, remark, amountStr] = m;
      const amount = toNumber(amountStr);
      const matchIdx = m.index ?? 0;
      const isWithdrawal =
        withdrawalsIdx !== -1 && matchIdx > withdrawalsIdx && (depositsIdx === -1 || withdrawalsIdx > depositsIdx);

      results.push({
        id: nextId(),
        date,
        description: remark.trim(),
        subLabel: isWithdrawal ? "ถอนเงิน" : "ฝากเงิน",
        currency,
        amount: isWithdrawal ? -Math.abs(amount) : Math.abs(amount),
        rate: baseRates[currency] ?? "-",
        section: isWithdrawal ? "ถอนเงิน" : "ฝากเงิน",
        included: true,
      });
    }
  }

  // --- แลกเปลี่ยนสกุลเงิน (ข้อมูลอ้างอิง ไม่ใช่รายรับ/รายจ่ายจริง จึงติ๊กไว้เป็น "ไม่รวม" โดยดีฟอลต์) ---
  const currencyExchangeBlock = sectionSlice("CURRENCY EXCHANGE RECORDS", ["DIVIDENDS", "INTEREST"]);
  if (currencyExchangeBlock) {
    const rowPattern =
      /^(\d{2}\/\d{2}\/\d{4})\s+\d{2}:\d{2}:\d{2},GMT[+-]\d{2}\s+([A-Z]{3})\s+([\d,]+\.\d{2})\s+([A-Z]{3})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{4})$/gm;

    for (const m of currencyExchangeBlock.matchAll(rowPattern)) {
      const [, date, fromCcy, fromAmt, toCcy, toAmt, rate] = m;
      results.push({
        id: nextId(),
        date,
        description: `แลกเปลี่ยน ${fromCcy} → ${toCcy}`,
        subLabel: `${fromCcy} ${fromAmt} → ${toCcy} ${toAmt} (อัตรา ${rate})`,
        currency: toCcy,
        amount: toNumber(toAmt),
        rate,
        section: "แลกเปลี่ยนสกุลเงิน",
        included: false,
      });
    }
  }

  // --- เงินปันผล ---
  const dividendBlock = sectionSlice("DIVIDENDS", ["INTEREST WHT", "INTEREST", "NOTES"]);
  if (dividendBlock) {
    const rowPattern =
      /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+([A-Z]{3})\s+([\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/gm;

    for (const m of dividendBlock.matchAll(rowPattern)) {
      const [, date, desc, currency, , , netAmt] = m;
      results.push({
        id: nextId(),
        date,
        description: desc.trim(),
        subLabel: "เงินปันผล",
        currency,
        amount: toNumber(netAmt),
        rate: baseRates[currency] ?? "-",
        section: "เงินปันผล",
        included: true,
      });
    }
  }

  // --- ดอกเบี้ย และ ภาษีหัก ณ ที่จ่ายดอกเบี้ย ---
  for (const [marker, label, endMarkers] of [
    ["INTEREST WHT", "ภาษีหัก ณ ที่จ่าย (ดอกเบี้ย)", ["NOTES"]],
    ["INTEREST", "ดอกเบี้ย", ["INTEREST WHT", "NOTES"]],
  ] as const) {
    const block = sectionSlice(marker, endMarkers as unknown as string[]);
    if (!block) continue;
    const rowPattern = /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+([A-Z]{3})\s+(-?[\d,]+\.\d{2})$/gm;
    for (const m of block.matchAll(rowPattern)) {
      const [, date, desc, currency, amountStr] = m;
      results.push({
        id: nextId(),
        date,
        description: desc.trim(),
        subLabel: label,
        currency,
        amount: toNumber(amountStr),
        rate: baseRates[currency] ?? "-",
        section: label,
        included: true,
      });
    }
  }

  // --- รายการซื้อขายหุ้น ---
  const tradeBlock = sectionSlice("TRADE RECORDS", ["PORTFOLIO SUMMARY"]);
  if (tradeBlock) {
    const lines = tradeBlock.split("\n");
    let currentCurrency = "USD";
    const tradeRowPattern =
      /^(.+?)\s+(\d{2}\/\d{2}\/\d{4})\s+\d{2}:\d{2}:\d{2},GMT[+-]\d{2}\s+\d{2}\/\d{2}\/\d{4}\s+(BUY|SELL)\s+([\d.]+)\s+([\d.]+)\s+([\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(\S.*)$/;

    for (let i = 0; i < lines.length; i++) {
      const currencyMatch = lines[i].match(/^Currency:\s*([A-Z]{3})$/);
      if (currencyMatch) {
        currentCurrency = currencyMatch[1];
        continue;
      }

      const m = lines[i].match(tradeRowPattern);
      if (!m) continue;

      const [, name, date, side, qty, price, , netAmt] = m;
      const symbolLine = i > 0 ? lines[i - 1].trim() : "";
      const description = `${symbolLine} ${name.trim()}`.trim();
      const net = toNumber(netAmt);

      results.push({
        id: nextId(),
        date,
        description,
        subLabel: `${side === "BUY" ? "ซื้อ" : "ขาย"} ${qty} หุ้น @ ${price} ${currentCurrency}`,
        currency: currentCurrency,
        amount: side === "BUY" ? -Math.abs(net) : Math.abs(net),
        rate: baseRates[currentCurrency] ?? "-",
        section: side === "BUY" ? "ซื้อหุ้น" : "ขายหุ้น",
        included: true,
      });
    }
  }

  // เรียงตามวันที่ล่าสุดก่อน
  results.sort((a, b) => (a.date < b.date ? 1 : -1));
  return results;
}

// ---------- Entry point ที่ component เรียกใช้ ----------
export async function parsePdfStatement(file: File): Promise<ExtractedTransaction[]> {
  if (typeof window === "undefined") {
    throw new Error("parsePdfStatement ใช้งานได้เฉพาะฝั่งเบราว์เซอร์เท่านั้น");
  }
  const rows = await extractRows(file);
  return parseStatementRows(rows);
}