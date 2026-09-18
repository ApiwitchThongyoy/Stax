import { Decimal } from "decimal.js";
import {
  journalEntryToCapitalRow,
  listCashSummaryRows,
  listFxConversionRows,
} from "./journal-ledger-read";

Decimal.set({ precision: 40 });

function decimalAmount(raw: string | null): Decimal | null {
  if (raw == null || raw.trim() === "") return null;
  try {
    const value = new Decimal(raw);
    return value.isFinite() ? value : null;
  } catch {
    return null;
  }
}

/** One month of cash flow (equity money movements only). */
export interface CashSummaryMonth {
  /** ISO year-month "YYYY-MM" derived from transaction_date. */
  month: string;
  /** Sum of CASH_IN amount_thb for that month. */
  cashInThb: string;
  /** Sum of CASH_OUT amount_thb for that month. */
  cashOutThb: string;
  /** cashInThb - cashOutThb for that month. */
  netThb: string;
}

/** A single equity money movement (deposit/withdrawal) inside the requested scope. */
export interface CashSummaryDetailRow {
  transactionId: string;
  /** ISO date "YYYY-MM-DD". */
  transactionDate: string;
  type: "CASH_IN" | "CASH_OUT";
  sourceType: "AI_PARSED" | "MANUAL";
  category: string | null;
  currency: string;
  /** Foreign amount (positive magnitude, as stored). */
  amountForeign: string;
  /** THB amount actually counted in the summary. */
  amountThb: string;
}

/** A single currency-exchange record (CURRENCY EXCHANGE RECORDS from a statement). */
export interface CashSummaryExchangeRow {
  transactionId: string;
  /** ISO date "YYYY-MM-DD". */
  transactionDate: string;
  /** The currency given away (from side of the exchange). Null for legacy rows. */
  fromCurrency: string | null;
  /** The amount given away, in fromCurrency. Null for legacy rows. */
  fromAmount: string | null;
  /** The currency received (to side — the row's stored currency). */
  toCurrency: string | null;
  /** The amount received, in toCurrency. */
  toAmount: string | null;
  /** The rate the bank printed for the conversion. Null for legacy rows. */
  rate: string | null;
  /** THB amount actually recorded for the received side. */
  amountThb: string | null;
}

/** Per-currency totals of the received side across all exchange rows. */
export interface CashSummaryExchangeTotal {
  currency: string;
  /** Sum of toAmount for this currency. */
  totalForeign: string;
  /** Sum of amountThb for this currency. */
  totalThb: string;
}

/**
 * Direction comparison of currency exchanges: did we bring MORE money back
 * into THB (X→THB rows) than we exchanged OUT of THB (THB→X rows)?
 * Both sides are summed in THB (`amountThb`) so the net is a real comparison.
 * Legacy rows without a `fromCurrency` are NOT counted on the out side —
 * never guessed. `netThb` = into − out (positive = more back than out).
 */
export interface CashExchangeDirectionTotals {
  intoThbTotal: string;
  intoThbCount: number;
  outOfThbTotal: string;
  outOfThbCount: number;
  netThb: string;
  /** True when into − out is positive (more back than out); false otherwise. */
  moreInThanOut: boolean;
}

/** Full cash in/out summary: totals + per-month breakdown (descending). */
export interface CashSummary {
  /** Which scope produced this result. */
  view: "all" | "month" | "asOf";
  /**
   * Per-transaction detail rows inside the requested scope. Present ONLY when
   * the caller asked for a drill-down (withDetail) — never on the overview.
   */
  rows?: CashSummaryDetailRow[];
  months: CashSummaryMonth[];
  totalCashInThb: string;
  totalCashOutThb: string;
  totalNetThb: string;
  /**
   * Currency-exchange records (STATEMENT CURRENCY EXCHANGE lines). Separate
   * from the equity money-movement totals by design: an exchange merely moves
   * cash between currencies, it is never a deposit/withdrawal.
   */
  exchanges: CashSummaryExchangeRow[];
  /** Sum of the received side per currency across all exchange rows. */
  exchangeTotals: CashSummaryExchangeTotal[];
  /**
   * Direction comparison (into-THB vs out-of-THB), summed in THB. Present
   * whenever exchange rows are read; uses the same month/asOf scope.
   */
  exchangeDirectionTotals: CashExchangeDirectionTotals;
}

