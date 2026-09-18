import { roundMoney, moneyInThb } from "./accounting-amounts";
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
  { code: "3020", name: "ส่วนทุน - เงินลงทุนเริ่มต้น (THB)", type: "EQUITY", currency: "THB" },
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
  input: JournalEntryInput,
  accountCurrencies?: ReadonlyMap<string, string>
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
  const isFxConversion = input.detail?.isFxConversion === true;
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
    const rawAmount = dec(raw as string | number);
    const amount = rawAmount ? new Decimal(roundMoney(rawAmount)) : null;
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
    const amountThb = new Decimal(moneyInThb(amount, eff));
    if (amountThb.lte(0)) {
      errors.push(`${idx}: rounded THB amount must be positive`);
      return;
    }
    if (accountCurrencies && accountCurrencies.get(line.accountId) !== currency) {
      errors.push(`${idx}: account currency is incompatible with ${currency}`);
      return;
    }

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

  if (!isSkipped && isFxConversion) {
    const d = input.detail!;
    const debit = lines.find(l => l.side === "DEBIT");
    const credit = lines.find(l => l.side === "CREDIT");
    const received = dec(d.amount ?? "");
    const sent = dec(d.exchangeFromAmount ?? "");
    if (d.category !== "asset" || d.side != null || lines.length !== 2 ||
      Object.keys(byCurrency).length !== 2 || !debit || !credit ||
      debit.currency !== d.currency || credit.currency !== d.exchangeFromCurrency ||
      !received?.gt(0) || !sent?.gt(0) ||
      debit.amount !== roundMoney(received) || credit.amount !== roundMoney(sent)) {
      errors.push("FX conversion requires one received-asset debit and one sent-asset credit matching the exchange detail");
    }
  }
  if (!isSkipped && !isFxConversion) {
    for (const [currency, bucket] of Object.entries(byCurrency)) {
      if (!bucket.debit.equals(bucket.credit)) {
        errors.push(
          `${currency} does not balance: debit ${fmt(bucket.debit)} != credit ${fmt(bucket.credit)}`
        );
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Confirmed exchange entries balance in reporting currency, not native units.
  if (!isSkipped && (isFxConversion || Object.keys(byCurrency).length === 1)) {
    const debitThb = Decimal.sum(0, ...lines.filter(l => l.side === "DEBIT").map(l => l.amountThb));
    const creditThb = Decimal.sum(0, ...lines.filter(l => l.side === "CREDIT").map(l => l.amountThb));
    if (!debitThb.eq(creditThb)) errors.push("THB does not balance: debit " + debitThb + " != credit " + creditThb);
  }
  if (errors.length > 0) return { ok: false, errors };

  const d = input.detail ?? {};
  const detailAmount = dec(d.amount ?? "");
  const detailFx = d.currency?.toUpperCase() === "THB" ? new Decimal(1) : dec(d.fxRateEffective ?? "");
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
    amount: detailAmount ? roundMoney(detailAmount) : null,
    amountThb: detailAmount && detailFx?.gt(0) ? moneyInThb(detailAmount, detailFx) : null,
    fxRateEffective: d.fxRateEffective != null ? String(d.fxRateEffective) : null,
    fxRateStatement: d.fxRateStatement != null ? String(d.fxRateStatement) : null,
    isFxConversion,
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
  detail?: JournalTradeDetail;
}

/**
 * Build a reversal candidate that mirrors the original entry inverting every
 * leg. Callers verify with validateJournalEntry and persist it as a new
 * POSTED entry (a reversal is a real event, not a delete).
 */
export function buildReversal(entry: ValidatedJournalEntry): ReversalCandidate {
  const sent = entry.lines.find(l => l.side === "CREDIT");
  const received = entry.lines.find(l => l.side === "DEBIT");
  const detail = entry.detail.isFxConversion && sent && received ? {
    ...entry.detail,
    currency: sent.currency, amount: sent.amount, amountThb: sent.amountThb,
    fxRateEffective: sent.fxRateEffective, fxRateStatement: sent.fxRateStatement,
    exchangeFromCurrency: received.currency, exchangeFromAmount: received.amount,
    exchangeRate: null,
  } : undefined;
  return {
    entryDate: entry.entryDate,
    description: `กลับรายการ: ${entry.description}`,
    sourceType: "MANUAL",
    sourceTransactionId: entry.sourceTransactionId,
    lines: rejectionLines(entry),
    ...(detail ? { detail } : {}),
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

/** Null means no honest reporting value is available. Native totals only exist for one currency. */
type ReportLine = {
    accountId: string;
    currency?: string;
    side: Side;
    amount: string;
    amountThb?: string | null;
    postingState?: string;
};
export type ReportingStatus = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
const sumMoney = (vs: (string | null)[]): string | null => vs.some(v => v == null) ? null : fmt(vs.reduce<Decimal>((s, v) => s.plus(v!), new Decimal(0)));
const minusMoney = (a: string | null, b: string | null) => a == null || b == null ? null : fmt(new Decimal(a).minus(b));
const statusOf = (vs: (string | null)[]): ReportingStatus => vs.every(v => v != null) ? "COMPLETE" : vs.some(v => v != null) ? "PARTIAL" : "UNAVAILABLE";
const posted = (ls: ReportLine[]) => ls.filter(l => l.postingState == null || l.postingState === "POSTED");
export function reportOpeningLines(accounts: AccountMap, openings: Record<string, string> = {}, thb: Record<string, string> = {}): ReportLine[] {
    return Object.entries(openings).filter(([id, v]) => accounts[id] && !new Decimal(v).isZero()).map(([id, v]) => ({ accountId: id, currency: accounts[id].currency, side: normalSideOf(accounts[id].type), amount: v, amountThb: thb[id] ?? (accounts[id].currency === "THB" ? v : null) }));
}
export interface TrialBalanceRow {
    accountId: string;
    code: string;
    name: string;
    type: AccountType;
    currency: string;
    debit: string;
    credit: string;
    balance: string;
    debitThb: string | null;
    creditThb: string | null;
    balanceThb: string | null;
}
/** Closing account balances, not gross turnover. Openings use the normal side. */
export function trialBalance(lines: ReportLine[], accounts: AccountMap, openings: Record<string, string> = {}, openingsThb: Record<string, string> = {}) {
    const groups = new Map<string, ReportLine[]>();
    for (const l of [...reportOpeningLines(accounts, openings, openingsThb), ...posted(lines)]) {
        const key = l.accountId + "|" + (l.currency ?? accounts[l.accountId]?.currency);
        groups.set(key, [...(groups.get(key) ?? []), l]);
    }
    const split = (v: string | null, dr: boolean) => v == null ? null : fmt(Decimal.max(new Decimal(v).mul(dr ? 1 : -1), 0));
    const rows: TrialBalanceRow[] = [...groups.values()].map(ls => {
        const l = ls[0], a = accounts[l.accountId];
        const balance = fmt(ls.reduce((s, r) => s.plus(new Decimal(r.amount).mul(r.side === "DEBIT" ? 1 : -1)), new Decimal(0)));
        const thb = sumMoney(ls.map(r => r.amountThb == null ? null : fmt(new Decimal(r.amountThb).mul(r.side === "DEBIT" ? 1 : -1))));
        return { accountId: l.accountId, code: a?.code ?? l.accountId, name: a?.name ?? "Unknown account", type: a?.type ?? "ASSET", currency: l.currency ?? a.currency,
            debit: split(balance, true)!, credit: split(balance, false)!, balance, debitThb: split(thb, true), creditThb: split(thb, false), balanceThb: thb };
    }).sort((a, b) => a.code.localeCompare(b.code));
    const totalsByCurrency = [...new Set(rows.map(r => r.currency))].sort().map(currency => {
        const rs = rows.filter(r => r.currency === currency), debit = sumMoney(rs.map(r => r.debit))!, credit = sumMoney(rs.map(r => r.credit))!;
        return { currency, debit, credit, balanced: debit === credit, debitThb: sumMoney(rs.map(r => r.debitThb)), creditThb: sumMoney(rs.map(r => r.creditThb)) };
    });
    const totalDebitThb = sumMoney(rows.map(r => r.debitThb)), totalCreditThb = sumMoney(rows.map(r => r.creditThb));
    return { rows, totalsByCurrency, totalDebit: totalsByCurrency.length > 1 ? null : totalsByCurrency[0]?.debit ?? "0.00", totalCredit: totalsByCurrency.length > 1 ? null : totalsByCurrency[0]?.credit ?? "0.00",
        balanced: totalsByCurrency.every(t => t.balanced), totalDebitThb, totalCreditThb, balancedThb: totalDebitThb != null && totalDebitThb === totalCreditThb, reportingStatus: statusOf(rows.map(r => r.balanceThb)) };
}
export type TrialBalanceResult = ReturnType<typeof trialBalance>;
export type TrialBalanceCurrencyTotal = TrialBalanceResult["totalsByCurrency"][number];
export interface IncomeStatementLine {
    accountId: string;
    code: string;
    name: string;
    type: "INCOME" | "EXPENSE";
    currency: string;
    amount: string;
    amountThb: string | null;
}
export function incomeStatement(lines: ReportLine[], accounts: AccountMap) {
    const tb = trialBalance(posted(lines).filter(l => ["INCOME", "EXPENSE"].includes(accounts[l.accountId]?.type)), accounts);
    const report: IncomeStatementLine[] = tb.rows.map(r => ({ accountId: r.accountId, code: r.code, name: r.name, type: r.type as "INCOME" | "EXPENSE", currency: r.currency,
        amount: fmt(new Decimal(r.balance).mul(r.type === "INCOME" ? -1 : 1)), amountThb: r.balanceThb == null ? null : fmt(new Decimal(r.balanceThb).mul(r.type === "INCOME" ? -1 : 1)) }));
    const totals = (rs: IncomeStatementLine[]) => {
        const income = sumMoney(rs.filter(r => r.type === "INCOME").map(r => r.amount))!, expense = sumMoney(rs.filter(r => r.type === "EXPENSE").map(r => r.amount))!;
        const incomeThb = sumMoney(rs.filter(r => r.type === "INCOME").map(r => r.amountThb)), expenseThb = sumMoney(rs.filter(r => r.type === "EXPENSE").map(r => r.amountThb));
        return { income, expense, netIncome: minusMoney(income, expense)!, incomeThb, expenseThb, netIncomeThb: minusMoney(incomeThb, expenseThb) };
    };
    const totalsByCurrency = [...new Set(report.map(r => r.currency))].sort().map(currency => ({ currency, ...totals(report.filter(r => r.currency === currency)) }));
    const native = totalsByCurrency.length <= 1, all = totals(native ? report : []);
    const totalIncomeThb = sumMoney(totalsByCurrency.map(t => t.incomeThb)), totalExpenseThb = sumMoney(totalsByCurrency.map(t => t.expenseThb));
    return { lines: report, totalsByCurrency, totalIncome: native ? all.income : null, totalExpense: native ? all.expense : null, netIncome: native ? all.netIncome : null,
        totalIncomeThb, totalExpenseThb, netIncomeThb: minusMoney(totalIncomeThb, totalExpenseThb), reportingStatus: tb.reportingStatus };
}
export type IncomeStatementResult = ReturnType<typeof incomeStatement>;
export type IncomeStatementCurrencyTotal = IncomeStatementResult["totalsByCurrency"][number];
export interface BalanceSheetRow {
    accountId: string;
    code: string;
    name: string;
    currency: string;
    balance: string;
    balanceThb: string | null;
}
/** All unclosed earnings through the as-of cutoff are included in equity. */
export function balanceSheet(lines: ReportLine[], accounts: AccountMap, openings: Record<string, string> = {}, openingsThb: Record<string, string> = {}, periodLines?: ReportLine[]) {
    const ls = [...reportOpeningLines(accounts, openings, openingsThb), ...posted(lines)], tb = trialBalance(ls, accounts), accumulatedIncome = incomeStatement(ls, accounts), income = periodLines == null ? accumulatedIncome : incomeStatement(periodLines, accounts);
    const rows = (type: AccountType): BalanceSheetRow[] => tb.rows.filter(r => r.type === type).map(r => ({ accountId: r.accountId, code: r.code, name: r.name, currency: r.currency,
        balance: fmt(new Decimal(r.balance).mul(type === "ASSET" ? 1 : -1)), balanceThb: r.balanceThb == null ? null : fmt(new Decimal(r.balanceThb).mul(type === "ASSET" ? 1 : -1)) }));
    const assets = rows("ASSET"), liabilities = rows("LIABILITY"), equity = rows("EQUITY");
    // Report-only prior unclosed earnings: no journal entry or account is fabricated.
    if (periodLines != null)
        for (const prior of accumulatedIncome.totalsByCurrency) {
            const current = income.totalsByCurrency.find(t => t.currency === prior.currency);
            const balance = minusMoney(prior.netIncome, current?.netIncome ?? "0.00")!;
            const balanceThb = minusMoney(prior.netIncomeThb, current ? current.netIncomeThb : "0.00");
            if (balance !== "0.00" || balanceThb !== "0.00")
                equity.push({ accountId: "report-prior-earnings-" + prior.currency, code: "", name: "Prior unclosed earnings", currency: prior.currency, balance, balanceThb });
        }
    const totalsByCurrency = [...new Set(tb.rows.map(r => r.currency))].sort().map(currency => {
        const total = (rs: BalanceSheetRow[], thb = false) => sumMoney(rs.filter(r => r.currency === currency).map(r => thb ? r.balanceThb : r.balance));
        const ni = income.totalsByCurrency.find(t => t.currency === currency), a = total(assets)!, l = total(liabilities)!, e = total(equity)!, n = ni?.netIncome ?? "0.00";
        return { currency, assets: a, liabilities: l, equity: e, netIncome: n, assetsThb: total(assets, true), liabilitiesThb: total(liabilities, true), equityThb: total(equity, true), netIncomeThb: ni ? ni.netIncomeThb : "0.00", balanced: a === sumMoney([l, e, n]) };
    });
    const native = totalsByCurrency.length <= 1, totalAssetsThb = sumMoney(assets.map(r => r.balanceThb)), totalLiabilitiesThb = sumMoney(liabilities.map(r => r.balanceThb)), totalEquityThb = sumMoney(equity.map(r => r.balanceThb));
    const totalEquityAndLiabilitiesThb = sumMoney([totalLiabilitiesThb, totalEquityThb, income.netIncomeThb]);
    return { assets, liabilities, equity, totalsByCurrency, netIncome: native ? income.netIncome : null, totalAssets: native ? sumMoney(assets.map(r => r.balance)) : null,
        totalEquityAndLiabilities: native ? sumMoney([...liabilities, ...equity].map(r => r.balance).concat(income.netIncome ?? "0.00")) : null, balanced: totalsByCurrency.every(t => t.balanced),
        netIncomeThb: income.netIncomeThb, totalAssetsThb, totalLiabilitiesThb, totalEquityThb, totalEquityAndLiabilitiesThb,
        balancedThb: totalAssetsThb != null && totalEquityAndLiabilitiesThb != null && totalAssetsThb === totalEquityAndLiabilitiesThb, reportingStatus: tb.reportingStatus };
}
export type BalanceSheetResult = ReturnType<typeof balanceSheet>;
export type BalanceSheetCurrencyTotal = BalanceSheetResult["totalsByCurrency"][number];

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
