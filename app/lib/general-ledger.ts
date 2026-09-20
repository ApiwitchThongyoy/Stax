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

/** Memo carried by the auto THB rounding-adjustment leg the posting engine
 * adds when a fully-valid single-currency non-THB entry's per-line THB bases
 * differ by at most 0.01 (a 2-stage round-trip satang). The validator uses the
 * exact memo to recognise the leg and validate the whole rounding shape
 * instead of failing the entry on a THB reporting-base imbalance. */
export const ROUNDING_ADJUSTMENT_MEMO = "THB rounding adjustment";

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
    const received = dec(d.amount ?? "");
    const sent = dec(d.exchangeFromAmount ?? "");
    // The two cash legs are identified deterministically (side + currency +
    // amount) from the exchange detail — never by array position or "first
    // debit/credit" — so a well-formed THB variance leg can never be mistaken
    // for either cash leg (its THB amount never equals a source/received cash
    // amount at realistic magnitudes).
    const receivedAmount = received?.gt(0) ? roundMoney(received) : "";
    const sentAmount = sent?.gt(0) ? roundMoney(sent) : "";
    const receivedLine = lines.find(
      (l) => l.side === "DEBIT" &&
        l.currency === (d.currency ?? "").trim().toUpperCase() &&
        l.amount === receivedAmount
    );
    const sentLine = lines.find(
      (l) => l.side === "CREDIT" &&
        l.currency === (d.exchangeFromCurrency ?? "").trim().toUpperCase() &&
        l.amount === sentAmount
    );
    const varianceLines = lines.filter((l) => l !== receivedLine && l !== sentLine);
    if (d.category !== "asset" || d.side != null || lines.length < 2 || lines.length > 3 ||
      Object.keys(byCurrency).length !== 2 || !receivedLine || !sentLine ||
      !received?.gt(0) || !sent?.gt(0)) {
      errors.push("FX conversion requires one received-asset debit and one sent-asset credit matching the exchange detail");
    } else {
      const receivedThb = new Decimal(receivedLine.amountThb);
      const sentThb = new Decimal(sentLine.amountThb);
      const diff = receivedThb.minus(sentThb);
      if (varianceLines.length === 1) {
        const v = varianceLines[0];
        const expectedSide = diff.gt(0) ? "CREDIT" : "DEBIT";
        if (diff.isZero() || v.currency !== "THB" || v.side !== expectedSide ||
          v.amount !== roundMoney(diff.abs())) {
          errors.push("FX conversion variance line must be THB with amount and side exactly equal to the reporting-base difference");
        }
      } else if (varianceLines.length === 0) {
        if (!diff.isZero()) {
          errors.push(
            `FX conversion does not balance in THB: received ${receivedLine.amountThb} != sent ${sentLine.amountThb}`
          );
        }
      } else {
        errors.push("FX conversion requires exactly two cash legs and at most one THB variance line");
      }
    }
  }
  const roundingLines = lines.filter((l) => l.memo === ROUNDING_ADJUSTMENT_MEMO);
  const hasRoundingAdjustment = roundingLines.length >= 1;
  if (!isSkipped && !isFxConversion && hasRoundingAdjustment) {
    // Automatic THB rounding-adjustment leg: the posting engine adds it ONLY to
    // a fully-valid single-currency non-THB entry whose per-line THB reporting
    // bases differ by <= 0.01. A THB-only leg never balances natively, so the
    // standard per-currency check is skipped in favour of validating the exact
    // rounding shape: one THB rounding leg of exactly the base difference.
    if (roundingLines.length > 1) {
      errors.push("THB rounding adjustment allows at most one line");
    } else {
      const rounding = roundingLines[0];
      const nonRounding = lines.filter((l) => l.memo !== ROUNDING_ADJUSTMENT_MEMO);
      const baseCurrencies = [...new Set(nonRounding.map((l) => l.currency))];
      const base = baseCurrencies.length === 1 ? baseCurrencies[0] : null;
      if (!base || base === "THB") {
        errors.push("THB rounding adjustment requires every other leg to share one non-THB currency");
      } else {
        const bucket = byCurrency[base];
        if (!bucket || !bucket.debit.equals(bucket.credit)) {
          errors.push(`${base} does not balance: debit ${fmt(bucket ? bucket.debit : new Decimal(0))} != credit ${fmt(bucket ? bucket.credit : new Decimal(0))}`);
        }
        const baseDebitThb = Decimal.sum(0, ...nonRounding.filter(l => l.side === "DEBIT").map(l => l.amountThb));
        const baseCreditThb = Decimal.sum(0, ...nonRounding.filter(l => l.side === "CREDIT").map(l => l.amountThb));
        const diff = baseDebitThb.minus(baseCreditThb);
        const expectedSide = diff.gt(0) ? "CREDIT" : "DEBIT";
        if (diff.isZero()) {
          errors.push("THB rounding adjustment is not needed: reporting base already balances");
        } else if (diff.abs().gt(new Decimal("0.01"))) {
          errors.push("THB rounding adjustment must not hide a reporting-base difference larger than 0.01");
        } else if (rounding.currency !== "THB" || rounding.side !== expectedSide || rounding.amount !== roundMoney(diff.abs())) {
          errors.push("THB rounding adjustment line must be THB with amount and side exactly equal to the reporting-base difference");
        }
        const debitThb = Decimal.sum(0, ...lines.filter(l => l.side === "DEBIT").map(l => l.amountThb));
        const creditThb = Decimal.sum(0, ...lines.filter(l => l.side === "CREDIT").map(l => l.amountThb));
        if (!debitThb.eq(creditThb)) {
          errors.push(`THB does not balance: debit ${fmt(debitThb)} != credit ${fmt(creditThb)}`);
        }
      }
    }
  } else if (!isSkipped && !isFxConversion) {
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
  // For FX entries identify the received (DEBIT) and sent (CREDIT) cash legs
  // DETERMINISTICALLY from the exchange detail so a 3-leg entry (received cash,
  // sent cash, THB 5020 variance) always reverses the right cash legs and the
  // variance leg is the leftover that gets its side flipped. Non-FX keeps the
  // generic first debit/credit (entries are strict 2-leg).
  const isFx = entry.detail.isFxConversion;
  const sent = isFx
    ? entry.lines.find(
        (l) => l.side === "CREDIT" &&
          l.currency === (entry.detail.exchangeFromCurrency ?? "").trim().toUpperCase()
      )
    : entry.lines.find((l) => l.side === "CREDIT");
  const received = isFx
    ? entry.lines.find(
        (l) => l.side === "DEBIT" &&
          l.currency === (entry.detail.currency ?? "").trim().toUpperCase()
      )
    : entry.lines.find((l) => l.side === "DEBIT");
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
        // THB reporting base is the authoritative "balanced" signal when it is
        // fully derivable; a multi-currency book without a THB base for any row
        // falls back to native per-currency equality (the pre-rounding-era rule).
        balanced: totalDebitThb != null && totalCreditThb != null ? totalDebitThb === totalCreditThb : totalsByCurrency.every(t => t.balanced), totalDebitThb, totalCreditThb, balancedThb: totalDebitThb != null && totalDebitThb === totalCreditThb, reportingStatus: statusOf(rows.map(r => r.balanceThb)) };
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
        totalEquityAndLiabilities: native ? sumMoney([...liabilities, ...equity].map(r => r.balance).concat(income.netIncome ?? "0.00")) : null,
        // Same THB-primary rule as the trial balance: trust the fully-derivable
        // THB base first, fall back to native per-currency equality otherwise.
        balanced: totalAssetsThb != null && totalEquityAndLiabilitiesThb != null ? totalAssetsThb === totalEquityAndLiabilitiesThb : totalsByCurrency.every(t => t.balanced),
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

