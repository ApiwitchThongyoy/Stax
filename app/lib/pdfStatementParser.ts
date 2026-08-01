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

// ประเภทบัญชีตามหลักบัญชีคู่ (double-entry) แบบย่อ:
// - "income"  : รายได้จริง (เงินปันผล, ดอกเบี้ย, กำไรจากการขายหุ้น) → นับในกำไร/ขาดทุน
// - "expense" : ค่าใช้จ่ายจริง (ค่าธรรมเนียม, VAT, ภาษีหัก ณ ที่จ่าย) → นับในกำไร/ขาดทุน (เป็นลบ)
// - "equity"  : เงินทุน (ฝาก/ถอน) → ไม่ใช่กำไรขาดทุน แค่เงินเข้า-ออกจากบัญชี
// - "asset"   : การแลกเปลี่ยนสินทรัพย์ (ซื้อ/ขายหุ้นในส่วนเงินต้น, แลกเงินตรา) → ไม่ใช่กำไรขาดทุน
export type TransactionCategory = "income" | "expense" | "equity" | "asset";

export interface ExtractedTransaction {
  id: string;
  date: string; // dd/mm/yyyy ตามที่เจอในเอกสาร
  description: string;
  subLabel?: string;
  currency: string;
  amount: number; // ยอดเงินสดจริงที่เกิดขึ้น (บวก = เงินเข้า, ลบ = เงินออก) ใช้แสดงในสมุดบัญชี
  category: TransactionCategory;
  pnlAmount: number; // ส่วนที่ "นับเป็นกำไร/ขาดทุนจริง" ตามหลักบัญชี (0 ถ้าไม่ใช่รายการกำไรขาดทุน) ในสกุลเงินเดิม
  rate?: string;
  section: string; // ป้ายกำกับที่มาของรายการ เช่น "เงินฝาก", "เงินปันผล"
  included: boolean; // ติ๊กเลือกไว้ให้ตอน preview
}

// ---------- ต้นทุนเฉลี่ยสะสม (running average cost) ต่อสัญลักษณ์หุ้น ----------
// เก็บสถานะนี้ไว้ข้าม session (localStorage) เพื่อให้แม่นยำขึ้นเรื่อยๆ ทุกครั้งที่ import statement เดือนใหม่
export interface CostBasisEntry {
  quantity: number;
  avgCost: number; // ต้นทุนเฉลี่ยต่อหุ้น ในสกุลเงินของหุ้นตัวนั้น
}
export type CostBasisMap = Record<string, CostBasisEntry>;

const COST_BASIS_STORAGE_KEY = "stax_cost_basis";

export function loadCostBasis(): CostBasisMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(COST_BASIS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CostBasisMap) : {};
  } catch {
    return {};
  }
}

export function saveCostBasis(costBasis: CostBasisMap) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(COST_BASIS_STORAGE_KEY, JSON.stringify(costBasis));
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
function toNumber(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `extracted-${Date.now()}-${counter}`;
}

