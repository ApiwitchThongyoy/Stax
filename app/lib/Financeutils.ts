export type TransactionCategory = "income" | "expense" | "equity" | "asset";

export interface Transaction {
  id: string;
  date: string;
  description: string;
  subLabel?: string;
  income: string | null;
  expense: string | null;
  rate: string;
  category: TransactionCategory;
  // กำไร/ขาดทุนรับรู้ (realized) เป็นหน่วยบาท (THB) ตามค่าที่ Backend คำนวณไว้
  // แบบ Server-authoritative (realizedGainLossThb). null = คำนวณไม่ได้จริง ๆ
  // (เช่น SELL ที่ไม่มีต้นทุนอ้างอิงเชื่อถือได้) และไม่ควรแสดงเป็น ฿0.00 ปลอม
  pnlAmount: number | null;
  amount: number; // ยอดเงินดิบ (บวก = เข้า, ลบ = ออก) หน่วยสกุลเงินเดิม
  currency: string;
  // ---- Trade detail (server-authoritative, จาก Capital_Transactions) ----
  symbol?: string | null;
  side?: "BUY" | "SELL" | null;
  quantity?: string | null;
  unitPrice?: string | null;
  grossAmount?: string | null;
  fees?: string | null;
  proceeds?: string | null;
  costBasis?: string | null;
  realizedGainLoss?: string | null; // กำไร/ขาดทุน (สกุลเงินเดิมของธุรกรรม)
  fxRateStatement?: string | null; // อัตราจาก Statement จริง (ถ้ามี)
  fxRateEffective?: string | null; // อัตราที่ใช้จริงในการแปลงเป็น THB
  exchange?: string | null;
}

export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  THB: "฿",
  HKD: "HK$",
  CNH: "¥",
};

export function formatMoney(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  return `${symbol}${Math.abs(amount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ฟอร์แมตยอดเงินหน่วยบาทโดยเฉพาะ (พร้อมเครื่องหมาย +/- ตามเครื่องหมายของ amount) ใช้ในหน้าปฏิทิน
export function formatTHB(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}฿${Math.abs(amount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function toDisplayDate(ddmmyyyy: string): string {
  const [d, m, y] = ddmmyyyy.split("/");
  return `${y}-${m}-${d}`;
}

// แปลงข้อความอัตราแลกเปลี่ยน (เช่น "35.42", "-") กลับเป็นตัวเลข ถ้าอ่านไม่ได้ให้ถือว่าอัตรา 1 (เช่น THB)
export function parseRateString(rate: string): number {
  const num = parseFloat(rate);
  return Number.isNaN(num) ? 1 : num;
}

// ---------------------------------------------------------------------------
// Dashboard financial summary helpers (pure). ใช้เฉพาะค่าที่ Backend คำนวณให้
// เท่านั้น — ไม่มีการคำนวณต้นทุน/ภาษีซ้ำในฝั่ง React
// ---------------------------------------------------------------------------

/**
 * ผลรวมกำไร/ขาดทุนรับรู้ (realized) เป็นบาท จากธุรกรรมที่มีค่า authoritative
 * (pnlAmount !== null) — SELL ที่คำนวณได้เท่านั้น เงินฝาก/ถอน ซื้อหุ้น และ
 * SELL ที่คำนวณไม่ได้จะไม่ถูกนับรวม
 */
export function sumAuthoritativeGainThb(transactions: Transaction[]): number {
  return transactions.reduce((sum, t) => {
    if (t.pnlAmount === undefined || t.pnlAmount === null) return sum;
    return sum + t.pnlAmount;
  }, 0);
}

/** จำนวนธุรกรรมที่มีกำไร/ขาดทุนรับรู้ที่คำนวณได้จริง */
export function countComputableGainRows(transactions: Transaction[]): number {
  return transactions.filter(
    (t) => t.pnlAmount !== undefined && t.pnlAmount !== null
  ).length;
}

/** มีธุรกรรมที่ไม่สามารถคำนวณกำไร/ขาดทุนได้ (pnlAmount null) หรือไม่ */
export function hasNonComputableGain(transactions: Transaction[]): boolean {
  return transactions.some(
    (t) => t.pnlAmount === undefined || t.pnlAmount === null
  );
}

export type RateSource = "statement" | "external" | "base" | "none";

export interface ResolvedRateInfo {
  base: string; // สกุลเงินฐานของอัตรา เช่น USD
  rate: number | null;
  source: RateSource;
  date?: string;
}

/**
 * เลือกอัตราแลกเปลี่ยน "ที่ STAX ใช้จริง" ที่เกี่ยวข้องมากที่สุด:
 * 1. อัตราจาก Statement (fxRateStatement) ของธุรกรรมล่าสุด
 * 2. อัตราจาก Historical FX Provider (external fallback) เมื่อไม่มีอัตราจาก Statement
 * 3. THB = 1 (ฐานสกุลเงิน)
 * ไม่มีการสร้างอัตราปลอมขึ้นมาเอง และไม่อ้างถึงผู้ให้บริการที่เลิกใช้แล้ว
 */
export function pickRelevantRate(
  transactions: Transaction[],
  external?: { rate?: number | null; date?: string } | null
): ResolvedRateInfo {
  const statementRows = transactions
    .filter(
      (t) =>
        t.currency &&
        t.currency !== "THB" &&
        t.fxRateEffective != null &&
        t.fxRateEffective.trim() !== "" &&
        Number.isFinite(Number(t.fxRateEffective))
    )
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  if (statementRows.length > 0) {
    const row = statementRows[0];
    return {
      base: row.currency,
      rate: Number(row.fxRateEffective),
      source: "statement",
      date: row.date,
    };
  }

  if (
    external?.rate != null &&
    Number.isFinite(external.rate)
  ) {
    return {
      base: "USD",
      rate: external.rate as number,
      source: "external",
      date: external.date,
    };
  }

  if (transactions.length > 0) {
    return { base: "THB", rate: 1, source: "base" };
  }

  return { base: "THB", rate: null, source: "none" };
}