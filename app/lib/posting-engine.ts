// Statement -> journal posting engine (pure, DB-free).
//
// Maps a persisted Capital_Transactions row (parsed + validated by the
// statement pipeline, incl. its `category` + `section` labels) into a
// double-entry journal entry against the DEFAULT chart of accounts for foreign
// investment. Every produced entry is then run through
// validateJournalEntry (the pure invariant checker) before it is persisted —
// this module never fabricates amounts; it only re-splits the authoritative
// figures the pipeline already computed.
//
// Posting decisions (default chart of accounts, USD broker + THB reporting):
//   equity + CASH_IN   -> Dr broker-cash  / Cr owner-capital
//   equity + CASH_OUT  -> Dr owner-capital / Cr broker-cash
//   asset + BUY        -> Dr investments (net incl. fees) / Cr broker-cash   (fees capitalized)
//   asset + SELL       -> Dr broker-cash (net proceeds) / Cr investments (cost basis) +
//                         gain -> Cr gains income | loss -> Dr losses expense
//   asset + SELL (no basis) -> Dr broker-cash / Cr investments at proceeds (no gain split)
//   income (dividend/interest) -> Dr broker-cash / Cr income account (gross)
//   expense (fees/VAT/WHT)     -> Dr expense account / Cr broker-cash
//
// Currency-exchange-only rows (category "asset", no side) are NOT auto-posted —
// they would break the agreed per-currency balance rule inside one entry. With
// journal-as-SSOT they are instead recorded as a SKIPPED journal entry (full
// trade detail, zero lines) so every imported row is still present in the journal.
import type { ValidatedCapitalRow } from "./statement-pipeline";
import { validateJournalEntry } from "./general-ledger";
import type {
  JournalEntryInput,
  JournalLineInput,
  JournalTradeDetail,
  PostingState,
} from "./general-ledger";
import { Decimal } from "decimal.js";

Decimal.set({ precision: 40 });

const CASH_THB = "1010";
const CASH_USD = "1020";
const INVEST_STOCKS = "1110";
const EQUITY_CAPITAL = "3010";
const GAIN_INCOME = "4020";
const DIVIDEND_INCOME = "4010";
const INTEREST_INCOME = "4030";
const FEE_EXPENSE = "5010";
const WHT_EXPENSE = "5110";
const LOSS_EXPENSE = "5120";

export type CapitalPostingResult =
  | { ok: true; entry: JournalEntryInput; note?: string }
  | { ok: false; reason: string };

function cashAccountFor(currency: string): string {
  return currency === "THB" ? CASH_THB : CASH_USD;
}

function leg(
  accountId: string,
  side: "debit" | "credit",
  amount: string,
  row: Pick<
    ValidatedCapitalRow,
    "currency" | "fxRateEffective" | "fxRateStatement"
  >,
  memo?: string | null
): JournalLineInput {
  const base: JournalLineInput = {
    accountId,
    currency: row.currency,
    fxRateEffective: row.fxRateEffective ?? "1",
    fxRateStatement: row.fxRateStatement ?? null,
    memo: memo ?? null,
  };
  if (side === "debit") {
    base.debit = amount;
  } else {
    base.credit = amount;
  }
  return base;
}

/**
 * Entry description for a SELL: once a realized gain/loss is computable the
 * event is a capital gain/loss, so the ledger reads "กำไรจากการขาย …" /
 * "ขาดทุนจากการขาย …" instead of a bare "ขาย …". Non-computable SELLs (no
 * recorded basis) stay a plain "ขาย …" because the books knowingly carry no
 * gain/loss split for them. Shared with the existing-data cleanup script so
 * past and future postings use the identical wording.
 */
export function sellRowDescription(
  row: Pick<
    ValidatedCapitalRow,
    "symbol" | "quantity" | "unitPrice" | "currency" | "costBasis" | "realizedGainLoss"
  >
): string {
  const base = `ขาย ${row.symbol} ${row.quantity ?? ""} @ ${row.unitPrice ?? ""} ${row.currency}`.trim();
  if (row.costBasis == null || row.realizedGainLoss == null) return base;
  const g = Number(row.realizedGainLoss);
  if (!Number.isFinite(g)) return base;
  const prefix = g >= 0 ? "กำไรจากการขาย" : "ขาดทุนจากการขาย";
  return `${prefix} ${row.symbol} ${row.quantity ?? ""} @ ${row.unitPrice ?? ""} ${row.currency}`.trim();
}