// แปลง dd/mm/yyyy เป็นตัวเลขเปรียบเทียบได้ (yyyymmdd) ไว้ใช้เรียงลำดับเวลา
function toSortableDate(ddmmyyyy: string): number {
  const [d, m, y] = ddmmyyyy.split("/");
  return parseInt(`${y}${m}${d}`, 10);
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

// ---------- Step 3: หาต้นทุนเฉลี่ย + จำนวนหุ้นปัจจุบัน ของแต่ละสัญลักษณ์ จากตาราง "PORTFOLIO SUMMARY" ----------
// ใช้เป็น "จุดเริ่มต้น" (seed) เท่านั้น สำหรับสัญลักษณ์ที่เรายังไม่เคยมีประวัติสะสมมาก่อน
// (ครั้งแรกที่ import หุ้นตัวนั้น หรือกรณีไม่มีข้อมูล localStorage มาก่อนเลย)
//
// หมายเหตุสำคัญ: ชื่อบริษัทสั้นๆ (เช่น "SPDR® Gold Shares") มักอยู่บรรทัดเดียวกับแถวตัวเลขได้
// แต่ชื่อยาว (เช่น "JPMorgan Nasdaq Equity Premium Income ETF", "BIGBEAR AI HLDGS INC")
// จะขึ้นบรรทัดใหม่แยกจากแถวตัวเลขไปเลย จึงต้องแยกจับ "บรรทัดสัญลักษณ์" (ตัวพิมพ์ใหญ่ล้วน)
// กับ "แถวตัวเลขปิดท้าย" ออกจากกัน แล้วจับคู่กันตามลำดับที่เจอ แทนที่จะสมมติว่าอยู่ติดกันเสมอ
function parsePortfolioSummary(fullText: string): Record<string, CostBasisEntry> {
  const startIdx = fullText.indexOf("PORTFOLIO SUMMARY");
  if (startIdx === -1) return {};
  const endIdx = fullText.indexOf("DEPOSIT & WITHDRAWAL RECORDS", startIdx);
  const block = fullText.slice(startIdx, endIdx === -1 ? undefined : endIdx);

  const lines = block
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const summary: Record<string, CostBasisEntry> = {};

  // สัญลักษณ์หุ้นมักเป็นตัวพิมพ์ใหญ่ล้วน ไม่มีเว้นวรรค เช่น "GLD", "GOOG", "BBAI", "JEPQ"
  const tickerLine = /^[A-Z][A-Z.]{0,9}$/;

  // แถวตัวเลขปิดท้าย: จำนวนหุ้น, multiplier, ราคาเฉลี่ย, cost basis, ราคาปิด, unrealized P/L, สกุลเงิน, ตลาด
  // อนุญาตให้มีข้อความ (ชื่อบริษัทท่อนสุดท้าย) นำหน้าตัวเลขได้ในบรรทัดเดียวกัน หรือไม่มีเลยก็ได้ (ถ้าขึ้นบรรทัดใหม่ไปหมดแล้ว)
  const summaryRowPattern =
    /(?:^|\s)([\d.]+)\s+\d+\s+([\d,]+\.\d{2})\s+[\d,]+\.\d{2}\s+[\d,]+\.\d{2}\s+-?[\d,]+\.\d{2}\s+[A-Z]{3}\s+\S+$/;

  let currentSymbol: string | null = null;

  for (const line of lines) {
    if (tickerLine.test(line)) {
      currentSymbol = line;
      continue;
    }
    const m = line.match(summaryRowPattern);
    if (m && currentSymbol) {
      summary[currentSymbol] = { quantity: toNumber(m[1]), avgCost: toNumber(m[2]) };
      currentSymbol = null; // จับคู่ครบแล้ว รอสัญลักษณ์ตัวถัดไป
    }
  }

  return summary;
}

interface RawTradeEvent {
  date: string;
  side: "BUY" | "SELL";
  qty: number;
  qtyStr: string;
  price: string;
  net: number;
  symbol: string;
  description: string;
  currency: string;
}

// ---------- Step 4: ดึงรายการแต่ละประเภทจากแถวที่จัดเรียงแล้ว ----------
export function parseStatementRows(
  rows: string[],
  costBasis: CostBasisMap = {}
): { transactions: ExtractedTransaction[]; updatedCostBasis: CostBasisMap } {
  const fullText = rows.join("\n");
  const baseRates = extractBaseRates(fullText);
  const portfolioSummary = parsePortfolioSummary(fullText);
  const results: ExtractedTransaction[] = [];

  // ทำสำเนาไว้แก้ไข ไม่แตะของเดิมที่ผู้เรียกส่งเข้ามาโดยตรง
  const workingCostBasis: CostBasisMap = {};
  for (const symbol of Object.keys(costBasis)) {
    workingCostBasis[symbol] = { ...costBasis[symbol] };
  }

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

  // --- เงินฝาก / เงินถอน (equity — ไม่ใช่กำไรขาดทุน) ---
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
        subLabel: isWithdrawal ? "ถอนเงิน (เงินทุน)" : "ฝากเงิน (เงินทุน)",
        currency,
        amount: isWithdrawal ? -Math.abs(amount) : Math.abs(amount),
        category: "equity",
        pnlAmount: 0, // เงินฝาก/ถอน ไม่ใช่กำไรขาดทุน เป็นแค่เงินทุนเข้า-ออกบัญชี
        rate: baseRates[currency] ?? "-",
        section: isWithdrawal ? "ถอนเงิน" : "ฝากเงิน",
        included: true,
      });
    }
  }

  // --- แลกเปลี่ยนสกุลเงิน (asset — ไม่ใช่รายรับ/รายจ่ายจริง จึงติ๊กไว้เป็น "ไม่รวม" โดยดีฟอลต์) ---
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
        category: "asset",
        pnlAmount: 0, // แค่ย้ายเงินสดจากสกุลหนึ่งไปอีกสกุล ไม่ใช่กำไรขาดทุน
        rate,
        section: "แลกเปลี่ยนสกุลเงิน",
        included: false,
      });
    }
  }

  // --- เงินปันผล (income) ---
  // หมายเหตุสำคัญ: คำอธิบายเงินปันผล (ชื่อกองทุน + "Cash Div on X shares - Rec ... Pay ...") มักยาว
  // จนขึ้นบรรทัดใหม่หลายบรรทัดใน PDF จริง ทำให้ "วันที่ + คำอธิบาย + ยอดเงิน" ไม่ได้อยู่บรรทัดเดียวกันเสมอไป
  // จึงใช้วิธี "สะสมทุกบรรทัดไว้ก่อน จนกว่าจะเจอแถวตัวเลขปิดท้าย (สกุลเงิน + 3 ยอดเงิน)" ซึ่งเป็นจุดจบของแต่ละรายการเสมอ
  // แล้วค่อยดึงวันที่ตัวแรกที่เจอในข้อความที่สะสมมาเป็น Posting Date (ถูกต้องเสมอ เพราะวันที่นี้ขึ้นก่อนวันที่อื่นๆ
  // ที่แทรกอยู่ในคำอธิบาย เช่น "Rec .../Pay ...") วิธีนี้ทนต่อการขึ้นบรรทัดใหม่ได้ไม่ว่าจะกี่บรรทัดก็ตาม
  const dividendBlock = sectionSlice("DIVIDENDS", ["INTEREST WHT", "INTEREST", "NOTES"]);
  if (dividendBlock) {
    const dividendEndRowPattern =
      /^([A-Z]{3})\s+([\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/;

    const dividendLines = dividendBlock
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    let buffer: string[] = [];
    let headerSeen = false;
    for (const line of dividendLines) {
      if (!headerSeen) {
        if (/Posting Date/i.test(line)) headerSeen = true;
        continue; // ข้ามหัวตาราง/เลขหน้า/เลขลำดับก่อนถึงหัวตารางจริง
      }
      const endMatch = line.match(dividendEndRowPattern);
      if (endMatch) {
        const [, currency, , , netAmt] = endMatch;
        const combinedText = buffer.join(" ");
        const dateMatch = combinedText.match(/(\d{2}\/\d{2}\/\d{4})/);

        if (dateMatch) {
          const date = dateMatch[1];
          const description = combinedText
            .replace(date, "")
            .replace(/\s+/g, " ")
            .trim();
          const net = toNumber(netAmt);

          results.push({
            id: nextId(),
            date,
            description,
            subLabel: "เงินปันผล",
            currency,
            amount: net,
            category: "income",
            pnlAmount: net,
            rate: baseRates[currency] ?? "-",
            section: "เงินปันผล",
            included: true,
          });
        }
        buffer = [];
      } else {
        buffer.push(line);
      }
    }
  }

  // --- ดอกเบี้ย (income) และ ภาษีหัก ณ ที่จ่ายดอกเบี้ย (expense) ---
  for (const [marker, label, category, endMarkers] of [
    ["INTEREST WHT", "ภาษีหัก ณ ที่จ่าย (ดอกเบี้ย)", "expense", ["NOTES"]],
    ["INTEREST", "ดอกเบี้ย", "income", ["INTEREST WHT", "NOTES"]],
  ] as const) {
    const block = sectionSlice(marker, endMarkers as unknown as string[]);
    if (!block) continue;
    const rowPattern = /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+([A-Z]{3})\s+(-?[\d,]+\.\d{2})$/gm;
    for (const m of block.matchAll(rowPattern)) {
      const [, date, desc, currency, amountStr] = m;
      const amount = toNumber(amountStr);
      results.push({
        id: nextId(),
        date,
        description: desc.trim(),
        subLabel: label,
        currency,
        amount,
        category: category as TransactionCategory,
        pnlAmount: amount,
        rate: baseRates[currency] ?? "-",
        section: label,
        included: true,
      });
    }
  }

  // --- รายการซื้อขายหุ้น ---
  // Pass 1: เก็บรายการซื้อขายดิบทั้งหมดไว้ก่อน (ตามลำดับที่เจอในเอกสาร ซึ่งปกติจะเรียงล่าสุด → เก่าสุด)
  const tradeBlock = sectionSlice("TRADE RECORDS", ["PORTFOLIO SUMMARY"]);
  const tradeEvents: RawTradeEvent[] = [];
  let feeTotal = 0;
  let vatTotal = 0;
  let lastTradeDate = "";
  let tradeCurrency = "USD";

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

      const [, name, date, side, qtyStr, priceStr, , netAmt, commStr, vatStr] = m;
      const symbolLine = i > 0 ? lines[i - 1].trim() : "";

      feeTotal += toNumber(commStr);
      vatTotal += toNumber(vatStr);
      lastTradeDate = date;
      tradeCurrency = currentCurrency;

      tradeEvents.push({
        date,
        side: side as "BUY" | "SELL",
        qty: toNumber(qtyStr),
        qtyStr,
        price: priceStr,
        net: toNumber(netAmt),
        symbol: symbolLine,
        description: `${symbolLine} ${name.trim()}`.trim(),
        currency: currentCurrency,
      });
    }
  }

  // Pass 2: เรียงตามลำดับเวลาจริง (เก่าสุด → ล่าสุด) แล้วไล่คำนวณต้นทุนเฉลี่ยทีละรายการ
  // (จำเป็นต้องเรียงแบบนี้ ต้นทุนเฉลี่ยถึงจะถูกต้อง เพราะการซื้อภายหลังต้องไม่กระทบกำไรจากการขายก่อนหน้า)
  const chronological = [...tradeEvents].sort(
    (a, b) => toSortableDate(a.date) - toSortableDate(b.date)
  );

  for (const ev of chronological) {
    let pnlAmount = 0;
    let pnlNote = "";

    if (ev.side === "BUY") {
      const existing = workingCostBasis[ev.symbol];
      const priceNum = toNumber(ev.price);
      const prevQty = existing?.quantity ?? 0;
      const prevAvgCost = existing?.avgCost ?? priceNum;
      const newQty = prevQty + ev.qty;
      const newAvgCost =
        newQty > 0 ? (prevQty * prevAvgCost + ev.qty * priceNum) / newQty : priceNum;
      workingCostBasis[ev.symbol] = { quantity: newQty, avgCost: newAvgCost };
    } else {
      // SELL: ใช้ต้นทุนเฉลี่ยที่มีอยู่ ณ ตอนนี้ (จากประวัติสะสม) ก่อน แล้วค่อย fallback ไปใช้ค่าจากตาราง Portfolio Summary
      // ของไฟล์นี้เอง (กรณีไม่เคยมีประวัติสะสมของสัญลักษณ์นี้มาก่อนเลย)
      const existing = workingCostBasis[ev.symbol];
      const seed = portfolioSummary[ev.symbol];
      const avgCostForSale = existing?.quantity ? existing.avgCost : seed?.avgCost;
      const priceNum = toNumber(ev.price);

      if (avgCostForSale !== undefined) {
        pnlAmount = (priceNum - avgCostForSale) * ev.qty;
      } else {
        pnlNote = " (ไม่พบต้นทุนเฉลี่ย จึงไม่นับกำไร/ขาดทุนส่วนนี้)";
      }

      const prevQty = existing?.quantity ?? seed?.quantity ?? 0;
      const prevAvgCost = existing?.avgCost ?? avgCostForSale ?? priceNum;
      workingCostBasis[ev.symbol] = {
        quantity: Math.max(prevQty - ev.qty, 0),
        avgCost: prevAvgCost, // ต้นทุนเฉลี่ยไม่เปลี่ยนตอนขาย เปลี่ยนแค่ตอนซื้อเพิ่ม
      };
    }

    results.push({
      id: nextId(),
      date: ev.date,
      description: ev.description,
      subLabel: `${ev.side === "BUY" ? "ซื้อ" : "ขาย"} ${ev.qtyStr} หุ้น @ ${ev.price} ${ev.currency}${pnlNote}`,
      currency: ev.currency,
      amount: ev.side === "BUY" ? -Math.abs(ev.net) : Math.abs(ev.net),
      // เงินต้น/เงินที่ใช้ซื้อ-ขาย ถือเป็นการแลกเปลี่ยนสินทรัพย์ (asset) ไม่ใช่กำไรขาดทุนทั้งก้อน
      category: "asset",
      pnlAmount, // มีค่าเฉพาะฝั่ง SELL ที่คำนวณกำไร/ขาดทุนจากต้นทุนสะสมได้เท่านั้น
      rate: baseRates[ev.currency] ?? "-",
      section: ev.side === "BUY" ? "ซื้อหุ้น" : "ขายหุ้น",
      included: true,
    });
  }

  // Pass 3: "เติมข้อมูล" (self-heal) — สัญลักษณ์ไหนที่มีอยู่ใน Portfolio Summary ของไฟล์นี้ แต่เรายังไม่เคย
  // มีประวัติสะสมเลย (เช่น ถือมาก่อนที่จะเริ่มใช้ระบบนี้ และไม่มีการซื้อขายในเดือนนี้) ให้ยึดค่าจากโบรกเกอร์เป็นฐานตั้งต้น
  for (const symbol of Object.keys(portfolioSummary)) {
    if (!workingCostBasis[symbol]) {
      workingCostBasis[symbol] = { ...portfolioSummary[symbol] };
    }
  }

  // รวมค่าธรรมเนียมนายหน้าและ VAT ของทั้งเดือนเป็นรายการค่าใช้จ่าย 2 บรรทัด (แทนที่จะแยกทีละรายการซื้อขาย เพื่อไม่ให้สมุดบัญชีรกเกินไป)
  if (feeTotal !== 0) {
    results.push({
      id: nextId(),
      date: lastTradeDate,
      description: "ค่าธรรมเนียมนายหน้า (รวมทั้งเดือน)",
      subLabel: "ค่าธรรมเนียมซื้อขาย",
      currency: tradeCurrency,
      amount: feeTotal,
      category: "expense",
      pnlAmount: feeTotal,
      rate: baseRates[tradeCurrency] ?? "-",
      section: "ค่าธรรมเนียม",
      included: true,
    });
  }
  if (vatTotal !== 0) {
    results.push({
      id: nextId(),
      date: lastTradeDate,
      description: "ภาษีมูลค่าเพิ่ม VAT (รวมทั้งเดือน)",
      subLabel: "VAT จากค่าธรรมเนียม",
      currency: tradeCurrency,
      amount: vatTotal,
      category: "expense",
      pnlAmount: vatTotal,
      rate: baseRates[tradeCurrency] ?? "-",
      section: "VAT",
      included: true,
    });
  }

  // เรียงตามวันที่ล่าสุดก่อน (สำหรับแสดงผลในสมุดบัญชี)
  results.sort((a, b) => (a.date < b.date ? 1 : -1));

  return { transactions: results, updatedCostBasis: workingCostBasis };
}

// ---------- Entry point ที่ component เรียกใช้ ----------
export async function parsePdfStatement(
  file: File,
  costBasis: CostBasisMap = {}
): Promise<{ transactions: ExtractedTransaction[]; updatedCostBasis: CostBasisMap }> {
  if (typeof window === "undefined") {
    throw new Error("parsePdfStatement ใช้งานได้เฉพาะฝั่งเบราว์เซอร์เท่านั้น");
  }
  const rows = await extractRows(file);
  return parseStatementRows(rows, costBasis);
}