// ---------------------------------------------------------------------------
// Account-category batch summary (one server call for ALL accounts of a class,
// no N+1). Mirrors getAccountLedger semantics so the category page and the
// per-account detail page can never disagree:
//   - opening    = account.openingBalance + POSTED postings with entryDate < from
//   - movement   = net POSTED activity on/after `from` (on the account's normal
//                  side: ASSET/EXPENSE debit-positive, LIABILITY/EQUITY/INCOME
//                  credit-positive)
//   - closing    = opening + movement
//   - lineCount  = number of POSTED journal lines in the period
// SKIPPED entries are handled upstream (only POSTED lines are ever passed in) —
// this engine never sees them and therefore never counts them.
// ---------------------------------------------------------------------------

export interface AccountLedgerSummaryLineInput {
  accountId: string;
  /** ISO date (yyyy-mm-dd) of the owning journal entry. */
  entryDate: string;
  side: Side;
  amount: string;
}

export interface AccountLedgerSummaryInput extends AccountInfo {
  accountId: string;
  /** accounts.openingBalance (null = no opening balance recorded). */
  openingBalance: string | null;
}

/** One row per account in the queried category, native currency only. */
export interface AccountLedgerSummaryRow extends AccountInfo {
  accountId: string;
  /** Balance accumulated before `from` (openingBalance + prior POSTED lines). */
  opening: string;
  /** Gross POSTED debits in the period. */
  debitMovement: string;
  /** Gross POSTED credits in the period. */
  creditMovement: string;
  /** netMovement on the account's normal side (closing − opening). */
  netMovement: string;
  /** opening + netMovement (balance through the as-of cutoff). */
  closing: string;
  /** POSTED journal lines in the period. */
  lineCount: number;
}

