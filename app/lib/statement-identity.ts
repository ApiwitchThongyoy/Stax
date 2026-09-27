export interface StatementIdentity {
  accountHolderName: string | null;
  accountNumber: string | null;
}

export const normalizeHolderName = (name: string) =>
  name.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");

/** Only explicitly labelled document text is evidence. Never use filenames or profiles. */
export function parseStatementIdentity(text: string): StatementIdentity {
  const labels = /\b(Account\s+Holder\s+Name|Account\s+(?:No\.?|Number))\s*:?\s*/gi;
  const matches = [...text.matchAll(labels)];
  const names = new Map<string, string>();
  const numbers = new Map<string, string>();
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const start = match.index! + match[0].length;
    const value = text.slice(start, matches[i + 1]?.index ?? text.length)
      .split(/\r?\n|\t/)[0].trim();
    if (/Holder/i.test(match[1])) {
      if (value.length <= 150 && /^[\p{L}\p{M}][\p{L}\p{M} .,'’\-]+$/u.test(value)
          && !/\b(account|statement|address|period|number|name|unknown|null)\b/i.test(value)) {
        names.set(normalizeHolderName(value), value);
      }
    } else if (/^[A-Z0-9][A-Z0-9-]{3,39}$/i.test(value) && /\d/.test(value)) {
      numbers.set(value.toUpperCase(), value);
    }
  }
  return {
    accountHolderName: names.size === 1 ? [...names.values()][0] : null,
    accountNumber: numbers.size === 1 ? [...numbers.values()][0] : null,
  };
}

export class StatementIdentityError extends Error {
  readonly code = "STATEMENT_IDENTITY_CONFLICT";
}

/** Current ledger is user-scoped, so multiple brokerage accounts cannot be merged safely. */
export function validateStatementIdentity(incoming: StatementIdentity, existing: StatementIdentity[]): string[] {
  const incomplete = [incoming, ...existing].some(identity => !identity.accountHolderName || !identity.accountNumber);
  for (const previous of existing) {
    if (incoming.accountHolderName && previous.accountHolderName &&
        normalizeHolderName(incoming.accountHolderName) !== normalizeHolderName(previous.accountHolderName)) {
      throw new StatementIdentityError("ชื่อเจ้าของ Statement ไม่ตรงกับเอกสารเดิม ไม่สามารถนำเข้ารวมกันได้");
    }
    if (incoming.accountNumber && previous.accountNumber &&
        incoming.accountNumber.toUpperCase() !== previous.accountNumber.toUpperCase()) {
      throw new StatementIdentityError("Account No. ต่างจากเอกสารเดิม ระบบยังไม่รองรับหลายบัญชีในพอร์ตเดียวกัน (ไม่ใช่ไฟล์ซ้ำ)");
    }
  }
  return incomplete ? ["ไม่สามารถยืนยันเจ้าของบัญชีของเอกสารทั้งหมดได้ เนื่องจากบางไฟล์ไม่มี Account Holder Name หรือ Account No. ที่อ่านได้ กรุณาตรวจสอบว่าเป็นบัญชีเดียวกัน ระบบจะแสดงอีเมลแทนชื่อเจ้าของบัญชี"] : [];
}

/** Derive from remaining documents only; never cache identity on the user/profile. */
export function supportedStatementIdentity(documents: Array<Partial<StatementIdentity>>): StatementIdentity | null {
  if (!documents.length) return null;
  const identities = documents.map(d => ({ accountHolderName: d.accountHolderName ?? null, accountNumber: d.accountNumber ?? null }));
  const first = identities[0];
  if (identities.some(d => !d.accountHolderName || !d.accountNumber)) return null;
  try { validateStatementIdentity(first, identities); return first; } catch { return null; }
}