/** Scope controls for the pure aggregator (all optional, ISO strings). */
export interface CashSummaryOptions {
  /** Restrict to a single ISO year-month "YYYY-MM". */
  month?: string;
  /** Restrict to transactions on/before an ISO date "YYYY-MM-DD". */
  asOf?: string;
  /** Include per-transaction detail rows (drill-down). */
  withDetail?: boolean;
}

/**
 * Pure aggregator (DB-free, Decimal). Groups equity money movements by month
 * and totals the cash entering/leaving the account.
 *
 * A row belongs to the cash summary when it is an equity movement:
 *   - category = 'equity' (AI-parsed deposits/withdrawals AND manual rows
 *     created after the manual POST started stamping category), OR
 *   - sourceType = 'MANUAL' (legacy rows created before the category stamp).
 * Rows are summed only when they carry a CASH_IN/CASH_OUT type; anything else
 * is ignored (never guessed, never included).
 *
 * `opts.month` narrows to one calendar month; `opts.asOf` narrows to dates
 * on/before a cutoff (ISO string comparison is safe for zero-padded dates).
 * When `opts.withDetail` is set, matching rows are also returned chronologically
 * in `rows` so the UI can render the actual deposit/withdrawal records.
 */
export function buildCashSummary(
  rows: Array<{
    transactionId: string;
    type: string;
    sourceType: string;
    category: string | null;
    transactionDate: string;
    amountThb: string | null;
    currency: string;
    amountForeign: string;
  }>,
  opts: CashSummaryOptions = {}
): CashSummary {
  const byMonth = new Map<string, { cashIn: Decimal; cashOut: Decimal }>();
  const detail: CashSummaryDetailRow[] = [];

  const touch = (month: string) => {
    if (!byMonth.has(month)) byMonth.set(month, { cashIn: new Decimal(0), cashOut: new Decimal(0) });
  };

  for (const r of rows) {
    if (r.category === "asset") continue; // FX transfers are never external capital.
    if (r.sourceType !== "MANUAL" && r.category !== "equity") continue;
    if (r.type !== "CASH_IN" && r.type !== "CASH_OUT") continue;
    const month = r.transactionDate.slice(0, 7);
    if (opts.month && month !== opts.month) continue;
    if (opts.asOf && r.transactionDate > opts.asOf) continue;
    const raw = r.amountThb;
    if (raw === null || raw.trim() === "" || !isFinite(Number(raw))) continue;
    const amount = new Decimal(raw);
    touch(month);
    const bucket = byMonth.get(month)!;
    if (r.type === "CASH_IN") bucket.cashIn = bucket.cashIn.plus(amount);
    else bucket.cashOut = bucket.cashOut.plus(amount);
    if (opts.withDetail) {
      detail.push({
        transactionId: r.transactionId,
        transactionDate: r.transactionDate,
        type: r.type === "CASH_IN" ? "CASH_IN" : "CASH_OUT",
        sourceType: r.sourceType === "MANUAL" ? "MANUAL" : "AI_PARSED",
        category: r.category,
        currency: r.currency,
        amountForeign: r.amountForeign,
        amountThb: raw,
      });
    }
  }

  detail.sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));

  const months = [...byMonth.entries()]
    .map(([month, b]) => ({
      month,
      cashInThb: b.cashIn.toString(),
      cashOutThb: b.cashOut.toString(),
      netThb: b.cashIn.minus(b.cashOut).toString(),
    }))
    .sort((a, b) => b.month.localeCompare(a.month));

  const totalCashIn = months.reduce((sum, m) => sum.plus(m.cashInThb), new Decimal(0));
  const totalCashOut = months.reduce((sum, m) => sum.plus(m.cashOutThb), new Decimal(0));

  const view: CashSummary["view"] = opts.month
    ? "month"
    : opts.asOf
      ? "asOf"
      : "all";

  return {
    view,
    ...(opts.withDetail ? { rows: detail } : {}),
    months,
    totalCashInThb: totalCashIn.toString(),
    totalCashOutThb: totalCashOut.toString(),
    totalNetThb: totalCashIn.minus(totalCashOut).toString(),
    exchanges: [],
    exchangeTotals: [],
    exchangeDirectionTotals: emptyExchangeDirectionTotals(),
  };
}