export interface AccountLedgerSummaryCurrencyTotal {
  currency: string;
  opening: string;
  movement: string;
  closing: string;
}

export interface AccountLedgerSummaryResult {
  rows: AccountLedgerSummaryRow[];
  totalsByCurrency: AccountLedgerSummaryCurrencyTotal[];
}

export function summarizeAccountLedgers(
  accounts: readonly AccountLedgerSummaryInput[],
  lines: readonly AccountLedgerSummaryLineInput[],
  from?: string
): AccountLedgerSummaryResult {
  const linesByAccount = new Map<string, AccountLedgerSummaryLineInput[]>();
  for (const line of lines) {
    const bucket = linesByAccount.get(line.accountId);
    if (bucket) bucket.push(line);
    else linesByAccount.set(line.accountId, [line]);
  }
  const rows: AccountLedgerSummaryRow[] = [];
  for (const a of accounts) {
    const normalSide = normalSideOf(a.type);
    const movementOf = (l: AccountLedgerSummaryLineInput) =>
      new Decimal(l.amount).mul(l.side === normalSide ? 1 : -1);

    let opening = new Decimal(a.openingBalance ?? "0");
    const period: AccountLedgerSummaryLineInput[] = [];
    for (const l of linesByAccount.get(a.accountId) ?? []) {
      if (from && l.entryDate < from) {
        opening = opening.plus(movementOf(l));
      } else {
        period.push(l);
      }
    }

    let debit = new Decimal(0);
    let credit = new Decimal(0);
    for (const l of period) {
      if (l.side === "DEBIT") debit = debit.plus(l.amount);
      else credit = credit.plus(l.amount);
    }
    const net = normalSide === "DEBIT" ? debit.minus(credit) : credit.minus(debit);
    const closing = opening.plus(net);

    rows.push({
      accountId: a.accountId,
      code: a.code,
      name: a.name,
      type: a.type,
      currency: a.currency,
      opening: fmt(opening),
      debitMovement: fmt(debit),
      creditMovement: fmt(credit),
      netMovement: fmt(net),
      closing: fmt(closing),
      lineCount: period.length,
    });
  }
  const totalsByCurrency = [...new Set(rows.map((r) => r.currency))]
    .sort()
    .map((currency) => {
      const rs = rows.filter((r) => r.currency === currency);
      return {
        currency,
        opening: fmt(rs.reduce((s, r) => s.plus(r.opening), new Decimal(0))),
        movement: fmt(rs.reduce((s, r) => s.plus(r.netMovement), new Decimal(0))),
        closing: fmt(rs.reduce((s, r) => s.plus(r.closing), new Decimal(0))),
      };
    });
  return { rows, totalsByCurrency };
}

// ---------------------------------------------------------------------------
// Monthly closing (งบปิดเดือน): one account-balance snapshot per month + a
// double-sided balance check and a continuity invariant. Each month's opening
// is always computed from the STORED opening balance plus the full prior
// history (never from the previous report), so `from`/`to` only limit WHICH
// months are reported — they never change the numbers. Sides are checked on
// the month's OWN lines (debit === credit per native currency via the trial
// balance). Continuity: month[N+1].opening must equal month[N].closing for
// every account+currency — if it ever does not, the report flags the pair.
// ---------------------------------------------------------------------------

export interface MonthlyClosingLineInput extends AccountLedgerSummaryLineInput {
  /** Stored THB base (null when the source line has none). */
  amountThb?: string | null;
}

/** One account's balance snapshot for a single month (normal-side movement). */
export interface MonthlyClosingAccountRow extends AccountLedgerSummaryRow {}

