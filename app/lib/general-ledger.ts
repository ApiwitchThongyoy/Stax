// Double-entry general ledger core (บัญชีแยกประเภท).
//
// Pure + DB-free: all money math is Decimal, all invariant checks are
// explicit, and nothing here talks to the database or the network so it can be
// unit-tested in isolation.
//
// Invariants enforced:
//   1. Every journal line is exactly ONE leg: a positive debit OR a positive
//      credit, never both, never neither.
//   2. Every journal entry balances per currency: sum(debits) == sum(credits)
//      for each currency used in the entry (the rule agreed for the foreign
//      investment pivot).
//   3. amountThb is always derived from fxRateEffective so the THB reporting
//      base never diverges from the effective rate actually used.
import { Decimal } from "decimal.js";

Decimal.set({ precision: 40 });

export type AccountType =
  | "ASSET"
  | "LIABILITY"
  | "EQUITY"
  | "INCOME"
  | "EXPENSE";

export type Side = "DEBIT" | "CREDIT";

export type EntrySourceType = "MANUAL" | "STATEMENT";

/** Normal (increase) side of an account class in double-entry bookkeeping. */
export function normalSideOf(type: AccountType): Side {
  return type === "ASSET" || type === "EXPENSE" ? "DEBIT" : "CREDIT";
}

export interface AccountDef {
  code: string;
  name: string;
  type: AccountType;
  /** Base currency of the account. Lines posted to it must match. */
  currency: string;
}

/**
 * Default chart of accounts created for every user on registration — tuned for
 * a foreign (US broker) investment portfolio with THB reporting.
 */
export const DEFAULT_CHART_OF_ACCOUNTS: AccountDef[] = [
  { code: "1010", name: "เงินสด - บัญชีไทย", type: "ASSET", currency: "THB" },
  { code: "1020", name: "เงินสด - บัญชีโบรกเกอร์ต่างประเทศ", type: "ASSET", currency: "USD" },
  { code: "1110", name: "เงินลงทุน - หุ้นต่างประเทศ", type: "ASSET", currency: "USD" },
  { code: "1120", name: "เงินลงทุน - กองทุน ETF", type: "ASSET", currency: "USD" },
  { code: "2010", name: "หนี้สิน - วงเงิน/ยืม (Margin)", type: "LIABILITY", currency: "USD" },
  { code: "3010", name: "ส่วนทุน - เงินลงทุนเริ่มต้น", type: "EQUITY", currency: "USD" },
  { code: "3200", name: "กำไรสะสม", type: "EQUITY", currency: "THB" },
  { code: "4010", name: "รายได้ - เงินปันผล", type: "INCOME", currency: "USD" },
  { code: "4020", name: "รายได้ - กำไรจากการขายหลักทรัพย์", type: "INCOME", currency: "USD" },
  { code: "4030", name: "รายได้ - ดอกเบี้ย", type: "INCOME", currency: "USD" },
  { code: "5010", name: "ค่าใช้จ่าย - ค่านายหน้า/ค่าธรรมเนียม", type: "EXPENSE", currency: "USD" },
  { code: "5020", name: "รายได้/ค่าใช้จ่าย - จากอัตราแลกเปลี่ยน", type: "EXPENSE", currency: "THB" },
  { code: "5110", name: "ค่าใช้จ่าย - ภาษีหัก ณ ที่จ่าย", type: "EXPENSE", currency: "USD" },
  { code: "5120", name: "ค่าใช้จ่าย - ขาดทุนจากการขายหลักทรัพย์", type: "EXPENSE", currency: "USD" },
];

// ---------------------------------------------------------------------------
// Big-decimal helpers
// ---------------------------------------------------------------------------