function descriptionFor(row: ValidatedCapitalRow): string {
  if (row.side === "BUY") {
    return `ซื้อ ${row.symbol} ${row.quantity ?? ""} @ ${row.unitPrice ?? ""} ${row.currency}`.trim();
  }
  if (row.side === "SELL") {
    return sellRowDescription(row);
  }
  const section = row.section?.trim() ?? "";
  if (section) return section.replace(/[:\u2013\-_]+/g, " ").trim();
  if (row.category === "equity") return row.type === "CASH_IN" ? "ฝากเงินเข้าบัญชี" : "ถอนเงินจากบัญชี";
  if (row.category === "income") return "รายได้จากเงินลงทุน";
  if (row.category === "expense") return "ค่าใช้จ่าย";
  return "รายการจากงบ";
}

/** Public description builder (used for skipped/recorded rows too). */
export function statementDescriptionFor(row: ValidatedCapitalRow): string {
  return descriptionFor(row);
}

/**
 * Copy the source Statement row's trade detail onto a journal entry verbatim
 * (migration 0020). averageCost for a SELL is derived from the stored
 * basis ÷ quantity (the Webull average at sale time); never invented.
 */
export function journalDetailOf(row: ValidatedCapitalRow): JournalTradeDetail {
  let averageCost: string | null = null;
  if (row.side === "SELL" && row.costBasis != null && row.quantity != null) {
    const basis = new Decimal(row.costBasis);
    const qty = new Decimal(row.quantity);
    if (!basis.isFinite() || !qty.isFinite() || qty.equals(0)) {
      averageCost = null;
    } else {
      averageCost = basis
        .div(qty)
        .toFixed(6)
        .replace(/\.?0+$/, "");
    }
  }
  return {
    category: row.category ?? null,
    section: row.section ?? null,
    symbol: row.symbol ?? null,
    side: row.side ?? null,
    exchange: row.exchange ?? null,
    quantity: row.quantity ?? null,
    unitPrice: row.unitPrice ?? null,
    grossAmount: row.grossAmount ?? null,
    fees: row.fees ?? null,
    netAmount: row.netAmount ?? null,
    proceeds: row.proceeds ?? null,
    costBasis: row.costBasis ?? null,
    realizedGainLoss: row.realizedGainLoss ?? null,
    realizedGainLossThb: row.realizedGainLossThb ?? null,
    averageCost,
    currency: row.currency ?? null,
    amount: row.amountForeign ?? null,
    amountThb: row.amountThb ?? null,
    fxRateEffective: row.fxRateEffective ?? null,
    fxRateStatement: row.fxRateStatement ?? null,
    isFxConversion: row.category === "asset" && row.side == null,
    exchangeFromCurrency: row.exchangeFromCurrency ?? null,
    exchangeFromAmount: row.exchangeFromAmount ?? null,
    exchangeRate: row.exchangeRate ?? null,
  };
}

function incomeAccountFor(row: ValidatedCapitalRow): string {
  const section = (row.section ?? "").trim().toLowerCase();
  if (section.includes("ดอกเบี้ย") || section.includes("interest")) {
    return INTEREST_INCOME;
  }
  // Realized capital-gain income (กำไรจากการขายหุ้น) belongs in the gains
  // account, never mixed into dividends. (Defensive: the statement pipeline
  // already avoids double-posting these rows — see the income branch below.)
  if (section.includes("กำไรจากการขาย") || section.includes("capital gain")) {
    return GAIN_INCOME;
  }
  // Dividends (incl. per-symbol "เงินปันผล:xxx") or default income.
  return DIVIDEND_INCOME;
}

/**
 * The statement parser emits this section on a SECOND income row that mirrors
 * the realized gain/loss of a computable SELL. That gain/loss is ALREADY posted
 * by the SELL asset row itself (gain -> 4020, loss -> 5120); posting this row
 * too would double-count the amount and pollute the dividend account. Rows with
 * this exact section are therefore NOT posted (reported as skipped).
 */
function isCapitalGainIncomeRow(row: ValidatedCapitalRow): boolean {
  return (row.section ?? "").trim() === "กำไรจากการขายหุ้น";
}

/** Uppercase stock ticker for a dividend income row (from symbol or section). */
function dividendSymbolFor(row: ValidatedCapitalRow): string | null {
  if (row.symbol) return row.symbol.trim().toUpperCase() || null;
  const m = (row.section ?? "").match(/เงินปันผล\s*[:：]\s*([A-Za-z0-9._-]+)/i);
  return m ? m[1].toUpperCase() : null;
}