export interface MonthlyClosingMonthResult {
  /** ISO "yyyy-mm". */
  month: string;
  rows: MonthlyClosingAccountRow[];
  totalsByCurrency: AccountLedgerSummaryCurrencyTotal[];
  /** The month's own POSTED lines balance (debit === credit) in every currency. */
  balanced: boolean;
  /** THB-base balance check; null when some line carries no THB base. */
  balancedThb: boolean | null;
  /** Number of POSTED journal lines in the month. */
  lineCount: number;
}

export interface MonthlyClosingContinuityIssue {
  /** The month whose opening mismatches the previous month's closing. */
  month: string;
  accountId: string;
  currency: string;
  /** Closing of the previous month. */
  expected: string;
  /** Opening of this month (as computed from the full prior history). */
  actual: string;
}

export interface MonthlyClosingContinuity {
  ok: boolean;
  issues: MonthlyClosingContinuityIssue[];
}

export interface MonthlyClosingResult {
  months: MonthlyClosingMonthResult[];
  continuity: MonthlyClosingContinuity;
}

function monthStart(month: string): string {
  return `${month}-01`;
}

function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

function betweenMonths(from: string, to: string): string[] {
  const [y0, m0] = from.split("-").map(Number);
  const [y1, m1] = to.split("-").map(Number);
  const out: string[] = [];
  let y = y0;
  let m = m0;
  let guard = 0;
  while ((y !== y1 || m !== m1) && guard < 600) {
    out.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    guard += 1;
  }
  out.push(`${String(y1).padStart(4, "0")}-${String(m1).padStart(2, "0")}`);
  return out;
}

function derivedMonthRange(lines: readonly MonthlyClosingLineInput[]): {
  from: string;
  to: string;
} {
  let min = "";
  let max = "";
  for (const l of lines) {
    const m = l.entryDate.slice(0, 7);
    if (!min || m < min) min = m;
    if (!max || m > max) max = m;
  }
  if (!min) {
    const now = new Date();
    min = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    max = min;
  }
  return { from: min, to: max };
}

export function buildMonthlyClosing(
  accounts: readonly AccountLedgerSummaryInput[],
  lines: readonly MonthlyClosingLineInput[],
  from?: string,
  to?: string
): MonthlyClosingResult {
  const range = from && to ? { from, to } : derivedMonthRange(lines);
  const months = betweenMonths(range.from, range.to);
  const accountMap: Record<string, AccountInfo> = Object.fromEntries(
    accounts.map((a) => [
      a.accountId,
      { code: a.code, name: a.name, type: a.type, currency: a.currency },
    ])
  );
  const monthResults: MonthlyClosingMonthResult[] = [];
  const prevClosingsByAccount = new Map<string, string>();
  const issues: MonthlyClosingContinuityIssue[] = [];

  for (const month of months) {
    const start = monthStart(month);
    const end = monthEnd(month);
    const linesUpToEnd = lines.filter((l) => l.entryDate <= end);
    const monthOnly = lines.filter((l) => l.entryDate >= start && l.entryDate <= end);
    const summary = summarizeAccountLedgers(accounts, linesUpToEnd, start);
    const tb = trialBalance(
      monthOnly.map((l) => {
        const a = accounts.find((x) => x.accountId === l.accountId);
        return {
          accountId: l.accountId,
          side: l.side,
          amount: l.amount,
          amountThb: l.amountThb ?? null,
          currency: a?.currency,
        } as ReportLine;
      }),
      accountMap
    );
    const balancedThb = monthOnly.every((l) => l.amountThb != null)
      ? tb.balancedThb
      : null;
    for (const r of summary.rows) {
      const key = `${r.accountId}|${r.currency}`;
      const prev = prevClosingsByAccount.get(key);
      if (prev != null && prev !== r.opening) {
        issues.push({
          month,
          accountId: r.accountId,
          currency: r.currency,
          expected: prev,
          actual: r.opening,
        });
      }
      prevClosingsByAccount.set(key, r.closing);
    }
    monthResults.push({
      month,
      rows: summary.rows,
      totalsByCurrency: summary.totalsByCurrency,
      balanced: tb.balanced,
      balancedThb,
      lineCount: monthOnly.length,
    });
  }

  return { months: monthResults, continuity: { ok: issues.length === 0, issues } };
}