function dec(value: string | number): Decimal | null {
  try {
    const d = new Decimal(String(value).trim());
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function fmt(d: Decimal): string {
  return d.toFixed(2);
}

// ISO 4217 currency codes are exactly 3 uppercase letters (THB, USD, EUR...).
// 2-letter codes (e.g. "US") are not currencies and are rejected. This is
// deliberately stricter than the statement parser's legacy {2,3} guard — real
// statements use 3-letter codes, and any looser match would silently post a
// malformed currency into the ledger.
const CURRENCY_REGEX = /^[A-Z]{3}$/;

export function isValidCurrency(value: string): boolean {
  return CURRENCY_REGEX.test(value.trim());
}

/** yyyy-mm-dd validity (strict, no time component). */
export function isValidIsoDate(value: string): boolean {
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------

export interface JournalLineInput {
  accountId: string;
  currency: string;
  /** Exactly one of debit/credit is set. Positive magnitudes. */
  debit?: string | number | null;
  credit?: string | number | null;
  /** THB reporting base; derived from amount * fxRateEffective when omitted. */
  amountThb?: string | number | null;
  fxRateEffective?: string | number | null;
  fxRateStatement?: string | number | null;
  fxRateProvider?: string | number | null;
  memo?: string | null;
}

/**
 * How an entry relates to the double-entry postings.
 *   POSTED — balanced lines exist.
 *   SKIPPED — recorded in the journal (full trade detail) but intentionally NOT
 *             double-entry posted (currency-exchange-only rows, duplicate
 *             capital-gain rows, rows whose accounts can't resolve). Zero lines.
 * Journal-as-SSOT: every imported row is either POSTED or SKIPPED so the journal
 * is a COMPLETE record of the PDF.
 */
export type PostingState = "POSTED" | "SKIPPED";

/**
 * Trade-detail fields copied verbatim from the source Statement row onto a
 * journal entry (migration 0020). Nullable on purpose — manual entries and
 * non-trade STATEMENT rows keep them null, nothing is ever fabricated.
 */
export interface JournalTradeDetail {
  category: string | null;
  section: string | null;
  symbol: string | null;
  side: string | null;
  exchange: string | null;
  quantity: string | null;
  unitPrice: string | null;
  grossAmount: string | null;
  fees: string | null;
  netAmount: string | null;
  proceeds: string | null;
  costBasis: string | null;
  realizedGainLoss: string | null;
  realizedGainLossThb: string | null;
  averageCost: string | null;
  currency: string | null;
  amount: string | null;
  amountThb: string | null;
  fxRateEffective: string | null;
  fxRateStatement: string | null;
  isFxConversion: boolean;
  exchangeFromCurrency: string | null;
  exchangeFromAmount: string | null;
  exchangeRate: string | null;
  // R4: monthly-fee-aggregate provenance, tri-state (true = parser monthly
  // aggregate -> SKIPPED, false = confirmed standalone fee, null = legacy /
  // unknown pre-0027 provenance). null is NEVER fabricated into false.
  isMonthlyFeeAggregate: boolean | null;
}

/** All-null trade detail (the default for manual / non-trade entries). */
export function emptyTradeDetail(): JournalTradeDetail {
  return {
    category: null,
    section: null,
    symbol: null,
    side: null,
    exchange: null,
    quantity: null,
    unitPrice: null,
    grossAmount: null,
    fees: null,
    netAmount: null,
    proceeds: null,
    costBasis: null,
    realizedGainLoss: null,
    realizedGainLossThb: null,
    averageCost: null,
    currency: null,
    amount: null,
    amountThb: null,
    fxRateEffective: null,
    fxRateStatement: null,
    isFxConversion: false,
    exchangeFromCurrency: null,
    exchangeFromAmount: null,
    exchangeRate: null,
    isMonthlyFeeAggregate: false,
  };
}

export interface JournalEntryInput {
  entryDate: string;
  description: string;
  sourceType?: EntrySourceType;
  sourceDocumentId?: string | null;
  sourceTransactionId?: string | null;
  lines: JournalLineInput[];
  postingState?: PostingState;
  skipReason?: string | null;
  detail?: Partial<JournalTradeDetail>;
}

export interface ValidatedJournalLine {
  accountId: string;
  currency: string;
  side: Side;
  /** Positive magnitude in the line's currency. */
  amount: string;
  amountThb: string;
  fxRateEffective: string;
  fxRateStatement: string | null;
  fxRateProvider: string | null;
  memo: string | null;
}

export interface ValidatedJournalEntry {
  entryDate: string;
  description: string;
  sourceType: EntrySourceType;
  sourceDocumentId: string | null;
  sourceTransactionId: string | null;
  lines: ValidatedJournalLine[];
  postingState: PostingState;
  skipReason: string | null;
  detail: JournalTradeDetail;
}

export type JournalEntryValidation =
  | { ok: true; entry: ValidatedJournalEntry }
  | { ok: false; errors: string[] };

/**
 * Validate an entry and normalize its lines. Pure. Returns structured errors
 * instead of throwing so callers (API + posting engine) can report them in a
 * transport-safe way.
 */
export function validateJournalEntry(
  input: JournalEntryInput
): JournalEntryValidation {
  const errors: string[] = [];

  if (!input.description || input.description.trim() === "") {
    errors.push("description is required");
  }
  if (!isValidIsoDate(input.entryDate ?? "")) {
    errors.push("entryDate must be a valid ISO date (yyyy-mm-dd)");
  }
  // SKIPPED entries deliberately carry no lines (they are the journal's record
  // of a row that was NOT double-entry posted). All other entries balance.
  const isSkipped = input.postingState === "SKIPPED";
  if (!isSkipped && (!Array.isArray(input.lines) || input.lines.length < 2)) {
    errors.push("an entry must contain at least 2 lines");
  }

  if (errors.length > 0) return { ok: false, errors };

  const lines: ValidatedJournalLine[] = [];
  const byCurrency: Record<string, { debit: Decimal; credit: Decimal }> = {};

  input.lines.forEach((line, i) => {
    const idx = `line[${i}]`;
    const currency = (line.currency ?? "").trim().toUpperCase();
    if (!isValidCurrency(currency)) {
      errors.push(`${idx}: invalid currency`);
      return;
    }

    const hasDebit = line.debit !== undefined && line.debit !== null && line.debit !== "";
    const hasCredit = line.credit !== undefined && line.credit !== null && line.credit !== "";
    if (hasDebit === hasCredit) {
      errors.push(`${idx}: exactly one of debit/credit must be set`);
      return;
    }

    const raw = hasDebit ? line.debit : line.credit;
    const amount = dec(raw as string | number);
    if (!amount || amount.lessThanOrEqualTo(0)) {
      errors.push(`${idx}: amount must be a positive finite number`);
      return;
    }

    // THB reporting base: THB lines are rate 1. Non-THB lines must carry an
    // explicit positive effective rate — silently defaulting to 1 would invent
    // a 1:1 rate and corrupt THB reporting. (Statement first, provider
    // fallback, never invented — mirrors the statement pipeline semantics.)
    // The rate is stored at full precision; only money amounts are rounded.
    let eff: Decimal;
    if (currency === "THB") {
      eff = new Decimal(1);
    } else {
      const rawEff = dec(line.fxRateEffective ?? "");
      if (!rawEff || rawEff.lessThanOrEqualTo(0)) {
        errors.push(
          `${idx}: fxRateEffective is required and must be a positive number for non-THB lines`
        );
        return;
      }
      eff = rawEff;
    }
    const amountThb = dec(line.amountThb ?? "") ?? amount.mul(eff);

    const side: Side = hasDebit ? "DEBIT" : "CREDIT";
    lines.push({
      accountId: line.accountId,
      currency,
      side,
      amount: fmt(amount),
      amountThb: fmt(amountThb),
      fxRateEffective: eff.toString(),
      fxRateStatement:
        line.fxRateStatement !== undefined && line.fxRateStatement !== null
          ? String(line.fxRateStatement)
          : null,
      fxRateProvider:
        line.fxRateProvider !== undefined && line.fxRateProvider !== null
          ? String(line.fxRateProvider)
          : null,
      memo: line.memo ?? null,
    });

    const bucket = byCurrency[currency] ?? { debit: new Decimal(0), credit: new Decimal(0) };
    if (side === "DEBIT") bucket.debit = bucket.debit.plus(amount);
    else bucket.credit = bucket.credit.plus(amount);
    byCurrency[currency] = bucket;
  });

  if (errors.length > 0) return { ok: false, errors };

  if (!isSkipped) {
    for (const [currency, bucket] of Object.entries(byCurrency)) {
      if (!bucket.debit.equals(bucket.credit)) {
        errors.push(
          `${currency} does not balance: debit ${fmt(bucket.debit)} != credit ${fmt(bucket.credit)}`
        );
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const d = input.detail ?? {};
  const detail: JournalTradeDetail = {
    category: d.category != null ? String(d.category) : null,
    section: d.section != null ? String(d.section) : null,
    symbol: d.symbol != null ? String(d.symbol) : null,
    side: d.side != null ? String(d.side) : null,
    exchange: d.exchange != null ? String(d.exchange) : null,
    quantity: d.quantity != null ? String(d.quantity) : null,
    unitPrice: d.unitPrice != null ? String(d.unitPrice) : null,
    grossAmount: d.grossAmount != null ? String(d.grossAmount) : null,
    fees: d.fees != null ? String(d.fees) : null,
    netAmount: d.netAmount != null ? String(d.netAmount) : null,
    proceeds: d.proceeds != null ? String(d.proceeds) : null,
    costBasis: d.costBasis != null ? String(d.costBasis) : null,
    realizedGainLoss: d.realizedGainLoss != null ? String(d.realizedGainLoss) : null,
    realizedGainLossThb: d.realizedGainLossThb != null ? String(d.realizedGainLossThb) : null,
    averageCost: d.averageCost != null ? String(d.averageCost) : null,
    currency: d.currency != null ? String(d.currency) : null,
    amount: d.amount != null ? String(d.amount) : null,
    amountThb: d.amountThb != null ? String(d.amountThb) : null,
    fxRateEffective: d.fxRateEffective != null ? String(d.fxRateEffective) : null,
    fxRateStatement: d.fxRateStatement != null ? String(d.fxRateStatement) : null,
    isFxConversion: Boolean(d.isFxConversion),
    exchangeFromCurrency: d.exchangeFromCurrency != null ? String(d.exchangeFromCurrency) : null,
    exchangeFromAmount: d.exchangeFromAmount != null ? String(d.exchangeFromAmount) : null,
    exchangeRate: d.exchangeRate != null ? String(d.exchangeRate) : null,
    isMonthlyFeeAggregate: d.isMonthlyFeeAggregate == null ? null : Boolean(d.isMonthlyFeeAggregate),
  };

  return {
    ok: true,
    entry: {
      entryDate: input.entryDate.trim(),
      description: input.description.trim(),
      sourceType: input.sourceType ?? "MANUAL",
      sourceDocumentId: input.sourceDocumentId ?? null,
      sourceTransactionId: input.sourceTransactionId ?? null,
      lines,
      postingState: isSkipped ? "SKIPPED" : "POSTED",
      skipReason: input.skipReason ?? null,
      detail,
    },
  };
}

/** Build a reversing entry (all legs swapped). Same date, escaped description. */
export function rejectionLines(entry: ValidatedJournalEntry): ValidatedJournalLine[] {
  return entry.lines.map((l) => ({
    ...l,
    side: l.side === "DEBIT" ? "CREDIT" : "DEBIT",
  }));
}

export interface ReversalCandidate {
  entryDate: string;
  description: string;
  sourceType: EntrySourceType;
  sourceTransactionId: string | null;
  lines: ValidatedJournalLine[];
}

/**
 * Build a reversal candidate that mirrors the original entry inverting every
 * leg. Callers verify with validateJournalEntry and persist it as a new
 * POSTED entry (a reversal is a real event, not a delete).
 */
export function buildReversal(entry: ValidatedJournalEntry): ReversalCandidate {
  return {
    entryDate: entry.entryDate,
    description: `กลับรายการ: ${entry.description}`,
    sourceType: "MANUAL",
    sourceTransactionId: entry.sourceTransactionId,
    lines: rejectionLines(entry),
  };
}

// ---------------------------------------------------------------------------
// Reporting (period-filtered lines already passed in by the caller)
// ---------------------------------------------------------------------------

export interface AccountInfo {
  code: string;
  name: string;
  type: AccountType;
  currency: string;
}

export type AccountMap = Record<string, AccountInfo>;

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  currency: string;
  debit: string;
  credit: string;
  /** Signed debit-credit (positive = debit-headed). */
  balance: string;
  /** THB-base parallels (from each line's stored amountThb; never re-converted). */
  debitThb: string;
  creditThb: string;
  balanceThb: string;
}

export interface TrialBalanceCurrencyTotal {
  currency: string;
  debit: string;
  credit: string;
  debitThb: string;
  creditThb: string;
}

export interface TrialBalanceResult {
  rows: TrialBalanceRow[];
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
  /** THB-base totals: the only cross-currency-meaningful sums. */
  totalDebitThb: string;
  totalCreditThb: string;
  balancedThb: boolean;
  /** Per-currency subtotals (native + THB-base). */
  totalsByCurrency: TrialBalanceCurrencyTotal[];
}

/**
 * Group lines into a trial balance. The caller passes lines already scoped to
 * period/account; this only groups, sums (Decimal) and checks the totals.
 *
 * `amountThb` is optional per line (older callers/tests omit it): lines without
 * it contribute only to the native-currency sums, never to the THB-base sums.
 */
export function trialBalance(
  lines: (Pick<ValidatedJournalLine, "accountId" | "currency" | "side" | "amount"> &
    Partial<Pick<ValidatedJournalLine, "amountThb">>)[],
  accounts: AccountMap
): TrialBalanceResult {
  const map = new Map<
    string,
    { accountId: string; debit: Decimal; credit: Decimal; debitThb: Decimal; creditThb: Decimal; currency: string }
  >();
  for (const l of lines) {
    const cur = map.get(l.accountId) ?? {
      accountId: l.accountId,
      debit: new Decimal(0),
      credit: new Decimal(0),
      debitThb: new Decimal(0),
      creditThb: new Decimal(0),
      currency: l.currency,
    };
    const thb = dec(l.amountThb ?? "") ?? new Decimal(0);
    if (l.side === "DEBIT") {
      cur.debit = cur.debit.plus(dec(l.amount) ?? 0);
      cur.debitThb = cur.debitThb.plus(thb);
    } else {
      cur.credit = cur.credit.plus(dec(l.amount) ?? 0);
      cur.creditThb = cur.creditThb.plus(thb);
    }
    map.set(l.accountId, cur);
  }

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  let totalDebitThb = new Decimal(0);
  let totalCreditThb = new Decimal(0);
  const byCurrency = new Map<string, { debit: Decimal; credit: Decimal; debitThb: Decimal; creditThb: Decimal }>();
  const rows: TrialBalanceRow[] = [];
  for (const cur of map.values()) {
    const acc = accounts[cur.accountId];
    totalDebit = totalDebit.plus(cur.debit);
    totalCredit = totalCredit.plus(cur.credit);
    totalDebitThb = totalDebitThb.plus(cur.debitThb);
    totalCreditThb = totalCreditThb.plus(cur.creditThb);
    const bucket = byCurrency.get(cur.currency) ?? {
      debit: new Decimal(0),
      credit: new Decimal(0),
      debitThb: new Decimal(0),
      creditThb: new Decimal(0),
    };
    bucket.debit = bucket.debit.plus(cur.debit);
    bucket.credit = bucket.credit.plus(cur.credit);
    bucket.debitThb = bucket.debitThb.plus(cur.debitThb);
    bucket.creditThb = bucket.creditThb.plus(cur.creditThb);
    byCurrency.set(cur.currency, bucket);
    rows.push({
      accountId: cur.accountId,
      code: acc?.code ?? cur.accountId,
      name: acc?.name ?? "(ไม่รู้จักบัญชี)",
      type: acc?.type ?? "ASSET",
      currency: cur.currency,
      debit: fmt(cur.debit),
      credit: fmt(cur.credit),
      balance: fmt(cur.debit.minus(cur.credit)),
      debitThb: fmt(cur.debitThb),
      creditThb: fmt(cur.creditThb),
      balanceThb: fmt(cur.debitThb.minus(cur.creditThb)),
    });
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));

  const balanced = totalDebit.equals(totalCredit);
  const totalsByCurrency = Array.from(byCurrency.entries())
    .map(([currency, b]) => ({
      currency,
      debit: fmt(b.debit),
      credit: fmt(b.credit),
      debitThb: fmt(b.debitThb),
      creditThb: fmt(b.creditThb),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  return {
    rows,
    totalDebit: fmt(totalDebit),
    totalCredit: fmt(totalCredit),
    balanced,
    totalDebitThb: fmt(totalDebitThb),
    totalCreditThb: fmt(totalCreditThb),
    balancedThb: totalDebitThb.equals(totalCreditThb),
    totalsByCurrency,
  };
}

/** Net contribution of an account to its own normal side on the given lines. */
function accountNet(
  lines: { accountId: string; side: Side; amount: string }[],
  type: AccountType,
  accountId: string
): Decimal {
  let debit = new Decimal(0);
  let credit = new Decimal(0);
  for (const l of lines) {
    if (l.accountId !== accountId) continue;
    if (l.side === "DEBIT") debit = debit.plus(dec(l.amount) ?? 0);
    else credit = credit.plus(dec(l.amount) ?? 0);
  }
  return normalSideOf(type) === "DEBIT" ? debit.minus(credit) : credit.minus(debit);
}

/** THB-base parallel of accountNet (reads each line's stored amountThb). */
function accountNetThb(
  lines: { accountId: string; side: Side; amountThb?: string }[],
  type: AccountType,
  accountId: string
): Decimal {
  let debit = new Decimal(0);
  let credit = new Decimal(0);
  for (const l of lines) {
    if (l.accountId !== accountId) continue;
    const thb = dec(l.amountThb ?? "") ?? new Decimal(0);
    if (l.side === "DEBIT") debit = debit.plus(thb);
    else credit = credit.plus(thb);
  }
  return normalSideOf(type) === "DEBIT" ? debit.minus(credit) : credit.minus(debit);
}

export interface IncomeStatementLine {
  accountId: string;
  code: string;
  name: string;
  type: "INCOME" | "EXPENSE";
  currency: string;
  /** Positive magnitude on the account's normal side. */
  amount: string;
  /** Same magnitude in THB-base (from stored amountThb). */
  amountThb: string;
}

export interface IncomeStatementCurrencyTotal {
  currency: string;
  income: string;
  expense: string;
  incomeThb: string;
  expenseThb: string;
}

export interface IncomeStatementResult {
  lines: IncomeStatementLine[];
  totalIncome: string;
  totalExpense: string;
  netIncome: string;
  /** THB-base totals: the only cross-currency-meaningful sums. */
  totalIncomeThb: string;
  totalExpenseThb: string;
  netIncomeThb: string;
  totalsByCurrency: IncomeStatementCurrencyTotal[];
}

/** Income statement from posted lines (period pre-filtered by the caller). */
export function incomeStatement(
  lines: { accountId: string; currency: string; side: Side; amount: string; amountThb?: string }[],
  accounts: AccountMap
): IncomeStatementResult {
  const entries = new Map<string, { accountId: string; type: "INCOME" | "EXPENSE"; currency: string }>();
  const seen = new Set<string>();

  for (const l of lines) {
    if (seen.has(l.accountId)) continue;
    seen.add(l.accountId);
    const acc = accounts[l.accountId];
    if (!acc) continue;
    if (acc.type === "INCOME" || acc.type === "EXPENSE") {
      entries.set(l.accountId, {
        accountId: l.accountId,
        type: acc.type,
        currency: l.currency,
      });
    }
  }

  const report: IncomeStatementLine[] = [];
  let totalIncome = new Decimal(0);
  let totalExpense = new Decimal(0);
  let totalIncomeThb = new Decimal(0);
  let totalExpenseThb = new Decimal(0);
  const byCurrency = new Map<string, { income: Decimal; expense: Decimal; incomeThb: Decimal; expenseThb: Decimal }>();
  for (const entry of entries.values()) {
    const net = accountNet(lines, entry.type, entry.accountId);
    const netThb = accountNetThb(lines, entry.type, entry.accountId);
    const bucket = byCurrency.get(entry.currency) ?? {
      income: new Decimal(0),
      expense: new Decimal(0),
      incomeThb: new Decimal(0),
      expenseThb: new Decimal(0),
    };
    if (entry.type === "INCOME") {
      totalIncome = totalIncome.plus(net);
      totalIncomeThb = totalIncomeThb.plus(netThb);
      bucket.income = bucket.income.plus(net);
      bucket.incomeThb = bucket.incomeThb.plus(netThb);
    } else {
      totalExpense = totalExpense.plus(net);
      totalExpenseThb = totalExpenseThb.plus(netThb);
      bucket.expense = bucket.expense.plus(net);
      bucket.expenseThb = bucket.expenseThb.plus(netThb);
    }
    byCurrency.set(entry.currency, bucket);
    const acc = accounts[entry.accountId];
    report.push({
      accountId: entry.accountId,
      code: acc?.code ?? entry.accountId,
      name: acc?.name ?? "(ไม่รู้จักบัญชี)",
      type: entry.type,
      currency: entry.currency,
      amount: fmt(net),
      amountThb: fmt(netThb),
    });
  }
  report.sort((a, b) => a.code.localeCompare(b.code));

  const totalsByCurrency = Array.from(byCurrency.entries())
    .map(([currency, b]) => ({
      currency,
      income: fmt(b.income),
      expense: fmt(b.expense),
      incomeThb: fmt(b.incomeThb),
      expenseThb: fmt(b.expenseThb),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    lines: report,
    totalIncome: fmt(totalIncome),
    totalExpense: fmt(totalExpense),
    netIncome: fmt(totalIncome.minus(totalExpense)),
    totalIncomeThb: fmt(totalIncomeThb),
    totalExpenseThb: fmt(totalExpenseThb),
    netIncomeThb: fmt(totalIncomeThb.minus(totalExpenseThb)),
    totalsByCurrency,
  };
}

export interface BalanceSheetRow {
  accountId: string;
  code: string;
  name: string;
  currency: string;
  /** Positive magnitude on the account's normal side. */
  balance: string;
  /** Same magnitude in THB-base (from stored amountThb + THB openings). */
  balanceThb: string;
}

export interface BalanceSheetCurrencyTotal {
  currency: string;
  assets: string;
  liabilities: string;
  equity: string;
  assetsThb: string;
  liabilitiesThb: string;
  equityThb: string;
}

export interface BalanceSheetResult {
  assets: BalanceSheetRow[];
  liabilities: BalanceSheetRow[];
  equity: BalanceSheetRow[];
  /** Current-period net income folded into equity. */
  netIncome: string;
  totalAssets: string;
  totalEquityAndLiabilities: string;
  balanced: boolean;
  /** THB-base parallels: the only cross-currency-meaningful sums. */
  netIncomeThb: string;
  totalAssetsThb: string;
  totalEquityAndLiabilitiesThb: string;
  balancedThb: boolean;
  totalsByCurrency: BalanceSheetCurrencyTotal[];
}

/**
 * Balance sheet from posted lines + opening balances.
 *
 * `openingBalances` maps accountId -> positive magnitude on the account's
 * NORMAL side (ASSET/EXPENSE debit-headed; LIABILITY/EQUITY credit-headed).
 * `openingBalancesThb` is the THB-base parallel (only THB-denominated openings
 * belong here; foreign openings have no rate at this layer, so they contribute
 * 0 to the THB-base sums rather than a guessed conversion).
 * `accounts` must contain every account referenced in lines or openingBalances.
 */
export function balanceSheet(
  lines: { accountId: string; side: Side; amount: string; amountThb?: string }[],
  accounts: AccountMap,
  openingBalances: Record<string, string> = {},
  openingBalancesThb: Record<string, string> = {}
): BalanceSheetResult {
  const accountIds = new Set<string>([
    ...lines.map((l) => l.accountId),
    ...Object.keys(openingBalances),
    ...Object.keys(openingBalancesThb),
  ]);

  const assets: BalanceSheetRow[] = [];
  const liabilities: BalanceSheetRow[] = [];
  const equity: BalanceSheetRow[] = [];

  let totalAssets = new Decimal(0);
  let totalLiabilities = new Decimal(0);
  let totalEquity = new Decimal(0);
  let totalAssetsThb = new Decimal(0);
  let totalLiabilitiesThb = new Decimal(0);
  let totalEquityThb = new Decimal(0);
  const byCurrency = new Map<string, { assets: Decimal; liabilities: Decimal; equity: Decimal; assetsThb: Decimal; liabilitiesThb: Decimal; equityThb: Decimal }>();

  const track = (
    currency: string,
    type: "ASSET" | "LIABILITY" | "EQUITY",
    signed: Decimal,
    signedThb: Decimal
  ) => {
    const bucket = byCurrency.get(currency) ?? {
      assets: new Decimal(0),
      liabilities: new Decimal(0),
      equity: new Decimal(0),
      assetsThb: new Decimal(0),
      liabilitiesThb: new Decimal(0),
      equityThb: new Decimal(0),
    };
    // Signed amounts are debit-headed; L/E are stored credit-headed magnitudes.
    const magnitude = type === "ASSET" ? signed : signed.negated();
    const magnitudeThb = type === "ASSET" ? signedThb : signedThb.negated();
    if (type === "ASSET") {
      bucket.assets = bucket.assets.plus(magnitude);
      bucket.assetsThb = bucket.assetsThb.plus(magnitudeThb);
    } else if (type === "LIABILITY") {
      bucket.liabilities = bucket.liabilities.plus(magnitude);
      bucket.liabilitiesThb = bucket.liabilitiesThb.plus(magnitudeThb);
    } else {
      bucket.equity = bucket.equity.plus(magnitude);
      bucket.equityThb = bucket.equityThb.plus(magnitudeThb);
    }
    byCurrency.set(currency, bucket);
  };

  for (const accountId of accountIds) {
    const acc = accounts[accountId];
    if (!acc) continue;

    // Opening balance (positive on normal side) -> signed debit-credit form.
    const opening = dec(openingBalances[accountId]) ?? new Decimal(0);
    const openingSigned =
      normalSideOf(acc.type) === "DEBIT" ? opening : opening.negated();
    const signed = openingSigned.plus(accountNetAsDebitCredit(lines, accountId));
    const openingThb = dec(openingBalancesThb[accountId]) ?? new Decimal(0);
    const openingThbSigned =
      normalSideOf(acc.type) === "DEBIT" ? openingThb : openingThb.negated();
    const signedThb = openingThbSigned.plus(accountNetAsDebitCreditThb(lines, accountId));

    const row: BalanceSheetRow = {
      accountId,
      code: acc.code,
      name: acc.name,
      currency: acc.currency,
      // Positive magnitude on the normal side (may turn contra-negative).
      balance: fmt(
        normalSideOf(acc.type) === "DEBIT" ? signed : signed.negated()
      ),
      balanceThb: fmt(
        normalSideOf(acc.type) === "DEBIT" ? signedThb : signedThb.negated()
      ),
    };

    if (acc.type === "ASSET") {
      totalAssets = totalAssets.plus(signed);
      totalAssetsThb = totalAssetsThb.plus(signedThb);
      assets.push(row);
      track(acc.currency, "ASSET", signed, signedThb);
    } else if (acc.type === "LIABILITY") {
      totalLiabilities = totalLiabilities.plus(signed.negated());
      totalLiabilitiesThb = totalLiabilitiesThb.plus(signedThb.negated());
      liabilities.push(row);
      track(acc.currency, "LIABILITY", signed, signedThb);
    } else if (acc.type === "EQUITY") {
      totalEquity = totalEquity.plus(signed.negated());
      totalEquityThb = totalEquityThb.plus(signedThb.negated());
      equity.push(row);
      track(acc.currency, "EQUITY", signed, signedThb);
    }
  }

  // Current-period net income folds into equity so A = L + E + NI.
  const netIncomeLines = lines.map((l) => ({ ...l, currency: accounts[l.accountId]?.currency ?? "THB" }));
  const incomeReport = incomeStatement(netIncomeLines, accounts);
  const netIncome = dec(incomeReport.netIncome) ?? new Decimal(0);
  const netIncomeThb = dec(incomeReport.netIncomeThb) ?? new Decimal(0);
  const totalEquityAndLiabilities = totalLiabilities.plus(totalEquity).plus(netIncome);
  const totalEquityAndLiabilitiesThb = totalLiabilitiesThb.plus(totalEquityThb).plus(netIncomeThb);

  assets.sort((a, b) => a.code.localeCompare(b.code));
  liabilities.sort((a, b) => a.code.localeCompare(b.code));
  equity.sort((a, b) => a.code.localeCompare(b.code));

  const totalsByCurrency = Array.from(byCurrency.entries())
    .map(([currency, b]) => ({
      currency,
      assets: fmt(b.assets),
      liabilities: fmt(b.liabilities),
      equity: fmt(b.equity),
      assetsThb: fmt(b.assetsThb),
      liabilitiesThb: fmt(b.liabilitiesThb),
      equityThb: fmt(b.equityThb),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    assets,
    liabilities,
    equity,
    netIncome: fmt(netIncome),
    totalAssets: fmt(totalAssets),
    totalEquityAndLiabilities: fmt(totalEquityAndLiabilities),
    balanced: totalAssets.equals(totalEquityAndLiabilities),
    netIncomeThb: fmt(netIncomeThb),
    totalAssetsThb: fmt(totalAssetsThb),
    totalEquityAndLiabilitiesThb: fmt(totalEquityAndLiabilitiesThb),
    balancedThb: totalAssetsThb.equals(totalEquityAndLiabilitiesThb),
    totalsByCurrency,
  };
}

function accountNetAsDebitCredit(
  lines: { accountId: string; side: Side; amount: string }[],
  accountId: string
): Decimal {
  let debit = new Decimal(0);
  let credit = new Decimal(0);
  for (const l of lines) {
    if (l.accountId !== accountId) continue;
    if (l.side === "DEBIT") debit = debit.plus(dec(l.amount) ?? 0);
    else credit = credit.plus(dec(l.amount) ?? 0);
  }
  return debit.minus(credit);
}

/** THB-base parallel of accountNetAsDebitCredit (stored amountThb). */
function accountNetAsDebitCreditThb(
  lines: { accountId: string; side: Side; amountThb?: string }[],
  accountId: string
): Decimal {
  let debit = new Decimal(0);
  let credit = new Decimal(0);
  for (const l of lines) {
    if (l.accountId !== accountId) continue;
    const thb = dec(l.amountThb ?? "") ?? new Decimal(0);
    if (l.side === "DEBIT") debit = debit.plus(thb);
    else credit = credit.plus(thb);
  }
  return debit.minus(credit);
}

// ---------------------------------------------------------------------------
// Per-symbol memo summary (e.g. dividends "เงินปันผล" grouped by stock)
// ---------------------------------------------------------------------------

/** Minimal shape of a persisted journal line that a memo summary can read. */
export interface SymbolSummaryLine {
  currency: string;
  memo: string | null;
  debitAmount: string | null;
  creditAmount: string | null;
  /** Positive magnitude in THB derived from fxRateEffective. */
  amountThb: string;
}

export interface LedgerSymbolSummary {
  /** Uppercased memo (the ticker), or "(ไม่ระบุหุ้น)" when the line has none. */
  symbol: string;
  currency: string;
  /** Number of lines (postings) that carried this symbol. */
  count: number;
  /** Net amount in the line's own currency (credit − debit). */
  amount: string;
  /** Net amount in THB (credit − debit, from the stored THB base). */
  amountThb: string;
}

/**
 * Group journal lines by their memo label (the per-stock key on dividend
 * postings) so a dividend account / income statement can answer "which stock
 * paid how much". Pure + Decimal, no sign imputation: each line's net is
 * credit − debit exactly as posted. Memo-less lines fold into "(ไม่ระบุหุ้น)".
 */
export function summarizeLinesBySymbol(
  lines: readonly SymbolSummaryLine[]
): LedgerSymbolSummary[] {
  const buckets = new Map<
    string,
    { symbol: string; currency: string; count: number; amount: Decimal; amountThb: Decimal }
  >();
  for (const l of lines) {
    const symbol = (l.memo ?? "").trim().toUpperCase() || "(ไม่ระบุหุ้น)";
    if (symbol === "(ไม่ระบุหุ้น)") {
      // Nothing that identifies a stock — skip noise in the stock breakdown.
      continue;
    }
    const key = `${symbol}|${l.currency}`;
    const bucket =
      buckets.get(key) ??
      {
        symbol,
        currency: l.currency,
        count: 0,
        amount: new Decimal(0),
        amountThb: new Decimal(0),
      };
    bucket.count += 1;
    bucket.amount = bucket.amount
      .plus(dec(l.creditAmount ?? "0") ?? new Decimal(0))
      .minus(dec(l.debitAmount ?? "0") ?? new Decimal(0));
    bucket.amountThb = bucket.amountThb
      .plus(l.creditAmount != null ? dec(l.amountThb) ?? new Decimal(0) : new Decimal(0))
      .minus(l.debitAmount != null ? dec(l.amountThb) ?? new Decimal(0) : new Decimal(0));
    buckets.set(key, bucket);
  }
  return Array.from(buckets.values())
    .map((b) => ({
      symbol: b.symbol,
      currency: b.currency,
      count: b.count,
      amount: fmt(b.amount),
      amountThb: fmt(b.amountThb),
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.currency.localeCompare(b.currency));
}