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
  pnlAmount: number; // ส่วนที่นับเป็นกำไร/ขาดทุนจริงตามหลักบัญชี (0 ถ้าไม่ใช่รายการกำไรขาดทุน) หน่วยสกุลเงินเดิม
  amount: number; // ยอดเงินดิบ (บวก = เข้า, ลบ = ออก) หน่วยสกุลเงินเดิม
  currency: string;
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