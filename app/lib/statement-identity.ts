export interface StatementIdentity {
  accountHolderName: string | null;
  accountNumber: string | null;
}

export const normalizeHolderName = (name: string) =>
  name.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");

// ---------------------------------------------------------------------------
// Evidence sources, in order of trust:
//   1. an explicit label printed in the document (`Account Holder Name: ...`,
//      `Account No. : ...`), and
//   2. the Webull account-header layout, where the holder name is a standalone
//      line that carries no label of its own.
//
// Nothing else is evidence. Never use filenames, folder names, user profiles or
// any text that merely happens to sit near the account header.
// ---------------------------------------------------------------------------

/** `Account No. :`, `Account No.:`, `Account No :` and `Account Number` are all accepted. */
const IDENTITY_LABELS = /\b(Account\s+Holder\s+Name|Account\s+(?:No\.?|Number))\s*:?\s*/giu;

const MAX_HOLDER_NAME_LENGTH = 150;
const HOLDER_NAME_SHAPE = /^[\p{L}\p{M}][\p{L}\p{M} .,'’\-]+$/u;
const HOLDER_NAME_BLOCKED_WORDS = /\b(account|statement|address|period|number|name|unknown|null)\b/iu;
const ACCOUNT_NUMBER_SHAPE = /^[A-Z0-9][A-Z0-9-]{3,39}$/iu;

/** Real Webull statement header anchors (all present in the actual PDF). */
const WEBULL_HEADER_LINE = /^\s*Monthly\s+Account\s+Statement\b[\s:.\-\u2013\u2014]*$/iu;
const WEBULL_STATEMENT_METADATA_LINE = /^\s*(?:Period|Date\s+of\s+Issuance)\s*[:\uff1a]/iu;
const ADDRESS_LABEL_LINE = /^\s*Address\b[^:\uff1a]{0,20}[:\uff1a]/iu;

/** How far after the header the account block may reach, and how many headers are inspected. */
const WEBULL_HEADER_SCAN_LINES = 12;
const WEBULL_HEADER_SCAN_COUNT = 10;

/** Never consume a printed label or field heading as a holder name. */
const RESERVED_HEADER_PHRASES = [
  "address", "account type", "account no", "account number", "account holder",
  "base currency rate", "base currency", "period", "date of issuance",
  "monthly account statement", "net account value", "cash report summary",
  "trade records", "opening", "closing", "total", "vat id", "webull",
];

function looksLikeHeaderLabel(value: string): boolean {
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  return RESERVED_HEADER_PHRASES.some(phrase => normalized === phrase || normalized.startsWith(phrase));
}

function isHolderNameEvidence(value: string): boolean {
  return value.length > 0 && value.length <= MAX_HOLDER_NAME_LENGTH
    && HOLDER_NAME_SHAPE.test(value)
    && !HOLDER_NAME_BLOCKED_WORDS.test(value)
    && !looksLikeHeaderLabel(value);
}

function isAccountNumberEvidence(value: string): boolean {
  return ACCOUNT_NUMBER_SHAPE.test(value) && /\d/u.test(value) && !looksLikeHeaderLabel(value);
}

/**
 * The real Webull PDF prints the account holder name as a bare line between the
 * statement metadata (`Period:` / `Date of Issuance:`) and the `Address :` label,
 * and it prints the address and `Account No. :` on the SAME line. The name
 * therefore has no label and cannot be found by a label scan.
 *
 * A line is only accepted as the holder name when the surrounding structure
 * strongly matches a Webull account header: the `Monthly Account Statement`
 * header line, a statement-metadata line, and the `Address` label line must all
 * be present and in that order, and the gap between the metadata and the
 * `Address` line must hold exactly ONE line. Address text and the
 * `Account No. :` field sit ON the `Address` line, so they are outside the gap
 * and can never be consumed. Every candidate is additionally shape-checked and
 * rejected when it is a printed label.
 *
 * Returns every candidate found, so conflicting names across repeated header
 * regions still resolve to `null` in `parseStatementIdentity`.
 */
function webullStandaloneHolderNames(lines: string[]): string[] {
  const candidates: string[] = [];
  let headers = 0;
  for (let start = 0; start < lines.length && headers < WEBULL_HEADER_SCAN_COUNT; start++) {
    if (!WEBULL_HEADER_LINE.test(lines[start])) continue;
    headers++;
    let metadataIndex = -1;
    for (let i = start + 1; i <= Math.min(start + WEBULL_HEADER_SCAN_LINES, lines.length - 1); i++) {
      const line = lines[i];
      if (WEBULL_STATEMENT_METADATA_LINE.test(line)) {
        metadataIndex = i;
        continue;
      }
      if (!ADDRESS_LABEL_LINE.test(line)) continue;
      if (metadataIndex < 0) break; // No metadata between header and Address: not a Webull account header.
      const gap = lines.slice(metadataIndex + 1, i).map(l => l.trim()).filter(Boolean);
      if (gap.length === 1 && isHolderNameEvidence(gap[0])) candidates.push(gap[0]);
      break;
    }
  }
  return candidates;
}

export function parseStatementIdentity(text: string): StatementIdentity {
  const lines = text.split(/\r?\n/);
  const matches = [...text.matchAll(IDENTITY_LABELS)];
  const labelledNames: string[] = [];
  const numbers = new Map<string, string>();
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const start = match.index! + match[0].length;
    const value = text.slice(start, matches[i + 1]?.index ?? text.length)
      .split(/\r?\n|\t/)[0].trim();
    if (/Holder/iu.test(match[1])) {
      if (isHolderNameEvidence(value)) labelledNames.push(value);
    } else if (isAccountNumberEvidence(value)) {
      numbers.set(value.toUpperCase(), value);
    }
  }
  // One evidence map for both sources, so a structural candidate that disagrees
  // with an explicit label stays a conflict (two entries -> null) instead of
  // silently overriding. Explicit labels are written last and therefore win
  // when both describe the same holder.
  const names = new Map<string, string>();
  for (const candidate of webullStandaloneHolderNames(lines)) names.set(normalizeHolderName(candidate), candidate);
  for (const labelled of labelledNames) names.set(normalizeHolderName(labelled), labelled);
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
