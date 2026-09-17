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
//   expense (positive) -> Dr fee/WHT expense / Cr broker-cash
//   expense (negative, rebate) -> Dr broker-cash / Cr fee/WHT expense (contra-expense,
//                         leg amounts positive, magnitude from the signed expense row)
//   asset + BUY        -> Dr investments (PRINCIPAL = quantity x unitPrice via
//                         Decimal, fees excluded, matching the avg-cost basis
//                         so a full liquidation drains the asset to zero) / Dr
//                         fee expense (fee = net - principal, derived; a rebate
//                         credits the fee account) / Cr broker-cash (net, the
//                         authoritative broker figure). If quantity x unitPrice
//                         cannot yield a parseable positive principal the row is
//                         SKIPPED — the net is NEVER capitalized into the asset
//                         (that would bake fees into cost basis).
//   asset + SELL       -> Dr broker-cash (net proceeds) / Cr investments (cost basis) +
//                         gain -> Cr gains income | loss -> Dr losses expense.
//                         SELL FEE POLICY: realizedGainLoss = net proceeds -
//                         costBasis. The SELL fee is ALREADY netted inside the
//                         proceeds (broker net), so it is NEVER subtracted again
//                         and NEVER posted as a separate expense line — doing
//                         either would double-count it.
//   asset + SELL (no basis) -> Dr broker-cash / Cr investments at proceeds (no gain split)
//   income (dividend/interest) -> Dr broker-cash / Cr income account (gross)
//   expense (WHT)               -> Dr expense account / Cr broker-cash
//   expense (fee/VAT rows, isMonthlyFeeAggregate) -> tri-state SKIP rule:
//                         TRUE (parser monthly aggregate) and NULL (legacy /
//                         unknown pre-0027 provenance) are BOTH SKIPPED with
//                         zero lines; only FALSE (confirmed standalone fee)
//                         posts once. TRUE rows aggregate the month's
//                         commission/VAT — already in the per-trade postings
//                         (BUY fee leg / SELL net proceeds), so posting again
//                         would double-count. NULL is UNKNOWN: the historical
//                         row cannot be proved to be a monthly aggregate OR a
//                         genuine standalone fee, so posting it risks
//                         double-counting — it stays SKIPPED until the user
//                         deletes + re-imports the statement to re-run the
//                         parser for a deterministic TRUE/FALSE. The rule keys
//                         on the provenance flag, NOT a section-name match.
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
    // Verbatim: NEVER default a missing rate to 1. For THB the validator pins
    // the rate to 1 internally; for a non-THB row without a resolved rate this
    // stays null and the entry is refused before any line is built
    // (see postCapitalRow). Defaulting to 1 here would fabricate a 1:1 rate and
    // silently post a foreign amount as if it were THB.
    fxRateEffective: row.fxRateEffective ?? null,
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
    isMonthlyFeeAggregate:
    row.isMonthlyFeeAggregate == null ? null : row.isMonthlyFeeAggregate === true,
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

  // R3 guard: a non-THB row whose effective FX rate is unknown has no valid THB
  // value. It must NOT be double-entry posted - posting it would either invent a
  // 1:1 rate or an unbalanced entry. The row is still recorded in the journal as
  // a SKIPPED entry (foreign amount/currency preserved, no lines).
  if (row.currency !== "THB") {
    const eff = row.fxRateEffective;
    if (eff == null || !(Number(eff) > 0)) {
      return {
        ok: false,
        reason:
          "no effective FX rate for non-THB row (THB value unknown) - not posted",
      };
    }
  }

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
      // R4 (finalized): the investment is debited by the PRINCIPAL ONLY —
      // quantity x unitPrice (Decimal), fees excluded — so it matches the
      // Webull avg-cost basis and a full liquidation drains the asset to zero.
      // The fee is recognized in the SAME entry: fee = net − principal
      // (derived, never invented), so the entry always balances and a negative
      // residual (broker rebate) credits the fee account instead of debiting it.
      //
      // Do NOT fall back to capitalizing the net amount as the asset value. That
      // would bake the fees into the cost basis and break the running average.
      // If quantity x unitPrice cannot be derived (missing/non-finite/non-positive),
      // the row is NOT posted (SKIPPED): the amount stays recorded, no line is
      // fabricated, and the caller records it as a non-computable buy.
      const net = new Decimal(amount);
      const qtyRaw = row.quantity;
      const priceRaw = row.unitPrice;
      const qty = qtyRaw != null && qtyRaw.trim() !== "" ? new Decimal(qtyRaw) : null;
      const price = priceRaw != null && priceRaw.trim() !== "" ? new Decimal(priceRaw) : null;
      const principal =
        qty && price && qty.isFinite() && price.isFinite() && qty.gt(0) && price.gt(0)
          ? qty.mul(price)
          : null;
      if (principal == null) {
        return {
          ok: false,
          reason:
            "BUY without a parseable positive principal (quantity x unitPrice) - not posted (net would wrongly capitalize the fee)",
        };
      }
      const fee = net.minus(principal);
      const lines: JournalLineInput[] = [
        leg(INVEST_STOCKS, "debit", principal.toFixed(2), row),
        leg(cash, "credit", amount, row),
      ];
      if (!fee.isZero()) {
        if (fee.gt(0)) {
          lines.push(leg(FEE_EXPENSE, "debit", fee.toFixed(2), row));
        } else {
          lines.push(leg(FEE_EXPENSE, "credit", fee.negated().toFixed(2), row));
        }
      }
      return {
        ok: true,
        note: "buy (principal + fee split)",
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
    // R4 fees: monthly fee/VAT summary rows flagged by the parser
    // (isMonthlyFeeAggregate) aggregate every trade's commission and VAT for the
    // whole month PER CURRENCY. Those fees are ALREADY in the per-trade
    // postings (the BUY fee leg and the SELL netted proceeds), so posting the
    // aggregate again would double-count the fee AND charge broker cash twice.
    // Record the row as SKIPPED — amounts preserved for the archive, never
    // posted to GL.
    //
    // The skip keys on the DETERMINISTIC parser provenance flag, NOT a
    // section-name match: a genuine standalone broker fee (same fee section
    // label, flag FALSE) is NOT skipped and posts as a real expense.
    //
    // TRI-STATE semantics (migration 0027):
    //   TRUE  -> the row is a parser monthly aggregate: SKIPPED (no lines).
    //   FALSE -> confirmed standalone fee: posted once (below).
    //   NULL  -> legacy / unknown pre-0027 provenance: the parser emitted an
    //            IDENTICAL persisted shape for aggregates AND genuine standalone
    //            fees, so we cannot prove which this is. Posting it risks
    //            double-counting the fee, so it is SKIPPED (no lines) with an
    //            explicit reason. The flag is NEVER fabricated into a confirmed
    //            false — every read/rebuild keeps the stored null so the
    //            provenance stays visibly unknown. Delete + re-import of the
    //            original statement is the ONLY supported way to obtain a
    //            deterministic TRUE/FALSE for a legacy row.
    if (row.isMonthlyFeeAggregate === true) {
      return {
        ok: false,
        reason:
          "monthly fee/VAT summary row - fees already in the trade postings (BUY fee leg / SELL net proceeds)",
      };
    }
    if (row.isMonthlyFeeAggregate == null) {
      return {
        ok: false,
        reason:
          "legacy fee provenance unknown - re-import required for deterministic classification",
      };
    }
    // R4 negative-fee/rebate: a NEGATIVE standalone expense amount is a broker
    // rebate returning money to the account (the pipeline preserves the parser
    // sign for expense rows). Post it as the contra-expense — Dr cash |amount|
    // / Cr fee |amount| — NOT as a fee debit (that would post an expense for
    // money received). Leg amounts stay POSITIVE because validateJournalEntry
    // and the journal_entry_lines debit/credit CHECKs forbid non-positive
    // line amounts. A positive amount keeps the regular Dr fee / Cr cash.
    const signed = new Decimal(amount);
    const isRebate = signed.isNegative();
    const magnitude = signed.abs().toFixed(2);
    return {
      ok: true,
      note: isRebate ? "expense rebate (contra-expense)" : "expense",
      entry: {
        entryDate: row.transactionDate,
        description: descriptionFor(row),
        sourceType: "STATEMENT",
        sourceDocumentId: row.sourceDocumentId,
        sourceTransactionId: row.transactionId,
        lines: isRebate
          ? [
              leg(cash, "debit", magnitude, row),
              leg(expenseAccountFor(row), "credit", magnitude, row),
            ]
          : [
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