/** Zeroed direction totals — the honest default when no exchange rows exist. */
export function emptyExchangeDirectionTotals(): CashExchangeDirectionTotals {
  return {
    intoThbTotal: "0",
    intoThbCount: 0,
    outOfThbTotal: "0",
    outOfThbCount: 0,
    netThb: "0",
    moreInThanOut: false,
  };
}

/**
 * Pure aggregator (DB-free, Decimal) comparing the two exchange directions in
 * THB: how much was exchanged BACK into THB (toCurrency === "THB") versus how
 * much was exchanged OUT of THB (fromCurrency === "THB"). Both sides are
 * summed with `amountThb` so the comparison is a real THB net, matching the
 * statement's own recorded values — never a guessed re-conversion.
 *
 * Honesty rules:
 *   - a row needs a non-null amountThb to contribute to its side;
 *   - the OUT side additionally requires a non-null fromCurrency === "THB"
 *     (legacy rows without from-data are simply not counted — never assumed);
 *   - the IN side requires toCurrency === "THB".
 * Applies the same month/asOf scope as `buildCashSummary`/`buildCashExchangeRows`.
 */
export function buildExchangeDirectionTotals(
  rows: Array<{
    transactionDate: string;
    currency: string | null;
    amountThb: string | null;
    exchangeFromCurrency: string | null;
  }>,
  opts: CashSummaryOptions = {}
): CashExchangeDirectionTotals {
  let into = new Decimal(0);
  let intoCount = 0;
  let out = new Decimal(0);
  let outCount = 0;

  for (const r of rows) {
    if (opts.month && r.transactionDate.slice(0, 7) !== opts.month) continue;
    if (opts.asOf && r.transactionDate > opts.asOf) continue;
    const amount = decimalAmount(r.amountThb);
    if (!amount || !amount.gt(0)) continue;

    const toCurrency = (r.currency ?? "").trim().toUpperCase();
    const fromCurrency = (r.exchangeFromCurrency ?? "").trim().toUpperCase();

    if (toCurrency === "THB") {
      into = into.plus(new Decimal(amount));
      intoCount += 1;
    } else if (fromCurrency === "THB") {
      // Legacy rows (fromCurrency null) are NOT counted on the out side.
      out = out.plus(new Decimal(amount));
      outCount += 1;
    }
  }

  const netThb = into.minus(out);
  return {
    intoThbTotal: into.toString(),
    intoThbCount: intoCount,
    outOfThbTotal: out.toString(),
    outOfThbCount: outCount,
    netThb: netThb.toString(),
    moreInThanOut: netThb.gt(0),
  };
}

/**
 * Pure aggregator (DB-free, Decimal) for currency-exchange rows. Takes the raw
 * exchange-record shape (as read from the journal) and builds the display rows
 * plus per-currency totals of the received side. Applies the SAME
 * month/asOf scope as `buildCashSummary` so month/cutoff views stay consistent.
 * Numbers are summed only when they parse; anything unreadable is left as its
 * raw value (never guessed).
 */
