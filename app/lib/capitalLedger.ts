export type CapitalEntryType = "in" | "out";

export interface CapitalLedgerEntry {
  id: string;
  date: string; // yyyy-mm-dd
  type: CapitalEntryType; // "in" = เงินโอนเข้าประเทศ, "out" = เงินโอนออกประเทศ
  amount: number; // จำนวนเงิน (ค่าบวกเสมอ ทิศทางดูจาก type)
  currency: string;
  rate: string; // อัตราแลกเปลี่ยน ณ วันที่ทำรายการ ("-" ถ้าเป็น THB หรือไม่ทราบ)
  remarks: string;
}

const CAPITAL_LEDGER_STORAGE_KEY = "stax_capital_ledger";

export function loadCapitalLedger(): CapitalLedgerEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CAPITAL_LEDGER_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CapitalLedgerEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveCapitalLedger(entries: CapitalLedgerEntry[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CAPITAL_LEDGER_STORAGE_KEY, JSON.stringify(entries));
}

let counter = 0;
export function nextCapitalEntryId(): string {
  counter += 1;
  return `capital-${Date.now()}-${counter}`;
}