function expenseAccountFor(row: ValidatedCapitalRow): string {
  const section = (row.section ?? "").trim().toLowerCase();
  if (section.includes("ภาษี") || section.includes("wht")) {
    return WHT_EXPENSE;
  }
  return FEE_EXPENSE;
}

/** Category-aware rule dispatch. Pure. */
export function postCapitalRow(row: ValidatedCapitalRow): CapitalPostingResult {
  const category = (row.category ?? "").trim().toLowerCase();
  const amount = row.amountForeign;

  if (category === "equity") {
    const cash = cashAccountFor(row.currency);
    if (row.type === "CASH_IN") {
      return {
        ok: true,
        note: "equity deposit",
        entry: {
          entryDate: row.transactionDate,
          description: descriptionFor(row),
          sourceType: "STATEMENT",
          sourceDocumentId: row.sourceDocumentId,
          sourceTransactionId: row.transactionId,
          lines: [
            leg(cash, "debit", amount, row),
            leg(EQUITY_CAPITAL, "credit", amount, row),
          ],
        },
      };
    }
    return {
      ok: true,
      note: "equity withdrawal",
      entry: {
        entryDate: row.transactionDate,
        description: descriptionFor(row),
        sourceType: "STATEMENT",
        sourceDocumentId: row.sourceDocumentId,
        sourceTransactionId: row.transactionId,
        lines: [
          leg(EQUITY_CAPITAL, "debit", amount, row),
          leg(cash, "credit", amount, row),
        ],
      },
    };
  }

  if (category === "asset") {
    if (row.side === "BUY") {
      const cash = cashAccountFor(row.currency);
      return {
        ok: true,
        note: "buy (fees capitalized)",
        entry: {
          entryDate: row.transactionDate,
          description: descriptionFor(row),
          sourceType: "STATEMENT",
          sourceDocumentId: row.sourceDocumentId,
          sourceTransactionId: row.transactionId,
          lines: [
            leg(INVEST_STOCKS, "debit", amount, row),
            leg(cash, "credit", amount, row),
          ],
        },
      };
    }
    if (row.side === "SELL") {
      const cash = cashAccountFor(row.currency);
      const proceeds = amount; // net proceeds (authoritative)
      const costBasis = row.costBasis;
      const gain = row.realizedGainLoss;
      if (costBasis != null && gain != null) {
        const g = Number(gain);
        const lines: JournalLineInput[] = [
          leg(cash, "debit", proceeds, row),
          leg(INVEST_STOCKS, "credit", costBasis, row),
        ];
        if (g >= 0) {
          lines.push(leg(GAIN_INCOME, "credit", gain, row, row.symbol));
        } else {
          lines.push(leg(LOSS_EXPENSE, "debit", String(Math.abs(g)), row, row.symbol));
        }
        return {
          ok: true,
          note: "sell with realized gain/loss split",
          entry: {
            entryDate: row.transactionDate,
            description: descriptionFor(row),
            sourceType: "STATEMENT",
            sourceDocumentId: row.sourceDocumentId,
            sourceTransactionId: row.transactionId,
            lines,
          },
        };
      }
      // Honest non-computable SELL: reduce the investment at the sale proceeds
      // (no fabricated gain/loss). Keeps books balanced.
      return {
        ok: true,
        note: "sell without computable cost basis (no gain split)",
        entry: {
          entryDate: row.transactionDate,
          description: descriptionFor(row),
          sourceType: "STATEMENT",
          sourceDocumentId: row.sourceDocumentId,
          sourceTransactionId: row.transactionId,
          lines: [
            leg(cash, "debit", proceeds, row),
            leg(INVEST_STOCKS, "credit", proceeds, row),
          ],
        },
      };
    }
    // Currency-exchange-only rows: not auto-posted.
    return {
      ok: false,
      reason: "currency exchange rows are not auto-posted (per-currency balance rule)",
    };
  }

  if (category === "income") {
    // A SELL's realized gain/loss is already posted by its asset row (4020/5120).
    // The parser's duplicate "กำไรจากการขายหุ้น" income row must NOT be posted
    // again — it would double-count the gain and pollute the dividend account.
    if (isCapitalGainIncomeRow(row)) {
      return { ok: false, reason: "realized gain/loss already posted via the SELL row" };
    }
    const cash = cashAccountFor(row.currency);
    const incomeAccount = incomeAccountFor(row);
    const symbolMemo = incomeAccount === DIVIDEND_INCOME ? dividendSymbolFor(row) : null;
    return {
      ok: true,
      note: "income",
      entry: {
        entryDate: row.transactionDate,
        description: descriptionFor(row),
        sourceType: "STATEMENT",
        sourceDocumentId: row.sourceDocumentId,
        sourceTransactionId: row.transactionId,
        lines: [
          leg(cash, "debit", amount, row),
          leg(incomeAccount, "credit", amount, row, symbolMemo ?? undefined),
        ],
      },
    };
  }

  if (category === "expense") {
    const cash = cashAccountFor(row.currency);
    return {
      ok: true,
      note: "expense",
      entry: {
        entryDate: row.transactionDate,
        description: descriptionFor(row),
        sourceType: "STATEMENT",
        sourceDocumentId: row.sourceDocumentId,
        sourceTransactionId: row.transactionId,
        lines: [
          leg(expenseAccountFor(row), "debit", amount, row),
          leg(cash, "credit", amount, row),
        ],
      },
    };
  }

  return { ok: false, reason: `unknown category ${JSON.stringify(row.category)}` };
}