export function buildCashExchangeRows(
  rows: Array<{
    transactionId: string;
    transactionDate: string;
    currency: string | null;
    amount: string | null;
    amountThb: string | null;
    exchangeFromCurrency: string | null;
    exchangeFromAmount: string | null;
    exchangeRate: string | null;
  }>,
  opts: CashSummaryOptions = {}
): {
  exchanges: CashSummaryExchangeRow[];
  exchangeTotals: CashSummaryExchangeTotal[];
  exchangeDirectionTotals: CashExchangeDirectionTotals;
} {
  const byCurrency = new Map<string, { foreign: Decimal; thb: Decimal }>();

  const exchanges: CashSummaryExchangeRow[] = [];
  for (const r of rows) {
    if (opts.month && r.transactionDate.slice(0, 7) !== opts.month) continue;
    if (opts.asOf && r.transactionDate > opts.asOf) continue;
    const t = (c: string | null) => (c === null || c.trim() === "" ? null : c.trim().toUpperCase());
    const toCurrency = t(r.currency);
    const toAmount = r.amount;
    const amountThb = r.amountThb;
    exchanges.push({
      transactionId: r.transactionId,
      transactionDate: r.transactionDate,
      fromCurrency: t(r.exchangeFromCurrency),
      fromAmount: r.exchangeFromAmount,
      toCurrency,
      toAmount,
      rate: r.exchangeRate,
      amountThb,
    });
    if (toCurrency) {
      const foreign = decimalAmount(toAmount);
      const thb = decimalAmount(amountThb);
      const bucket = byCurrency.get(toCurrency) ?? { foreign: new Decimal(0), thb: new Decimal(0) };
      if (foreign) bucket.foreign = bucket.foreign.plus(foreign);
      if (thb) bucket.thb = bucket.thb.plus(thb);
      byCurrency.set(toCurrency, bucket);
    }
  }

  exchanges.sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));

  const exchangeTotals = [...byCurrency.entries()]
    .map(([currency, b]) => ({
      currency,
      totalForeign: b.foreign.toString(),
      totalThb: b.thb.toString(),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  const exchangeDirectionTotals = buildExchangeDirectionTotals(rows, opts);

  return { exchanges, exchangeTotals, exchangeDirectionTotals };
}

/**
 * Equity-only cash in/out summary for a user (server-authoritative THB values).
 * `opts` narrows the scope the same way `buildCashSummary` does.
 *
 * Journal as SSOT: the rows come from the journal (every Capital_Transactions-
 * mirrored entry, migration 0020), so manual cash rows journaled by the POST
 * handler and statement deposits/withdrawals share one source of truth.
 */
export async function getCashSummary(
  userId: string,
  opts: CashSummaryOptions = {}
): Promise<CashSummary> {
  const entries = await listCashSummaryRows(userId);
  const rows = entries.map((e) => {
    const r = journalEntryToCapitalRow(e);
    return {
      transactionId: r.transactionId,
      type: r.type ?? "",
      sourceType: r.sourceType,
      category: r.category,
      transactionDate: r.transactionDate,
      currency: r.currency ?? "",
      amountForeign: r.amountForeign ?? "",
      amountThb: r.amountThb,
    };
  });

  const exchangeEntries = await listFxConversionRows(userId);
  const { exchanges, exchangeTotals, exchangeDirectionTotals } = buildCashExchangeRows(
    exchangeEntries.map((e) => ({
      transactionId: e.sourceTransactionId ?? "",
      transactionDate: e.entryDate,
      currency: e.currency,
      amount: e.amount,
      amountThb: e.amountThb,
      exchangeFromCurrency: e.exchangeFromCurrency,
      exchangeFromAmount: e.exchangeFromAmount,
      exchangeRate: e.exchangeRate,
    })),
    opts
  );

  return { ...buildCashSummary(rows, opts), exchanges, exchangeTotals, exchangeDirectionTotals };
}
