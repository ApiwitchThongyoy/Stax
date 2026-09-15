// Double-entry general-ledger pure engine tests (DB-free).
//
// Covers the invariants that must NEVER regress:
//   - validateJournalEntry: per-currency balance, single-leg lines, amount/date/
//     description validation, THB derivation from fxRateEffective.
//   - trialBalance / incomeStatement / balanceSheet (incl. opening balances and
//     net income folding so A = L + E + NI).
//   - buildReversal (legs swapped).
//
// Run: npx tsx scripts/test-general-ledger.mts
import "./_load-env.mjs";

import {
  DEFAULT_CHART_OF_ACCOUNTS,
  balanceSheet,
  buildReversal,
  incomeStatement,
  summarizeLinesBySymbol,
  trialBalance,
  validateJournalEntry,
  type AccountMap,
  type JournalEntryInput,
} from "../app/lib/general-ledger";
import {
  buildStatementJournalEntries,
  buildStatementPostings,
  journalDetailOf,
  postCapitalRow,
  sellRowDescription,
} from "../app/lib/posting-engine";
import type { ValidatedCapitalRow } from "../app/lib/statement-pipeline";
import {
  journalEntryToCapitalRow,
  type CapitalJournalRecord,
} from "../app/lib/journal-ledger-read";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

const ACCOUNTS: AccountMap = {};
for (const a of DEFAULT_CHART_OF_ACCOUNTS) {
  ACCOUNTS[`acc-${a.code}`] = { code: a.code, name: a.name, type: a.type, currency: a.currency };
}

const CASH = "acc-1020"; // broker cash USD
const EQUITY = "acc-3010"; // owner capital USD
const INVEST = "acc-1110"; // investments USD
const GAIN = "acc-4010"; // test fixture id (code label resolved from CoA at runtime)
const DIV = "acc-4020"; // test fixture id (code label resolved from CoA at runtime)
const FEE = "acc-5010"; // fees expense USD
const LOSS = "acc-5120"; // losses expense USD