/**
 * Build the list of postable entries for a set of freshly imported rows.
 * Returns the entries that PASS validateJournalEntry plus the rows that were
 * skipped and why — the caller persists only the valid ones (and never fails
 * an import because of a posting issue). Every accepted entry carries the
 * source row's trade detail (journal-as-SSOT).
 */
export function buildStatementPostings(
  rows: ValidatedCapitalRow[]
): { entries: JournalEntryInput[]; postedCount: number; skipped: { transactionId: string; reason: string }[] } {
  const entries: JournalEntryInput[] = [];
  const skipped: { transactionId: string; reason: string }[] = [];
  for (const row of rows) {
    const result = postCapitalRow(row);
    if (!result.ok) {
      skipped.push({ transactionId: row.transactionId, reason: result.reason });
      continue;
    }
    const validated = validateJournalEntry({
      ...result.entry,
      detail: journalDetailOf(row),
    });
    if (!validated.ok) {
      skipped.push({
        transactionId: row.transactionId,
        reason: `invalid entry: ${validated.errors.join("; ")}`,
      });
      continue;
    }
    entries.push({
      ...result.entry,
      detail: journalDetailOf(row),
      postingState: "POSTED",
    });
  }
  return { entries, postedCount: entries.length, skipped };
}

export interface StatementJournalEntry {
  transactionId: string;
  /** Empty `lines` for SKIPPED entries (recorded but not double-entry). */
  entry: JournalEntryInput;
  postingState: PostingState;
  /** Present for SKIPPED entries; explains why no postings were made. */
  reason?: string;
}

/**
 * Full journal-coverage builder (journal-as-SSOT): EMITS AN ENTRY FOR EVERY
 * ROW. Rows that pass the posting decision + pure validation become POSTED
 * (lines); rows that cannot be double-entry posted (currency-exchange-only,
 * duplicate capital-gain income, validation failures) become SKIPPED entries
 * carrying the full trade detail and a skip reason but NO lines. This is what
 * the atomic import persists, so the journal is a complete record of the PDF.
 */
export function buildStatementJournalEntries(
  rows: ValidatedCapitalRow[]
): StatementJournalEntry[] {
  const out: StatementJournalEntry[] = [];
  for (const row of rows) {
    const detail = journalDetailOf(row);
    const result = postCapitalRow(row);
    if (!result.ok) {
      out.push({
        transactionId: row.transactionId,
        postingState: "SKIPPED",
        reason: result.reason,
        entry: {
          entryDate: row.transactionDate,
          description: descriptionFor(row),
          sourceType: "STATEMENT",
          sourceDocumentId: row.sourceDocumentId,
          sourceTransactionId: row.transactionId,
          lines: [],
          postingState: "SKIPPED",
          skipReason: result.reason,
          detail,
        },
      });
      continue;
    }
    const validated = validateJournalEntry({
      ...result.entry,
      detail,
    });
    if (!validated.ok) {
      const reason = `invalid entry: ${validated.errors.join("; ")}`;
      out.push({
        transactionId: row.transactionId,
        postingState: "SKIPPED",
        reason,
        entry: {
          entryDate: row.transactionDate,
          description: descriptionFor(row),
          sourceType: "STATEMENT",
          sourceDocumentId: row.sourceDocumentId,
          sourceTransactionId: row.transactionId,
          lines: [],
          postingState: "SKIPPED",
          skipReason: reason,
          detail,
        },
      });
      continue;
    }
    out.push({
      transactionId: row.transactionId,
      postingState: "POSTED",
      entry: {
        ...result.entry,
        detail,
        postingState: "POSTED",
      },
    });
  }
  return out;
}