async function main() {
  console.log("=== JOURNAL ENTRY VALIDATION ===");

  const valid: JournalEntryInput = {
    entryDate: "2026-01-15",
    description: "ฝากเงินเข้าบัญชี",
    lines: [
      { accountId: CASH, currency: "USD", debit: "1000.00", fxRateEffective: "31.5" },
      { accountId: EQUITY, currency: "USD", credit: "1000.00", fxRateEffective: "31.5" },
    ],
  };
  const v1 = validateJournalEntry(valid);
  ok(v1.ok, "valid 2-line entry accepted");
  if (v1.ok) {
    ok(v1.entry.lines.length === 2, "two validated lines");
    ok(v1.entry.lines[0].side === "DEBIT", "first line is DEBIT");
    ok(v1.entry.lines[0].amountThb === "31500.00", "amountThb derived from fxRateEffective (1000 * 31.5)");
    ok(v1.entry.entryDate === "2026-01-15", "entryDate normalized");
    ok(v1.entry.sourceType === "MANUAL", "sourceType defaults to MANUAL");
  }

  const unbalanced = validateJournalEntry({
    entryDate: "2026-01-15",
    description: "ไม่สมดุล",
    lines: [
      { accountId: CASH, currency: "USD", debit: "100", fxRateEffective: "35" },
      { accountId: EQUITY, currency: "USD", credit: "90", fxRateEffective: "35" },
    ],
  });
  ok(!unbalanced.ok && unbalanced.errors.some((e) => e.includes("does not balance")), "unbalanced per-currency rejected");

  const multiCcyUnbalanced = validateJournalEntry({
    entryDate: "2026-01-15",
    description: "ข้ามสกุล",
    lines: [
      { accountId: CASH, currency: "USD", debit: "100", fxRateEffective: "35" },
      { accountId: EQUITY, currency: "THB", credit: "3000" },
    ],
  });
  ok(!multiCcyUnbalanced.ok && multiCcyUnbalanced.errors.some((e) => e.includes("USD")), "USD bucket unbalanced globally (per-currency rule)");

  const bothLegs = validateJournalEntry({
    entryDate: "2026-01-15",
    description: "สองด้าน",
    lines: [
      { accountId: CASH, currency: "USD", debit: "100", credit: "100" },
      { accountId: EQUITY, currency: "USD", credit: "100" },
    ],
  });
  ok(!bothLegs.ok && bothLegs.errors.some((e) => e.includes("exactly one of debit/credit")), "line with both legs rejected");

  const noLeg = validateJournalEntry({
    entryDate: "2026-01-15",
    description: "ไม่มีด้าน",
    lines: [
      { accountId: CASH, currency: "USD" },
      { accountId: EQUITY, currency: "USD" },
    ],
  });
  ok(!noLeg.ok && noLeg.errors.some((e) => e.includes("exactly one of debit/credit")), "line with no leg rejected");

  const negAmount = validateJournalEntry({
    entryDate: "2026-01-15",
    description: "ติดลบ",
    lines: [
      { accountId: CASH, currency: "USD", debit: "-5" },
      { accountId: EQUITY, currency: "USD", credit: "5" },
    ],
  });
  ok(!negAmount.ok && negAmount.errors.some((e) => e.includes("positive finite")), "negative amount rejected");

  const badDate = validateJournalEntry({
    entryDate: "2026/01/15",
    description: "วันที่ผิด",
    lines: [
      { accountId: CASH, currency: "USD", debit: "5" },
      { accountId: EQUITY, currency: "USD", credit: "5" },
    ],
  });
  ok(!badDate.ok && badDate.errors.some((e) => e.includes("ISO date")), "non-ISO date rejected");

  const badCcy = validateJournalEntry({
    entryDate: "2026-01-15",
    description: "สกุลเงินผิด",
    lines: [
      { accountId: CASH, currency: "US", debit: "5" },
      { accountId: EQUITY, currency: "US", credit: "5" },
    ],
  });
  ok(!badCcy.ok && badCcy.errors.some((e) => e.includes("invalid currency")), "invalid currency rejected");

  const emptyDesc = validateJournalEntry({
    entryDate: "2026-01-15",
    description: "   ",
    lines: [
      { accountId: CASH, currency: "USD", debit: "5" },
      { accountId: EQUITY, currency: "USD", credit: "5" },
    ],
  });
  ok(!emptyDesc.ok && emptyDesc.errors.some((e) => e.includes("description")), "empty description rejected");

  const singleLine = validateJournalEntry({
    entryDate: "2026-01-15",
    description: "เส้นเดียว",
    lines: [{ accountId: CASH, currency: "USD", debit: "5" }],
  });
  ok(!singleLine.ok && singleLine.errors.some((e) => e.includes("at least 2 lines")), "single-line entry rejected");

  const vThb = validateJournalEntry({
    entryDate: "2026-01-15",
    description: "รายการบาท",
    lines: [
      { accountId: "acc-1010", currency: "THB", debit: "3000" },
      { accountId: EQUITY, currency: "THB", credit: "3000" },
    ],
  });
  ok(vThb.ok, "all-THB entry accepted");
  if (vThb.ok) {
    ok(vThb.entry.lines[0].fxRateEffective === "1", "THB line defaults fxRateEffective to 1");
    ok(vThb.entry.lines[0].amountThb === "3000.00", "THB amountThb equals native amount");
  }

  const missingFx = validateJournalEntry({
    entryDate: "2026-01-15",
    description: "ขาดอัตรา",
    lines: [
      { accountId: CASH, currency: "USD", debit: "100" },
      { accountId: EQUITY, currency: "USD", credit: "100" },
    ],
  });
  ok(!missingFx.ok && missingFx.errors.some((e) => e.includes("fxRateEffective")), "non-THB line without fxRateEffective rejected (no silent 1:1 default)");

  const preciseFx = validateJournalEntry({
    entryDate: "2026-01-15",
    description: "ทศนิยมอัตรา",
    lines: [
      { accountId: CASH, currency: "USD", debit: "100", fxRateEffective: "31.425" },
      { accountId: EQUITY, currency: "USD", credit: "100", fxRateEffective: "31.425" },
    ],
  });
  ok(preciseFx.ok, "entry with 3-decimal FX accepted");
  if (preciseFx.ok) {
    ok(preciseFx.entry.lines[0].fxRateEffective === "31.425", "fxRateEffective kept at full precision (not rounded to 2dp)");
    ok(preciseFx.entry.lines[0].amountThb === "3142.50", "amountThb still rounded to 2dp");
  }

  console.log("=== TRIAL BALANCE ===");

  const tbLines = [
    { accountId: CASH, side: "DEBIT" as const, amount: "1000", currency: "USD" },
    { accountId: EQUITY, side: "CREDIT" as const, amount: "1000", currency: "USD" },
    { accountId: INVEST, side: "DEBIT" as const, amount: "400", currency: "USD" },
    { accountId: CASH, side: "CREDIT" as const, amount: "400", currency: "USD" },
  ];
  const tb = trialBalance(tbLines, ACCOUNTS);
  ok(tb.balanced, "trial balance balanced");
  ok(tb.totalDebit === "1400.00" && tb.totalCredit === "1400.00", "total debit == total credit (1400)");
  ok(tb.rows.length === 3, "three accounts in trial balance");
  const cashRow = tb.rows.find((r) => r.accountId === CASH);
  ok(cashRow !== undefined && cashRow.debit === "1000.00" && cashRow.credit === "400.00", "cash account grouped (1000 dr / 400 cr)");

  console.log("=== INCOME STATEMENT ===");

  const isLines = [
    { accountId: CASH, side: "DEBIT" as const, amount: "1200", currency: "USD" },
    { accountId: GAIN, side: "CREDIT" as const, amount: "1200", currency: "USD" },
    { accountId: FEE, side: "DEBIT" as const, amount: "200", currency: "USD" },
    { accountId: CASH, side: "CREDIT" as const, amount: "200", currency: "USD" },
  ];
  const is = incomeStatement(isLines, ACCOUNTS);
  ok(is.totalIncome === "1200.00", "total income 1200");
  ok(is.totalExpense === "200.00", "total expense 200");
  ok(is.netIncome === "1000.00", "net income 1000");

  console.log("=== BALANCE SHEET ===");

  // Deposit 1000 USD capital -> cash 1000; then a 1000 USD gain (cash income).
  const bsLines = [
    { accountId: CASH, side: "DEBIT" as const, amount: "2000" },
    { accountId: EQUITY, side: "CREDIT" as const, amount: "1000" },
    { accountId: GAIN, side: "CREDIT" as const, amount: "1000" },
  ];
  const bs = balanceSheet(bsLines, ACCOUNTS);
  ok(bs.totalAssets === "2000.00", "assets total 2000");
  ok(bs.totalEquityAndLiabilities === "2000.00", "L + E + NI = 2000");
  ok(bs.balanced, "balance sheet balanced");
  ok(bs.netIncome === "1000.00", "net income 1000 folded into equity");

  // Double-entry invariant: opening balances must balance on their own (a 500
  // cash asset must be matched by 500 opening owner capital), otherwise the
  // engine honestly reports `balanced: false`.
  const bsOpening = balanceSheet(bsLines, ACCOUNTS, { [CASH]: "500", [EQUITY]: "500" });
  ok(bsOpening.totalAssets === "2500.00", "opening balance applied to cash (500 + 2000)");
  ok(bsOpening.equity.some((r) => r.accountId === EQUITY && r.balance === "1500.00"), "opening owner capital folded into equity (500 opening + 1000 posted)");
  ok(bsOpening.balanced, "balance sheet with balanced opening balances balanced");

  console.log("=== THB-BASE PARALLELS (no cross-currency sums) ===");

  const tbMulti = trialBalance(
    [
      { accountId: CASH, side: "DEBIT" as const, amount: "1000", amountThb: "35000", currency: "USD" },
      { accountId: EQUITY, side: "CREDIT" as const, amount: "1000", amountThb: "35000", currency: "USD" },
      { accountId: "acc-1010", side: "DEBIT" as const, amount: "5000", amountThb: "5000", currency: "THB" },
      { accountId: "acc-3200", side: "CREDIT" as const, amount: "5000", amountThb: "5000", currency: "THB" },
    ],
    ACCOUNTS
  );
  ok(tbMulti.totalDebitThb === "40000.00" && tbMulti.totalCreditThb === "40000.00", "THB-base totals sum across currencies (40000)");
  ok(tbMulti.balancedThb, "THB-base trial balance balanced");
  ok(tbMulti.totalsByCurrency.length === 2, "two per-currency buckets (THB + USD)");
  const usdBucket = tbMulti.totalsByCurrency.find((t) => t.currency === "USD");
  ok(usdBucket !== undefined && usdBucket.debitThb === "35000.00", "USD bucket carries its THB-base parallel");
  const thbCashRow = tbMulti.rows.find((r) => r.accountId === "acc-1010");
  ok(thbCashRow !== undefined && thbCashRow.balanceThb === "5000.00", "row-level balanceThb present");

  const isMulti = incomeStatement(
    [
      { accountId: CASH, side: "DEBIT" as const, amount: "1200", amountThb: "42000", currency: "USD" },
      { accountId: GAIN, side: "CREDIT" as const, amount: "1200", amountThb: "42000", currency: "USD" },
      { accountId: FEE, side: "DEBIT" as const, amount: "200", amountThb: "200", currency: "THB" },
      { accountId: CASH, side: "CREDIT" as const, amount: "200", amountThb: "200", currency: "THB" },
    ],
    ACCOUNTS
  );
  ok(isMulti.totalIncomeThb === "42000.00" && isMulti.totalExpenseThb === "200.00", "THB-base income/expense totals");
  ok(isMulti.netIncomeThb === "41800.00", "THB-base net income 41800");
  ok(isMulti.totalsByCurrency.length === 2, "income per-currency buckets split by line currency");

  const bsMulti = balanceSheet(
    [
      { accountId: CASH, side: "DEBIT" as const, amount: "2000", amountThb: "70000" },
      { accountId: EQUITY, side: "CREDIT" as const, amount: "1000", amountThb: "35000" },
      { accountId: GAIN, side: "CREDIT" as const, amount: "1000", amountThb: "35000" },
    ],
    ACCOUNTS
  );
  ok(bsMulti.totalAssetsThb === "70000.00", "THB-base assets total 70000");
  ok(bsMulti.totalEquityAndLiabilitiesThb === "70000.00", "THB-base L + E + NI = 70000");
  ok(bsMulti.balancedThb, "THB-base balance sheet balanced");
  ok(bsMulti.netIncomeThb === "35000.00", "THB-base net income folded into equity");
  const bsCashRow = bsMulti.assets.find((r) => r.accountId === CASH);
  ok(bsCashRow !== undefined && bsCashRow.balanceThb === "70000.00", "row-level balanceThb on balance sheet");

  console.log("=== REVERSAL ===");

  const rev = buildReversal(v1.ok ? v1.entry : ({} as never));
  ok(rev.description.startsWith("กลับรายการ:"), "reversal description prefixed");
  ok(rev.lines[0].side === "CREDIT" && rev.lines[1].side === "DEBIT", "reversal legs swapped");
  const revValidated = validateJournalEntry({
    entryDate: rev.entryDate,
    description: rev.description,
    sourceType: "MANUAL",
    lines: rev.lines.map((l) => ({
      accountId: l.accountId,
      currency: l.currency,
      debit: l.side === "DEBIT" ? l.amount : null,
      credit: l.side === "CREDIT" ? l.amount : null,
      fxRateEffective: l.fxRateEffective,
    })),
  });
  ok(revValidated.ok, "reversal passes validation (balanced)");

  console.log("=== POSTING ENGINE / REVENUE CATEGORIES ===");

  const baseRow = (overrides: Partial<ValidatedCapitalRow>): ValidatedCapitalRow => ({
    transactionId: "tx-1",
    userId: "user-1",
    amountForeign: "100.00",
    currency: "USD",
    transactionDate: "2026-01-15",
    fxRateBot: null,
    amountThb: "3500.00",
    type: "CASH_IN",
    sourceType: "AI_PARSED",
    sourceDocumentId: "doc-1",
    category: "income",
    section: "เงินปันผล:nvda",
    symbol: null,
    side: null,
    quantity: null,
    unitPrice: null,
    grossAmount: null,
    fees: null,
    proceeds: null,
    costBasis: null,
    realizedGainLoss: null,
    realizedGainLossThb: null,
    fxRateStatement: "35",
    fxRateEffective: "35",
    netAmount: null,
    exchange: null,
    exchangeFromCurrency: null,
    exchangeFromAmount: null,
    exchangeRate: null,
    ...overrides,
  });

  // Dividend income (no symbol) -> dividend account, memo carries the ticker.
  const div = postCapitalRow(baseRow({}));
  ok(div.ok && div.entry.lines.length === 2, "dividend income posts two legs");
  if (div.ok) {
    const incomeLeg = div.entry.lines.find((l) => l.accountId === "4010");
    ok(!!incomeLeg && incomeLeg.credit === "100.00", "dividend credits 4010");
    ok(!!incomeLeg && incomeLeg.memo === "NVDA", "dividend credit memo = stock symbol (NVDA)");
    const cashLeg = div.entry.lines.find((l) => l.accountId === "1020");
    ok(!!cashLeg && cashLeg.debit === "100.00", "dividend debits broker cash");
  }

  // Interest income -> interest account (4030), no dividend memo.
  const interest = postCapitalRow(baseRow({ section: "ดอกเบี้ย", symbol: null }));
  ok(interest.ok && interest.entry.lines.some((l) => l.accountId === "4030" && l.credit === "100.00"), "interest credits 4030");
  if (interest.ok) {
    ok(interest.entry.lines.every((l) => !l.memo), "interest leg carries no dividend memo");
  }

  // The duplicate capital-gain income row ("กำไรจากการขายหุ้น") is NOT posted.
  const dupGainRow = baseRow({
    section: "กำไรจากการขายหุ้น",
    amountForeign: "50.00",
    symbol: "NVDA",
  });
  const skip = postCapitalRow(dupGainRow);
  ok(!skip.ok && skip.reason.includes("already posted"), "duplicate capital-gain income row is skipped (no double count)");

  const batch = buildStatementPostings([
    baseRow({}),
    baseRow({ transactionId: "tx-dup", section: "กำไรจากการขายหุ้น", amountForeign: "50.00" }),
  ]);
  ok(batch.entries.length === 1, "buildStatementPostings posts only the real dividend row");
  ok(batch.skipped.length === 1 && batch.skipped[0].transactionId === "tx-dup", "capital-gain duplicate reported as skipped");

  // Defensive: any income row whose section mentions capital gains goes to 4020.
  const gain = postCapitalRow(baseRow({ section: "กำไรจากการขายหลักทรัพย์", symbol: "NVDA" }));
  ok(gain.ok && gain.entry.lines.some((l) => l.accountId === "4020" && l.credit === "100.00"), "capital-gain section routes to 4020 (never dividends)");

  // ---- SELL entry wording + per-stock memo on the gain/loss leg -------------
  // The ledger should read "กำไรจากการขาย …" / "ขาดทุนจากการขาย …" instead of
  // a bare "ขาย …" whenever a realized gain/loss is computable.
  const sellGain = postCapitalRow(
    baseRow({
      category: "asset",
      side: "SELL",
      symbol: "NVDA",
      quantity: "2",
      unitPrice: "181.9",
      proceeds: "363.80",
      costBasis: "359.52",
      realizedGainLoss: "4.28",
    })
  );
  ok(sellGain.ok && sellGain.entry.description === "กำไรจากการขาย NVDA 2 @ 181.9 USD", "computable SELL gain entry description = กำไรจากการขาย …");
  if (sellGain.ok) {
    const gainLeg = sellGain.entry.lines.find((l) => l.accountId === "4020");
    ok(!!gainLeg && gainLeg.credit === "4.28", "computable SELL gain credits 4020");
    ok(!!gainLeg && gainLeg.memo === "NVDA", "4020 gain leg memo = stock symbol (NVDA)");
  }

  const sellLoss = postCapitalRow(
    baseRow({
      category: "asset",
      side: "SELL",
      symbol: "HIMS",
      quantity: "1",
      unitPrice: "16.84",
      proceeds: "16.84",
      costBasis: "19.19",
      realizedGainLoss: "-2.35",
    })
  );
  ok(sellLoss.ok && sellLoss.entry.description === "ขาดทุนจากการขาย HIMS 1 @ 16.84 USD", "computable SELL loss entry description = ขาดทุนจากการขาย …");
  if (sellLoss.ok) {
    const lossLeg = sellLoss.entry.lines.find((l) => l.accountId === "5120");
    ok(!!lossLeg && lossLeg.debit === "2.35", "computable SELL loss debits 5120");
    ok(!!lossLeg && lossLeg.memo === "HIMS", "5120 loss leg memo = stock symbol (HIMS)");
  }

  const sellNoBasis = postCapitalRow(
    baseRow({
      category: "asset",
      side: "SELL",
      symbol: "EOSE",
      quantity: "3",
      unitPrice: "10.4",
      proceeds: "31.2",
      costBasis: null,
      realizedGainLoss: null,
    })
  );
  ok(sellNoBasis.ok && sellNoBasis.entry.description === "ขาย EOSE 3 @ 10.4 USD", "non-computable SELL keeps the bare ขาย … wording");

  // ---- Per-stock memo summary (dividend "เงินปันผล" by ticker) ------------
  const summarized = summarizeLinesBySymbol([
    { currency: "USD", memo: "NVDA", debitAmount: null, creditAmount: "100", amountThb: "3500" },
    { currency: "USD", memo: "NVDA", debitAmount: null, creditAmount: "50", amountThb: "1720" },
    { currency: "USD", memo: "  goog ", debitAmount: null, creditAmount: "20", amountThb: "700" },
    { currency: "USD", memo: "NVDA", debitAmount: "30", creditAmount: null, amountThb: "1050" },
    { currency: "USD", memo: null, debitAmount: null, creditAmount: "9", amountThb: "315" }, // no stock key -> skipped
  ]);
  ok(summarized.length === 2, "summarizeLinesBySymbol groups only memo'd lines (skips no-symbol)");
  ok(summarized[0].symbol === "GOOG" && summarized[0].count === 1, "summary sorts symbols A-Z (GOOG first)");
  ok(summarized[0].currency === "USD" && summarized[0].amount === "20.00" && summarized[0].amountThb === "700.00", "single GOOG line net = its credit");
  const nvdaRow = summarized.find((s) => s.symbol === "NVDA");
  ok(!!nvdaRow && nvdaRow.count === 3 && nvdaRow.amount === "120.00", "NVDA nets credits 100+50 minus debit 30 = 120");
  ok(!!nvdaRow && nvdaRow.amountThb === "4170.00", "NVDA THB nets 3500+1720-1050 = 4170");
  ok(summarized.every((s) => s.symbol !== "(ไม่ระบุหุ้น)"), "no-symbol lines never appear in the stock breakdown");
  ok(summarized[summarized.length - 1].symbol === "NVDA", "summary last row is NVDA (after GOOG)");
  ok(summarized[summarized.length - 1].amountThb === "4170.00", "NVDA amountThb is the last sorted row");

  console.log("=== JOURNAL AS SSOT (EVERY ROW -> ONE JOURNAL ENTRY) ===");

  // buildStatementJournalEntries: every row in gets exactly one entry in return
  // (POSTED entries carry lines; SKIPPED entries carry no lines + a reason), so
  // the journal is a COMPLETE record of the import — nothing is ever dropped.
  const ssotRows = [
    // computable SELL (asset) -> POSTED with gain legs.
    baseRow({
      transactionId: "tx-sell",
      category: "asset",
      side: "SELL",
      symbol: "NVDA",
      quantity: "2",
      unitPrice: "181.9",
      amountForeign: "363.80",
      grossAmount: "363.80",
      fees: "0.10",
      netAmount: "363.70",
      proceeds: "363.80",
      costBasis: "359.52",
      realizedGainLoss: "4.28",
      realizedGainLossThb: "149.80",
    }),
    // duplicate capital-gain income row -> SKIPPED (already posted via SELL).
    baseRow({
      transactionId: "tx-gain-dup",
      section: "กำไรจากการขายหุ้น",
      amountForeign: "4.18",
    }),
    // currency-exchange-only asset row (no side) -> SKIPPED, FX-conversion flag.
    baseRow({
      transactionId: "tx-fx",
      type: "CASH_OUT",
      category: "asset",
      side: null,
      symbol: null,
      quantity: null,
      unitPrice: null,
      section: "สกุลเงิน",
    }),
  ];
  const built = buildStatementJournalEntries(ssotRows);
  ok(built.length === 3, "buildStatementJournalEntries returns one entry per row (3 rows -> 3 entries)");
  const txSell = built.find((e) => e.transactionId === "tx-sell");
  ok(
    !!txSell && txSell.postingState === "POSTED" && txSell.entry.lines.length === 3,
    "computable SELL -> POSTED entry with its posting lines"
  );
  const txGainDup = built.find((e) => e.transactionId === "tx-gain-dup");
  ok(
    !!txGainDup &&
      txGainDup.postingState === "SKIPPED" &&
      txGainDup.entry.lines.length === 0 &&
      !!txGainDup.reason,
    "duplicate capital-gain income row -> SKIPPED with no lines + a reason"
  );
  const txFx = built.find((e) => e.transactionId === "tx-fx");
  ok(
    !!txFx &&
      txFx.postingState === "SKIPPED" &&
      txFx.entry.detail?.isFxConversion === true &&
      txFx.entry.lines.length === 0,
    "currency-exchange-only row -> SKIPPED with isFxConversion flag and no lines"
  );

  // SKIPPED entries must pass validateJournalEntry unchanged (zero lines, full
  // detail preserved) — the atomic import stores what the plan produces.
  const skippedPlan = built.find((e) => e.transactionId === "tx-fx");
  if (skippedPlan) {
    const v = validateJournalEntry(skippedPlan.entry);
    ok(
      v.ok && v.entry.postingState === "SKIPPED" && v.entry.lines.length === 0,
      "SKIPPED entry passes validateJournalEntry (zero lines allowed, detail kept)"
    );
    if (v.ok) {
      ok(
        v.entry.detail.symbol === skippedPlan.entry.detail?.symbol &&
          v.entry.detail.amountThb === "3500.00",
        "SKIPPED validate keeps the verbatim trade detail"
      );
    }
  }

  // POSTED entries carry the full import-row detail verbatim.
  const validatedTxSell = txSell ? validateJournalEntry(txSell.entry) : null;
  if (validatedTxSell?.ok) {
    const d = validatedTxSell.entry.detail;
    ok(
      d.symbol === "NVDA" && d.side === "SELL" && d.quantity === "2" && d.unitPrice === "181.9",
      "POSTED detail carries symbol/side/qty/unitPrice"
    );
    ok(
      d.grossAmount === "363.80" &&
        d.fees === "0.10" &&
        d.netAmount === "363.70" &&
        d.currency === "USD" &&
        d.amount === "363.80" &&
        d.amountThb === "3500.00",
      "POSTED detail carries grossAmount/fees/netAmount/currency/amount/amountThb"
    );
    ok(
      d.realizedGainLoss === "4.28" &&
        d.realizedGainLossThb === "149.80" &&
        d.fxRateEffective === "35" &&
        d.isFxConversion === false,
      "POSTED detail carries realized gain/THB/fx + non-FX-conversion flag"
    );
  }

  // journalDetailOf derives the SELL average cost from basis ÷ quantity.
  const avg = journalDetailOf(
    baseRow({
      category: "asset",
      side: "SELL",
      symbol: "MSFT",
      quantity: "4",
      costBasis: "1000",
    })
  );
  ok(avg.averageCost === "250", "journalDetailOf SELL averageCost = basis ÷ qty (1000/4)");
  ok(avg.currency === "USD" && avg.fees === null, "journalDetailOf carries currency + null fees when absent");
  const fxDetail = journalDetailOf(
    baseRow({ category: "asset", side: null, section: "สกุลเงิน" })
  );
  ok(fxDetail.isFxConversion === true, "journalDetailOf flags a currency-exchange-only asset row");

  // buildStatementPostings (POSTED-only view) now attaches the same detail, so
  // the reversal / recompute paths and the upload response stay consistent.
  const postedWithDetail = buildStatementPostings([ssotRows[0]]);
  ok(
    postedWithDetail.entries.length === 1 &&
      postedWithDetail.entries[0].detail?.symbol === "NVDA",
    "buildStatementPostings entries carry trade detail"
  );

  // ---- Phase 2: journal-as-SSOT read mapper (pure, DB-free). ----
  const rec = (over: Partial<CapitalJournalRecord>): CapitalJournalRecord => ({
    sourceTransactionId: "tx-1",
    userId: "u-1",
    entryDate: "2026-07-15",
    sourceType: "MANUAL",
    sourceDocumentId: null,
    category: "equity",
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
    currency: "USD",
    amount: "1200.00",
    amountThb: "39600.00",
    fxRateEffective: "33",
    fxRateStatement: null,
    isFxConversion: false,
    exchangeFromCurrency: null,
    exchangeFromAmount: null,
    exchangeRate: null,
    postingState: "POSTED",
    skipReason: null,
    type: "CASH_IN",
    note: null,
    ...over,
  });

  const manualRow = journalEntryToCapitalRow(rec({}));
  ok(
    manualRow.transactionId === "tx-1" && manualRow.sourceType === "MANUAL",
    "mapper: manual entry keeps id + MANUAL sourceType"
  );
  ok(
    manualRow.type === "CASH_IN" &&
      manualRow.amountForeign === "1200.00" &&
      manualRow.amountThb === "39600.00",
    "mapper: manual row carries type + foreign + THB amounts"
  );
  ok(
    manualRow.transactionDate === "2026-07-15" &&
      manualRow.category === "equity" &&
      manualRow.fxRateEffective === "33",
    "mapper: manual row carries date + equity category + effective fx"
  );
  ok(
    manualRow.fxRateBot === null && manualRow.fxRateStatement === null,
    "mapper: fxRateBot/statement never invented for manual rows"
  );

  const sellRow = journalEntryToCapitalRow(
    rec({
      sourceType: "AI_PARSED",
      sourceDocumentId: "doc-9",
      category: "asset",
      section: "กำไรจากการขายหุ้น",
      symbol: "NVDA",
      side: "SELL",
      quantity: "2",
      unitPrice: "181.9",
      grossAmount: "363.80",
      fees: "0.10",
      netAmount: "363.70",
      proceeds: "363.70",
      costBasis: "359.52",
      realizedGainLoss: "4.28",
      realizedGainLossThb: "149.80",
      fxRateStatement: "35.00",
      fxRateEffective: "35",
      amount: "363.80",
      type: null,
    })
  );
  ok(
    sellRow.sourceType === "AI_PARSED" &&
      sellRow.sourceDocumentId === "doc-9" &&
      sellRow.symbol === "NVDA" &&
      sellRow.quantity === "2",
    "mapper: statement row maps AI_PARSED + document + trade legs"
  );
  ok(
    sellRow.realizedGainLoss === "4.28" &&
      sellRow.realizedGainLossThb === "149.80" &&
      sellRow.fxRateStatement === "35.00" &&
      sellRow.fxRateEffective === "35",
    "mapper: realized gain + THB + fx rates pass through verbatim"
  );
  ok(
    sellRow.type === null && sellRow.costBasis === "359.52",
    "mapper: SELL keeps null type + preserved basis"
  );

  console.log("================ SUMMARY ================");
  console.log(`PASS: ${passed}   FAIL: ${failed}`);
  if (failed > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});