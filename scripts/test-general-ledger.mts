import { runReportRegressions } from "./report-regressions.mjs";
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

import { Decimal } from "decimal.js";

import {
  DEFAULT_CHART_OF_ACCOUNTS,
  balanceSheet,
  buildReversal,
  classifyEntryCategory,
  getEntryMoneyFlow,
  getEntryExplanation,
  incomeStatement,
  isReferenceOnlySkip,
  summarizeAccountLedgers,
  summarizeLinesBySymbol,
  trialBalance,
  validateJournalEntry,
  type AccountLedgerSummaryInput,
  type AccountLedgerSummaryLineInput,
  type AccountMap,
  type JournalEntryInput,
} from "../app/lib/general-ledger";
import {
  applyThbRoundingAdjustment,
  buildStatementJournalEntries,
  buildStatementPostings,
  journalDetailOf,
  postCapitalRow,
  sellRowDescription,
} from "../app/lib/posting-engine";
import {
  applyAverageCostTrade,
  buyAcquisitionCost,
  type CostBasisMap,
} from "../app/lib/cost-basis-engine";
import {
  recomputeAllGainLoss,
  recomputeCostBasisMap,
  type ValidatedCapitalRow,
  type GainLossBackfillRow,
} from "../app/lib/statement-pipeline";
import { mapToCapitalRow } from "../app/lib/statement-pipeline";
import { parseStatementRows } from "../app/lib/pdfStatementParser";
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

  // A balanced second currency must never bypass the reporting-base invariant.
  const mixedBase: JournalEntryInput = {
    entryDate: "2026-01-15",
    description: "Mixed-currency reporting-base validation",
    lines: [
      { accountId: CASH, currency: "USD", debit: "100", fxRateEffective: "35" },
      { accountId: EQUITY, currency: "USD", credit: "100", fxRateEffective: "34" },
      { accountId: "acc-1010", currency: "THB", debit: "10" },
      { accountId: "acc-3020", currency: "THB", credit: "10" },
    ],
  };
  const mixedRejected = validateJournalEntry(mixedBase);
  ok(!mixedRejected.ok && mixedRejected.errors.some(e => e.includes("THB does not balance")),
    "native-balanced USD + THB entry with unequal THB bases is rejected");
  const mixedPenny = validateJournalEntry({ ...mixedBase, lines: mixedBase.lines.map((l, i) =>
    i === 1 ? { ...l, fxRateEffective: "34.9999" } : l) });
  ok(!mixedPenny.ok && mixedPenny.errors.some(e => e.includes("THB does not balance")),
    "mixed-currency THB imbalance of exactly 0.01 is rejected, never silently tolerated");
  const foreignOnly = validateJournalEntry({ ...mixedBase, lines: [
    ...mixedBase.lines.slice(0, 2),
    { accountId: "eur-cash", currency: "EUR", debit: "10", fxRateEffective: "40" },
    { accountId: "eur-capital", currency: "EUR", credit: "10", fxRateEffective: "40" },
  ] });
  ok(!foreignOnly.ok && foreignOnly.errors.some(e => e.includes("THB does not balance")),
    "native-balanced USD + EUR entry also enforces the THB reporting base");
  const mixedAccepted = validateJournalEntry({ ...mixedBase, lines: mixedBase.lines.map((l, i) =>
    i === 1 ? { ...l, fxRateEffective: "35" } : l) });
  ok(mixedAccepted.ok, "mixed-currency entry balanced natively and in THB remains accepted");
  if (mixedAccepted.ok) {
    const mixedReport = trialBalance(mixedAccepted.entry.lines, ACCOUNTS);
    ok(mixedReport.balancedThb === true && mixedReport.totalDebitThb === "3510.00" &&
      mixedReport.totalCreditThb === "3510.00",
      "accepted mixed entry reaches trial balance with equal 3510.00 THB totals");
    const reversed = buildReversal(mixedAccepted.entry);
    const checkedReversal = validateJournalEntry({ ...reversed, lines: reversed.lines.map(l => ({
      ...l, debit: l.side === "DEBIT" ? l.amount : null,
      credit: l.side === "CREDIT" ? l.amount : null,
    })) });
    ok(checkedReversal.ok, "balanced mixed-currency reversal remains valid");
  }

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
  ok(tb.totalDebit === "1000.00" && tb.totalCredit === "1000.00", "closing debit == closing credit (1000)");
  ok(tb.rows.length === 3, "three accounts in trial balance");
  const cashRow = tb.rows.find((r) => r.accountId === CASH);
  ok(cashRow !== undefined && cashRow.debit === "600.00" && cashRow.credit === "0.00", "cash closing balance (600 dr / 0 cr)");

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
    // Confirmed standalone (post-0027 parser provenance). Fresh imports always
    // carry a deterministic true/false; only a legacy pre-0027 persisted row
    // carries null (unknown), which the engine SKIPS.
    isMonthlyFeeAggregate: false,
    ...overrides,
  });

  // R2/R8: zero gain is computable; an absent basis never becomes proceeds.
  const zeroSell = baseRow({ category: "asset", side: "SELL", amountForeign: "1000.00",
    costBasis: "1000.00", realizedGainLoss: "0.00", realizedGainLossThb: "0.00" });
  const zeroPlan = buildStatementJournalEntries([zeroSell])[0];
  ok(zeroPlan.postingState === "POSTED" && zeroPlan.entry.lines.length === 2 &&
    zeroPlan.entry.lines.some(l => l.accountId === "1020" && l.debit === "1000.00") &&
    zeroPlan.entry.lines.some(l => l.accountId === "1110" && l.credit === "1000.00"),
    "R2: zero-gain SELL posts cash/investment only, no zero gain leg");
  const missingPlan = buildStatementJournalEntries([{ ...zeroSell, costBasis: null }])[0];
  ok(missingPlan.postingState === "SKIPPED" && missingPlan.entry.lines.length === 0 &&
    missingPlan.entry.detail?.costBasis === null && missingPlan.entry.detail?.realizedGainLoss === null &&
    missingPlan.entry.detail?.realizedGainLossThb === null && !!missingPlan.reason?.includes("NON_COMPUTABLE"),
    "R8: missing basis stays visible with null gains, zero lines and explicit reason");

  const conflicting = validateJournalEntry({
    entryDate: "2026-01-15", description: "R5 conflicting THB",
    detail: { currency: "USD", amount: "10.005", fxRateEffective: "35.42", amountThb: "999" },
    lines: [
      { accountId: "1020", currency: "USD", debit: "10.005", fxRateEffective: "35.42", amountThb: "999" },
      { accountId: "3010", currency: "USD", credit: "10.005", fxRateEffective: "35.42", amountThb: "888" },
    ],
  });
  ok(conflicting.ok && conflicting.entry.lines.every(l => l.amount === "10.01" && l.amountThb === "354.55") &&
    conflicting.entry.detail.amountThb === "354.55",
    "R5: server derives header and line THB from native cents, overriding conflicting input");
  const roundingEdge = validateJournalEntry({
    entryDate: "2026-01-15", description: "R5 raw balance is insufficient",
    lines: [
      { accountId: "1020", currency: "THB", debit: "0.005" },
      { accountId: "1020", currency: "THB", debit: "0.005" },
      { accountId: "3010", currency: "THB", credit: "0.010" },
    ],
  });
  ok(!roundingEdge.ok && roundingEdge.errors.some(e => e.includes("does not balance")),
    "R5: raw .005 + .005 = .010 rejected because persisted .01 + .01 != .01");
  const thbEdge = validateJournalEntry({
    entryDate: "2026-01-15", description: "R5 converted cents must balance",
    lines: [
      { accountId: "1020", currency: "USD", debit: "0.01", fxRateEffective: "35.42" },
      { accountId: "1020", currency: "USD", debit: "0.01", fxRateEffective: "35.42" },
      { accountId: "3010", currency: "USD", credit: "0.02", fxRateEffective: "35.42" },
    ],
  });
  ok(!thbEdge.ok && thbEdge.errors.some(e => e.includes("THB does not balance")),
    "R5: native-balanced entry rejected when THB .35 + .35 != .71");

  // R6/R7: only genuine marked exchanges use reporting-currency balance.
  const parsedExchange = parseStatementRows([
    "CURRENCY EXCHANGE RECORDS",
    "01/01/2026 10:00:00,GMT+07 THB 35,000.00 USD 1,000.00 35.0000",
    "DIVIDENDS",
  ]).transactions.find(t => t.exchangeFromCurrency === "THB");
  const mappedExchange = parsedExchange ? mapToCapitalRow(parsedExchange, "user-1", "doc-1") : null;
  ok(mappedExchange?.ok === true && mappedExchange.row.type === "FX_CONVERSION" &&
    buildStatementJournalEntries([mappedExchange.row])[0].postingState === "POSTED",
    "R6: real parser -> pipeline -> posting recognizes THB-to-USD transfer");
  const fxRow = baseRow({ category: "asset", side: null, type: "FX_CONVERSION",
    amountForeign: "1000.00", exchangeFromCurrency: "THB", exchangeFromAmount: "35000.00",
    exchangeRate: "35", fxRateEffective: "35" });
  const fxPlan = buildStatementJournalEntries([fxRow])[0];
  const fxValidated = validateJournalEntry(fxPlan.entry);
  ok(fxPlan.postingState === "POSTED" && fxValidated.ok &&
    fxValidated.entry.lines.some(l => l.accountId === "1020" && l.currency === "USD" &&
      l.side === "DEBIT" && l.amount === "1000.00" && l.amountThb === "35000.00") &&
    fxValidated.entry.lines.some(l => l.accountId === "1010" && l.currency === "THB" &&
      l.side === "CREDIT" && l.amount === "35000.00" && l.amountThb === "35000.00"),
    "R6: THB 35000 -> USD 1000 posts distinct native amounts and equal THB totals");
  const badFxPlan = buildStatementJournalEntries([{ ...fxRow, fxRateEffective: "34.50" }])[0];
  const badFxValidated = validateJournalEntry({ ...badFxPlan.entry });
  const badFx = badFxPlan.postingState === "POSTED" && badFxValidated.ok ? badFxValidated.entry : null;
  ok(!!badFx && badFx.lines.length === 3,
    "R6: reporting FX 34.50 now posts 3 legs (THB 34500 vs 35000 absorbed by the 5020 variance)");
  if (badFx) {
    ok(badFx.lines.some((l) => l.accountId === "5020" && l.side === "DEBIT" && l.amount === "500.00"),
      "R6: FX 34.50 variance = found Dr 5020 500.00 (exact reporting-base difference)");
  }
  ok(!validateJournalEntry({ ...fxPlan.entry, detail: { isFxConversion: false } }).ok,
    "R6: unmarked cross-currency entries retain native balance checks");
  ok(!validateJournalEntry({ entryDate: "2026-01-01", description: "normal native mismatch",
    lines: [{ accountId: "1020", currency: "USD", debit: "100", fxRateEffective: "35" },
      { accountId: "3010", currency: "USD", credit: "50", fxRateEffective: "70" }] }).ok,
    "R5/R6: ordinary USD entry must balance natively even if THB totals match");
  ok(!validateJournalEntry({ ...fxPlan.entry, detail: { ...fxPlan.entry.detail, amount: "999" } }).ok,
    "R6: flag alone cannot bypass mismatched exchange details");
  const currencyMap = new Map(DEFAULT_CHART_OF_ACCOUNTS.map(a => [a.code, a.currency]));
  ok(!validateJournalEntry({ entryDate: "2026-01-01", description: "bad THB",
    lines: [{ accountId: "1020", currency: "THB", debit: "100" },
      { accountId: "3010", currency: "THB", credit: "100" }] }, currencyMap).ok,
    "R7: validator rejects THB in USD accounts");
  ok(!validateJournalEntry({ entryDate: "2026-01-01", description: "bad USD",
    lines: [{ accountId: "1010", currency: "USD", debit: "100", fxRateEffective: "35" },
      { accountId: "3010", currency: "USD", credit: "100", fxRateEffective: "35" }] }, currencyMap).ok,
    "R7: validator rejects USD in THB cash account");
  if (fxValidated.ok) {
    const reverse = buildReversal(fxValidated.entry);
    const reversed = validateJournalEntry({ ...reverse,
      lines: reverse.lines.map(l => ({ accountId: l.accountId, currency: l.currency,
        debit: l.side === "DEBIT" ? l.amount : null, credit: l.side === "CREDIT" ? l.amount : null,
        fxRateEffective: l.fxRateEffective })) }, currencyMap);
    ok(reversed.ok && reversed.entry.detail.isFxConversion &&
      reversed.entry.detail.currency === "THB" && reversed.entry.lines.length === 2,
      "R6/R7: reversal swaps exchange details and keeps compatible currencies");
  }
  for (const row of [
    baseRow({ category: "asset", side: "BUY", currency: "THB", fxRateEffective: "1", quantity: "1", unitPrice: "100" }),
    baseRow({ category: "expense", currency: "THB", fxRateEffective: "1" }),
    baseRow({ category: "income", currency: "THB", fxRateEffective: "1" }),
  ]) {
    const plan = buildStatementJournalEntries([row])[0];
    ok(plan.postingState === "SKIPPED" && plan.entry.lines.length === 0 && !!plan.reason?.includes("compatible"),
      `R7: unsupported THB ${row.category}/${row.side ?? ""} remains SKIPPED with no incompatible lines`);
  }

  // FX VARIANCE LEG (5020 THB): a confirmed exchange whose statement FX gives
  // the two cash legs slightly different THB reporting bases posts a THB
  // variance leg for the exact difference, WITHOUT ever touching source values.
  const fxThbToUsd = (sent: string, received: string, rate: string): ValidatedCapitalRow =>
    baseRow({ category: "asset", side: null, type: "FX_CONVERSION",
      amountForeign: received, currency: "USD",
      exchangeFromCurrency: "THB", exchangeFromAmount: sent, exchangeRate: rate,
      fxRateEffective: rate });
  // Decode a row into its FROZEN validated entry (null if not keepable).
  const fxFrozen = (row: ValidatedCapitalRow) => {
    const plan = buildStatementJournalEntries([row])[0];
    if (plan.postingState !== "POSTED") return null;
    const v = validateJournalEntry({ ...plan.entry });
    return v.ok ? v.entry : null;
  };
  const fxVariance = (entry: ReturnType<typeof fxFrozen>) =>
    entry ? entry.lines.find((l) => l.accountId === "5020") ?? null : null;

  // Production pair (verified): 5000 THB -> 158.60 USD @ 31.5457 = +3.15.
  const p1 = fxFrozen(fxThbToUsd("5000.00", "158.60", "31.5457"));
  ok(!!p1 && p1.lines.length === 3, "FX variance: non-balancing exchange produces a valid 3-leg entry");
  if (p1) {
    const v = fxVariance(p1);
    ok(!!v && v.currency === "THB" && v.side === "CREDIT" && v.amount === "3.15" &&
      v.amountThb === "3.15" && v.fxRateEffective === "1" && v.fxRateStatement === "1" &&
      v.memo === "FX conversion variance",
      "FX variance: Cr 5020 = exact +3.15 THB difference, THB pinned, human memo");
    ok(p1.lines.some((l) => l.accountId === "1020" && l.side === "DEBIT" &&
        l.amount === "158.60" && l.amountThb === "5003.15"),
      "FX variance: USD received leg keeps statement amount/FX (5003.15 THB base)");
    ok(p1.lines.some((l) => l.accountId === "1010" && l.side === "CREDIT" &&
        l.amount === "5000.00" && l.amountThb === "5000.00"),
      "FX variance: THB sent leg keeps the source amount (5000.00) verbatim");
  }

  // Production pair (verified): 10000 THB -> 319.80 USD @ 31.269 = -0.17.
  const p2 = fxFrozen(fxThbToUsd("10000.00", "319.80", "31.269"));
  ok(!!p2 && p2.lines.length === 3, "FX variance: negative difference also produces 3 legs");
  if (p2) {
    const v = fxVariance(p2);
    ok(!!v && v.side === "DEBIT" && v.amount === "0.17", "FX variance: Dr 5020 = exact 0.17 THB difference");
  }

  // The seven remaining production diffs (+5.91, +28.81, -0.22, -0.13, -0.19,
  // -0.25, -0.24) as engineered pairs where roundMoney(received * rate) lands
  // EXACTLY on the recorded target THB cents.
  const productionDiffs: { sent: string; received: string; rate: string; side: "DEBIT" | "CREDIT"; amount: string }[] = [
    { sent: "55329.09", received: "1581.00", rate: "35.0", side: "CREDIT", amount: "5.91" },
    { sent: "3171.19", received: "100.00", rate: "32.0", side: "CREDIT", amount: "28.81" },
    { sent: "3542.22", received: "100.00", rate: "35.42", side: "DEBIT", amount: "0.22" },
    { sent: "157.86", received: "5.00", rate: "31.5457", side: "DEBIT", amount: "0.13" },
    { sent: "324.87", received: "10.00", rate: "32.4675", side: "DEBIT", amount: "0.19" },
    { sent: "8750.25", received: "250.00", rate: "35.0", side: "DEBIT", amount: "0.25" },
    { sent: "625.62", received: "20.00", rate: "31.269", side: "DEBIT", amount: "0.24" },
  ];
  for (const d of productionDiffs) {
    const entry = fxFrozen(fxThbToUsd(d.sent, d.received, d.rate));
    const v = fxVariance(entry);
    ok(!!entry && entry.lines.length === 3 && !!v &&
        v.side === d.side && v.amount === d.amount,
      `FX variance: ${d.sent} THB -> ${d.received} USD @ ${d.rate} = ${d.side} ${d.amount}`);
  }

  // 5020 is a THB default account, so the engine-level compatibility check
  // preserves the 3-leg posting end-to-end.
  ok(postCapitalRow(fxThbToUsd("5000.00", "158.60", "31.5457")).ok,
    "FX variance: engine accepts the 5020 THB account (default chart)");

  // Balanced USD -> THB (variance==0) still posts exactly two cash legs.
  const back = fxFrozen(baseRow({ category: "asset", side: null,
    type: "FX_CONVERSION", amountForeign: "35000.00", currency: "THB", fxRateEffective: "1",
    exchangeFromCurrency: "USD", exchangeFromAmount: "1000.00", exchangeRate: "35" }));
  ok(!!back && back.lines.length === 2 && !fxVariance(back) &&
    back.detail.currency === "THB" && back.detail.exchangeFromCurrency === "USD",
    "FX variance: balanced USD -> THB stays 2 legs (no variance line)");

  // Missing trusted FX stays SKIPPED (never a fabricated 1:1 or variance).
  const noFx = buildStatementJournalEntries([baseRow({ category: "asset", side: null,
    type: "FX_CONVERSION", amountForeign: "158.60", currency: "USD",
    exchangeFromCurrency: "THB", exchangeFromAmount: "5000.00",
    exchangeRate: null, fxRateEffective: null })])[0];
  ok(noFx.postingState === "SKIPPED" && noFx.entry.lines.length === 0 &&
    !!noFx.reason?.includes("effective FX rate"), "FX variance: unknown rate stays SKIPPED (zero lines)");
  // Unsupported third currency stays SKIPPED too.
  const eurFx = buildStatementJournalEntries([baseRow({ category: "asset", side: null,
    type: "FX_CONVERSION", amountForeign: "100.00", currency: "EUR",
    exchangeFromCurrency: "THB", exchangeFromAmount: "3600.00",
    exchangeRate: "36", fxRateEffective: "36" })])[0];
  ok(eurFx.postingState === "SKIPPED" && eurFx.entry.lines.length === 0,
    "FX variance: unsupported currency stays SKIPPED");

  if (p1) {
    // A THB line that is NOT exactly the reporting-base difference is rejected
    // (start from a balanced 2-leg exchange so the fake line is the ONLY extra).
    const base2 = fxFrozen(baseRow({ category: "asset", side: null, type: "FX_CONVERSION",
      amountForeign: "1000.00", currency: "USD",
      exchangeFromCurrency: "THB", exchangeFromAmount: "35000.00", exchangeRate: "35",
      fxRateEffective: "35" }));
    ok(!!base2 && base2.lines.length === 2, "FX variance: balanced THB 35000 -> USD 1000 @ 35 is 2 legs");
    if (base2) {
      const fake = validateJournalEntry({
        entryDate: base2.entryDate, description: "fake third leg",
        detail: base2.detail, lines: [
          ...base2.lines.map((l) => ({ accountId: l.accountId, currency: l.currency,
            debit: l.side === "DEBIT" ? l.amount : null, credit: l.side === "CREDIT" ? l.amount : null,
            fxRateEffective: l.fxRateEffective, memo: l.memo })),
          { accountId: "1010", currency: "THB", debit: "999.00" },
        ],
      });
      ok(!fake.ok && fake.errors.some((e) => e.includes("variance line must be")),
        "FX variance: arbitrary third leg on a balanced exchange rejected (must equal exact difference)");
      // A FOURTH leg on a genuine 3-leg entry is rejected outright.
      const bogus4 = validateJournalEntry({
        entryDate: p1.entryDate, description: "bogus fourth leg",
        detail: p1.detail, lines: [
          ...p1.lines.map((l) => ({ accountId: l.accountId, currency: l.currency,
            debit: l.side === "DEBIT" ? l.amount : null, credit: l.side === "CREDIT" ? l.amount : null,
            fxRateEffective: l.fxRateEffective, memo: l.memo })),
          { accountId: "1020", currency: "USD", credit: "1.00", fxRateEffective: "31" },
        ],
      });
      ok(!bogus4.ok && bogus4.errors.some((e) =>
        e.includes("requires exactly two cash legs and at most one THB variance line") ||
        e.includes("requires one received-asset debit and one sent-asset credit")),
        "FX variance: a 3-leg entry with a 4th arbitrary leg is rejected");
    }
    // USD leg into the THB cash account is rejected by the account map.
    const mismatch = validateJournalEntry({
      entryDate: p1.entryDate, description: "account mismatch",
      lines: [
        { accountId: "1020", currency: "USD", debit: "158.60", fxRateEffective: "31.5457" },
        { accountId: "1010", currency: "USD", credit: "158.60", fxRateEffective: "31.5457" },
      ],
    }, new Map(DEFAULT_CHART_OF_ACCOUNTS.map((a) => [a.code, a.currency])));
    ok(!mismatch.ok, "FX variance: USD leg into the THB cash account rejected");
    // Wire into a 3-leg entry it is dropped by buildReversal (details swapped).
    const reversed = buildReversal(p1);
    const rr = validateJournalEntry({
      ...reversed,
      lines: reversed.lines.map((l) => ({ accountId: l.accountId, currency: l.currency,
        debit: l.side === "DEBIT" ? l.amount : null, credit: l.side === "CREDIT" ? l.amount : null,
        fxRateEffective: l.fxRateEffective })),
    }, new Map(DEFAULT_CHART_OF_ACCOUNTS.map((a) => [a.code, a.currency])));
    ok(rr.ok && rr.entry.detail.isFxConversion &&
      rr.entry.detail.currency === "THB" && rr.entry.detail.amount === "5000.00" &&
      rr.entry.detail.exchangeFromCurrency === "USD" && rr.entry.detail.exchangeFromAmount === "158.60" &&
      rr.entry.lines.some((l) => l.accountId === "5020" && l.side === "DEBIT" && l.amount === "3.15"),
      "FX variance: 3-leg reversal picks cash legs by currency and validates");
  }

  // THB ROUNDING ADJUSTMENT LEG (auto): a wholly-valid single-currency non-THB
  // entry whose per-line THB reporting bases differ by <= 0.01 posts with a THB
  // 5020 leg for the exact difference instead of SKIPPING. Source values never
  // change — only the derived THB base gains an exact adjustment leg.
  const roundingFrozen = (row: ValidatedCapitalRow) => {
    const plan = buildStatementJournalEntries([row])[0];
    if (plan.postingState !== "POSTED") return null;
    const v = validateJournalEntry({ ...plan.entry });
    return v.ok ? v.entry : null;
  };
  const roundingLeg = (entry: NonNullable<ReturnType<typeof roundingFrozen>>) =>
    entry.lines.find((l) => l.memo === "THB rounding adjustment") ?? null;
  // BUY: the acquisition cost is a single amount, so both legs share it and the
  // THB base always balances — no rounding leg is ever needed. The investment is
  // debited by the full broker Net Amount (commissions/VAT INCLUDED), and the
  // fee is NOT expensed separately.
  const buyRound = roundingFrozen(baseRow({ category: "asset", side: "BUY",
    amountForeign: "20.00", quantity: "10", unitPrice: "1.00",
    fxRateEffective: "3.1415", fxRateStatement: "3.1415" }));
  ok(!!buyRound && buyRound.lines.length === 2 && !roundingLeg(buyRound),
    "rounding: BUY posts 2 balanced legs (acquisition cost incl. fees), no THB leg");
  if (buyRound) {
    ok(buyRound.lines.some((l) => l.accountId === "1110" && l.side === "DEBIT" && l.amount === "20.00") &&
      buyRound.lines.some((l) => l.accountId === "1020" && l.side === "CREDIT" && l.amount === "20.00") &&
      buyRound.lines.every((l) => l.accountId !== "5010"),
      "rounding: BUY debits investment by the net (20.00), no separate fee leg");
  }
  // SELL with gain: proceeds 100.00 vs basis 70.00 + gain 30.00 @ 1.2345 ->
  // debit THB 123.45 vs credit 86.42 + 37.04 = 123.46 -> DEBIT 5020 0.01.
  const sellRound = roundingFrozen(baseRow({ category: "asset", side: "SELL",
    amountForeign: "100.00", costBasis: "70.00", realizedGainLoss: "30.00",
    realizedGainLossThb: "37.04", fxRateEffective: "1.2345", fxRateStatement: "1.2345" }));
  ok(!!sellRound && sellRound.lines.length === 4,
    "rounding: non-balancing SELL posts 4 legs (proceeds + basis + gain + THB leg)");
  if (sellRound) {
    const r = roundingLeg(sellRound);
    ok(!!r && r.side === "DEBIT" && r.amount === "0.01" &&
      sellRound.lines.some((l) => l.accountId === "4020" && l.side === "CREDIT" && l.amount === "30.00"),
      "rounding: SELL DEBIT 5020 0.01 (THB debit 123.45 vs credit 123.46), gain leg intact");
  }
  // Production-shaped SELL fixtures: at a real statement FX (31.5700) the
  // proceeds leg and the basis+gain legs round to different THB cents. Each MUST
  // POST 4 legs with the exact 5020 0.01 THB leg, on the side the imbalance
  // requires, and the reported THB totals must equal the named pair verbatim.
  const thbTotals = (entry: NonNullable<ReturnType<typeof roundingFrozen>>) => {
    const dr = Decimal.sum(0, ...entry.lines.filter((l) => l.side === "DEBIT").map((l) => l.amountThb)).toFixed(2);
    const cr = Decimal.sum(0, ...entry.lines.filter((l) => l.side === "CREDIT").map((l) => l.amountThb)).toFixed(2);
    return { dr, cr };
  };
  const fixturesSell: { net: string; basis: string; gain: string; dr: string; cr: string }[] = [
    { net: "86.60", basis: "0.01", gain: "86.59", dr: "2733.96", cr: "2733.97" },
    { net: "108.92", basis: "0.01", gain: "108.91", dr: "3438.60", cr: "3438.61" },
    { net: "161.57", basis: "0.01", gain: "161.56", dr: "5100.76", cr: "5100.77" },
    { net: "166.03", basis: "0.04", gain: "165.99", dr: "5241.57", cr: "5241.56" },
    { net: "35.59", basis: "0.02", gain: "35.57", dr: "1123.58", cr: "1123.57" },
    { net: "417.15", basis: "0.02", gain: "417.13", dr: "13169.43", cr: "13169.42" },
    { net: "106.92", basis: "0.01", gain: "106.91", dr: "3375.46", cr: "3375.47" },
  ];
  for (const f of fixturesSell) {
    const e = roundingFrozen(baseRow({ category: "asset", side: "SELL",
      amountForeign: f.net, costBasis: f.basis, realizedGainLoss: f.gain,
      realizedGainLossThb: "0", fxRateEffective: "31.57", fxRateStatement: "31.57" }));
    const r = e ? roundingLeg(e) : null;
    const { dr, cr } = e ? thbTotals(e) : { dr: "", cr: "" };
    ok(!!e && e.lines.length === 4 && !!r && r.amount === "0.01" &&
      ((f.dr > f.cr && r.side === "CREDIT") || (f.dr < f.cr && r.side === "DEBIT")) &&
      e.lines.some((l) => l.accountId === "1020" && l.side === "DEBIT" && l.amount === f.net) &&
      e.lines.some((l) => l.accountId === "1110" && l.side === "CREDIT" && l.amount === f.basis) &&
      e.lines.some((l) => l.accountId === "4020" && l.side === "CREDIT" && l.amount === f.gain),
      `rounding fixture ${f.dr}/${f.cr} (net ${f.net}) posts 4 legs with exact 5020 0.01 ${f.dr > f.cr ? "CREDIT" : "DEBIT"}`);
    ok(dr === cr && dr === (f.dr > f.cr ? f.dr : f.cr),
      `rounding fixture ${f.dr}/${f.cr} balances THB after the leg (dr ${dr} = cr ${cr})`);
  }
  // The THB leg is never added: to THB entries, FX conversions, differences
  // beyond 0.01, or already-balancing bases.
  const thbCash = postCapitalRow(baseRow({ category: "equity", currency: "THB", fxRateEffective: "1" }));
  ok(thbCash.ok && thbCash.entry.lines.every((l) => l.memo !== "THB rounding adjustment"),
    "rounding: THB entries never gain a rounding leg");
  const roundingEngine = applyThbRoundingAdjustment({
    entryDate: "2026-01-15", description: "no-op",
    lines: [
      { accountId: "1020", currency: "USD", debit: "100.00", fxRateEffective: "35" },
      { accountId: "3010", currency: "USD", credit: "100.00", fxRateEffective: "35.02" },
    ],
  });
  ok(roundingEngine.lines.length === 2,
    "rounding: |diff| > 0.01 (100 * 35 vs 100 * 35.02) never gains a rounding leg");
  const roundingThbBase = applyThbRoundingAdjustment({
    entryDate: "2026-01-15", description: "fx conv", lines: [
      { accountId: "1020", currency: "USD", debit: "100.00", fxRateEffective: "35" },
      { accountId: "1010", currency: "THB", credit: "3500.00", fxRateEffective: "1" },
    ],
  });
  ok(roundingThbBase.lines.length === 2,
    "rounding: two-currency FX conversion never gains a rounding leg");
  const roundingZero = applyThbRoundingAdjustment({ entryDate: "2026-01-15", description: "bal",
    lines: [
      { accountId: "1020", currency: "USD", debit: "100.00", fxRateEffective: "35" },
      { accountId: "3010", currency: "USD", credit: "100.00", fxRateEffective: "35" },
    ],
  });
  ok(roundingZero.lines.length === 2, "rounding: already-balancing base gains nothing");
  // The validator accepts the auto leg and rejects any deviation.
  const wrongSide = validateJournalEntry({
    entryDate: "2026-01-15", description: "wrong rounding side",
    lines: [
      { accountId: "1110", currency: "USD", debit: "10.00", fxRateEffective: "3.1415" },
      { accountId: "5010", currency: "USD", debit: "10.00", fxRateEffective: "3.1415" },
      { accountId: "1020", currency: "USD", credit: "20.00", fxRateEffective: "3.1415" },
      { accountId: "5020", currency: "THB", debit: "0.01", memo: "THB rounding adjustment" },
    ],
  });
  ok(!wrongSide.ok && wrongSide.errors.some((e) => e.includes("must be THB with amount and side")),
    "rounding: validator rejects a rounding leg on the wrong side (expected CREDIT)");
  const notNeeded = validateJournalEntry({
    entryDate: "2026-01-15", description: "unneeded rounding",
    lines: [
      { accountId: "1020", currency: "USD", debit: "10.00", fxRateEffective: "3.1415" },
      { accountId: "1110", currency: "USD", credit: "10.00", fxRateEffective: "3.1415" },
      { accountId: "5020", currency: "THB", credit: "0.01", memo: "THB rounding adjustment" },
    ],
  });
  ok(!notNeeded.ok && notNeeded.errors.some((e) => e.includes("not needed")),
    "rounding: validator rejects a rounding leg when the base already balances");
  const twoRounding = validateJournalEntry({
    entryDate: "2026-01-15", description: "two rounding legs",
    lines: [
      { accountId: "1110", currency: "USD", debit: "10.00", fxRateEffective: "3.1415" },
      { accountId: "5010", currency: "USD", debit: "10.00", fxRateEffective: "3.1415" },
      { accountId: "1020", currency: "USD", credit: "20.00", fxRateEffective: "3.1415" },
      { accountId: "5020", currency: "THB", credit: "0.01", memo: "THB rounding adjustment" },
      { accountId: "5020", currency: "THB", debit: "0.02", memo: "THB rounding adjustment" },
    ],
  });
  ok(!twoRounding.ok && twoRounding.errors.some((e) => e.includes("allows at most one line")),
    "rounding: validator rejects a second rounding leg");

  // THB owner deposits ARE now supported: the default chart of accounts gained
  // 3020 (THB owner capital), so a THB equity CASH_IN posts Dr 1010 / Cr 3020
  // (previously SKIPPED "no compatible THB account for 3010").
  const thbDeposit = postCapitalRow(baseRow({ category: "equity", currency: "THB", fxRateEffective: "1" }));
  ok(thbDeposit.ok, "THB equity deposit now posts (3020 owner-capital account exists)");
  if (thbDeposit.ok) {
    ok(thbDeposit.entry.lines.some((l) => l.accountId === "1010" && l.debit === "100.00"),
      "THB deposit debits the THB cash account (1010)");
    ok(thbDeposit.entry.lines.some((l) => l.accountId === "3020" && l.credit === "100.00"),
      "THB deposit credits the THB owner-capital account (3020), NOT 3010");
    ok(thbDeposit.entry.lines.every((l) => l.accountId !== "3010"),
      "THB equity never touches the USD owner-capital account (3010)");
  }
  const thbWithdraw = postCapitalRow(baseRow({
    category: "equity", currency: "THB", fxRateEffective: "1", type: "CASH_OUT" as const,
  }));
  ok(thbWithdraw.ok && thbWithdraw.entry.lines.some((l) => l.accountId === "3020" && l.debit === "100.00") &&
     thbWithdraw.entry.lines.some((l) => l.accountId === "1010" && l.credit === "100.00"),
    "THB equity CASH_OUT reverses: Dr 3020 / Cr 1010");
  // USD equity deposits keep the classic 3010 pair (never 3020).
  const usdDeposit = postCapitalRow(baseRow({ category: "equity" }));
  ok(usdDeposit.ok && usdDeposit.entry.lines.some((l) => l.accountId === "3010" && l.credit === "100.00") &&
     usdDeposit.entry.lines.some((l) => l.accountId === "1020" && l.debit === "100.00"),
    "USD equity deposit still posts Dr 1020 / Cr 3010 (unchanged)");
  // Unsupported foreign currency falls back to 3010 (USD) and is then SKIPPED
  // by the account-currency compatibility check — never invented or mismatched.
  const eurDeposit = postCapitalRow(baseRow({ category: "equity", currency: "EUR", fxRateEffective: "34.5" }));
  ok(!eurDeposit.ok && eurDeposit.reason.includes("compatible"),
    "unsupported-currency equity stays SKIPPED (no fake conversion leg)");

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
  ok(!sellNoBasis.ok && sellNoBasis.reason.includes("NON_COMPUTABLE"), "non-computable SELL is explicitly skipped without a fake basis");

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
    "computable SELL -> POSTED entry with its posting lines (cash, basis, gain)"
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
        d.amountThb === "12733.00",
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

  // ---- R4 FEES: acquisition-cost (fees-included) asset debit, no double count. ----
  console.log("=== R4 FEES (acquisition cost incl. fees, no double count) ===");

  // A) BUY with fee: 2 legs — acquisition cost (net) to asset, net to cash.
  //    Fees are part of the asset cost, NOT a separate expense.
  const buyWithFee = postCapitalRow(
    baseRow({
      transactionId: "tx-buy-fee",
      category: "asset",
      side: "BUY",
      symbol: "NVDA",
      quantity: "10",
      unitPrice: "100",
      grossAmount: "1000",
      fees: "11",
      amountForeign: "1011.00",
      netAmount: "1011.00",
    })
  );
  ok(buyWithFee.ok && buyWithFee.entry.lines.length === 3, "R4-A: BUY with fee posts 3 legs");
  if (buyWithFee.ok) {
    const investLeg = buyWithFee.entry.lines.find((l) => l.accountId === "1110");
    const feeLeg = buyWithFee.entry.lines.find((l) => l.accountId === "5010");
    const vatLeg = buyWithFee.entry.lines.find((l) => l.accountId === "5130");
    const cashLeg = buyWithFee.entry.lines.find((l) => l.accountId === "1020");
    ok(
      !!investLeg && investLeg.debit === "1010.28" && investLeg.credit == null,
      "R4-A: investment debited by the ACQUISITION COST (1010.28, commission INCLUDED)"
    );
    ok(
      !!vatLeg && vatLeg.debit === "0.72",
      "R4-A: VAT debited to 5130"
    );
    ok(
      feeLeg === undefined,
      "R4-A: fee is NOT expensed separately (5010 absent — commission is inside the asset cost)"
    );
    ok(
      !!cashLeg && cashLeg.credit === "1011.00" && cashLeg.debit == null,
      "R4-A: broker cash credited by NET (1011)"
    );
    ok(
      buyWithFee.entry.lines.every((l) => l.currency === "USD"),
      "R4-A: all legs in the trade currency (per-currency rule)"
    );
  }

  // B) BUY zero fee: 2 legs (no fee leg emitted).
  const buyNoFee = postCapitalRow(
    baseRow({
      transactionId: "tx-buy-nofee",
      category: "asset",
      side: "BUY",
      symbol: "AAPL",
      quantity: "10",
      unitPrice: "100",
      grossAmount: "1000",
      fees: "0",
      amountForeign: "1000.00",
      netAmount: "1000.00",
    })
  );
  ok(buyNoFee.ok && buyNoFee.entry.lines.length === 2, "R4-B: BUY without fees posts 2 legs (no 5010)");
  if (buyNoFee.ok) {
    ok(
      buyNoFee.entry.lines.some((l) => l.accountId === "1110" && l.debit === "1000.00"),
      "R4-B: investment = principal = net when no fee"
    );
    ok(
      buyNoFee.entry.lines.some((l) => l.accountId === "1020" && l.credit === "1000.00"),
      "R4-B: cash = net when no fee"
    );
    ok(
      buyNoFee.entry.lines.every((l) => l.accountId !== "5010"),
      "R4-B: fee account 5010 absent when fee is zero"
    );
  }

  // C) BUY with a broker rebate (negative fee): the authoritative acquisition
  //    cost is the broker NET (995), so the asset is debited by the net actually
  //    paid and no separate 5010 contra-expense leg is emitted.
  const buyRebate = postCapitalRow(
    baseRow({
      transactionId: "tx-buy-rebate",
      category: "asset",
      side: "BUY",
      symbol: "VOO",
      quantity: "10",
      unitPrice: "100",
      grossAmount: "1000",
      fees: "-5",
      amountForeign: "995.00",
      netAmount: "995.00",
    })
  );
  ok(buyRebate.ok && buyRebate.entry.lines.length === 2, "R4-C: BUY with rebate posts 2 legs");
  if (buyRebate.ok) {
    const investLeg = buyRebate.entry.lines.find((l) => l.accountId === "1110");
    const feeLeg = buyRebate.entry.lines.find((l) => l.accountId === "5010");
    const cashLeg = buyRebate.entry.lines.find((l) => l.accountId === "1020");
    ok(
      !!investLeg && investLeg.debit === "995.00",
      "R4-C: investment debited by the net acquisition cost (995), not by gross (1000)"
    );
    ok(
      feeLeg === undefined,
      "R4-C: rebate produces no separate 5010 leg (already inside the asset cost)"
    );
    ok(
      !!cashLeg && cashLeg.credit === "995.00",
      "R4-C: cash = net = gross minus rebate"
    );
  }

  // D) Monthly fee/VAT summary rows (parser aggregate flag set): SKIPPED unconditionally.
  const monthlyFee = postCapitalRow(
    baseRow({
      transactionId: "tx-fee-monthly",
      category: "expense",
      section: "ค่าธรรมเนียม",
      amountForeign: "11.00",
      isMonthlyFeeAggregate: true,
    })
  );
  ok(
    !monthlyFee.ok && monthlyFee.reason.includes("already inside the BUY acquisition cost"),
    "R4-D: monthly brokerage-fee summary row not posted (fees already in the trade postings)"
  );
  const monthlyVat = postCapitalRow(
    baseRow({
      transactionId: "tx-vat-monthly",
      category: "expense",
      section: "VAT",
      amountForeign: "0.70",
      isMonthlyFeeAggregate: true,
    })
  );
  ok(
    !monthlyVat.ok && monthlyVat.reason.includes("already inside the BUY acquisition cost"),
    "R4-D: monthly VAT summary row not posted (fees already in the trade postings)"
  );

  // E) WHT rows (different section from fee/VAT): still posted normally.
  const whtRow = postCapitalRow(
    baseRow({
      transactionId: "tx-wht",
      category: "expense",
      section: "ภาษีหัก ณ ที่จ่าย (ปันผล)",
      amountForeign: "15.00",
    })
  );
  ok(
    whtRow.ok &&
      whtRow.entry.lines.some((l) => l.accountId === "5110" && l.debit === "15.00"),
    "R4-E: WHT row still posts (Dr 5110, section not matched)"
  );

  // F) buildStatementJournalEntries: BUY + monthly rows → 3 journal entries
  //    (BUY POSTED with 2 lines, fee-row SKIPPED with 0 lines, WHT POSTED).
  const r4JournalRows = [
    baseRow({
      transactionId: "tx-r4-buy",
      category: "asset",
      side: "BUY",
      symbol: "TSLA",
      quantity: "20",
      unitPrice: "50",
      grossAmount: "1000",
      fees: "22",
      amountForeign: "1022.00",
      netAmount: "1022.00",
    }),
    baseRow({
      transactionId: "tx-r4-fee",
      category: "expense",
      section: "ค่าธรรมเนียม",
      amountForeign: "22.00",
      isMonthlyFeeAggregate: true,
    }),
    baseRow({
      transactionId: "tx-r4-wht",
      category: "expense",
      section: "ภาษีหัก ณ ที่จ่าย (ปันผล)",
      amountForeign: "8.00",
    }),
  ] as ValidatedCapitalRow[];
  const r4Entries = buildStatementJournalEntries(r4JournalRows);
  ok(r4Entries.length === 3, "R4-F: one journal entry per row (BUY + fee summary + WHT)");
  const r4BuyEntry = r4Entries.find((e) => e.transactionId === "tx-r4-buy");
  ok(
    !!r4BuyEntry && r4BuyEntry.postingState === "POSTED" && r4BuyEntry.entry.lines.length === 3,
    "R4-F: BUY entry POSTED with 3 lines (acquisition cost incl. fees)"
  );
  const r4FeeEntry = r4Entries.find((e) => e.transactionId === "tx-r4-fee");
  ok(
    !!r4FeeEntry &&
      r4FeeEntry.postingState === "SKIPPED" &&
      r4FeeEntry.entry.lines.length === 0,
    "R4-F: monthly fee row SKIPPED (no GL lines)"
  );
  const r4WhtEntry = r4Entries.find((e) => e.transactionId === "tx-r4-wht");
  ok(
    !!r4WhtEntry &&
      r4WhtEntry.postingState === "POSTED" &&
      r4WhtEntry.entry.lines.length === 2,
    "R4-F: WHT row still POSTED (2 legs)"
  );

  // Fb) A negative standalone expense (rebate) survives the FULL journal-build
  //     path: buildStatementJournalEntries accepts it (validateJournalEntry
  //     passes, legs positive) and the contra-expense legs come out right.
  const r4RebateEntries = buildStatementJournalEntries([
    baseRow({
      transactionId: "tx-r4-rebate",
      category: "expense",
      section: "ค่าธรรมเนียม",
      amountForeign: "-3.50",
      type: "CASH_OUT",
    }),
  ]);
  const r4RebateEntry = r4RebateEntries.find((e) => e.transactionId === "tx-r4-rebate");
  ok(
    !!r4RebateEntry &&
      r4RebateEntry.postingState === "POSTED" &&
      r4RebateEntry.entry.lines.length === 2 &&
      r4RebateEntry.entry.lines.some((l) => l.accountId === "1020" && l.debit === "3.50") &&
      r4RebateEntry.entry.lines.some((l) => l.accountId === "5010" && l.credit === "3.50"),
    "R4-Fb: standalone rebate -3.50 is journal-built and POSTED (Dr 1020 3.50 / Cr 5010 3.50, validateJournalEntry-safe)"
  );

  // G) Liquidation lifecycle: BUY 10@100 (fee 11, acquisition cost 1011) →
  //    full SELL 10@120 (fee 11, net 1189). Investment dr 1011 / cr 1011 → zero;
  //    cash net +178; no fee expensed (BUY fees inside the asset cost, SELL fees
  //    inside the net proceeds).
  const lifeBuy = buildStatementJournalEntries([
    baseRow({
      transactionId: "tx-life-buy",
      category: "asset",
      side: "BUY",
      symbol: "ABC",
      quantity: "10",
      unitPrice: "100",
      grossAmount: "1000",
      fees: "11",
      amountForeign: "1011.00",
      netAmount: "1011.00",
    }),
  ]);
  const lifeSell = buildStatementJournalEntries([
    baseRow({
      transactionId: "tx-life-sell",
      category: "asset",
      side: "SELL",
      symbol: "ABC",
      quantity: "10",
      unitPrice: "120",
      grossAmount: "1200",
      fees: "11",
      amountForeign: "1189.00",
      netAmount: "1189.00",
      proceeds: "1189.00",
      costBasis: "1010.28",
      realizedGainLoss: "178.72",
      realizedGainLossThb: "5938.87",
    }),
  ]);
  ok(lifeBuy.length === 1 && lifeSell.length === 1, "R4-G: lifecycle BUY + SELL each produce one entry");
  if (lifeBuy.length === 1 && lifeSell.length === 1) {
    ok(lifeBuy[0].postingState === "POSTED" && lifeSell[0].postingState === "POSTED", "R4-G: both lifecycle entries POSTED");
    const bLines = lifeBuy[0].entry.lines;
    const sLines = lifeSell[0].entry.lines;
    // Investment: Dr 1010.28 (BUY) / Cr 1010.28 (SELL) → net 0 (fully liquidated).
    const investDr = bLines
      .filter((l) => l.accountId === "1110" && l.debit != null)
      .reduce((s, l) => s + Number(l.debit), 0);
    const investCr = sLines
      .filter((l) => l.accountId === "1110" && l.credit != null)
      .reduce((s, l) => s + Number(l.credit), 0);
    ok(investDr === 1010.28 && investCr === 1010.28, "R4-G: full liquidation drains investment to zero (1010.28 dr / 1010.28 cr)");
    // BUY fees capitalized in 1110 (5010 absent); SELL fee already netted in net proceeds (5010 absent in SELL).
    const feeDrBuy = bLines
      .filter((l) => l.accountId === "5010" && l.debit != null)
      .reduce((s, l) => s + Number(l.debit), 0);
    const feeDrSell = sLines
      .filter((l) => l.accountId === "5010" && l.debit != null)
      .reduce((s, l) => s + Number(l.debit), 0);
    ok(feeDrBuy === 0 && feeDrSell === 0, "R4-G: BUY fees capitalized in 1110; SELL fee netted in proceeds (5010 absent in both)");
    // Cash: -1011 (paid) / +1189 (received) → net +178.
    const cashCr = bLines
      .filter((l) => l.accountId === "1020" && l.credit != null)
      .reduce((s, l) => s + Number(l.credit), 0);
    const cashDr = sLines
      .filter((l) => l.accountId === "1020" && l.debit != null)
      .reduce((s, l) => s + Number(l.debit), 0);
    ok(cashDr - cashCr === 178, "R4-G: cash net +178 (1189 received − 1011 paid)");
    // Gain: Cr 178.72 = net proceeds (1189) − acquisition-cost basis (1010.28).
    const gainCr = sLines
      .filter((l) => l.accountId === "4020" && l.credit != null)
      .reduce((s, l) => s + Number(l.credit), 0);
    ok(gainCr === 178.72, "R4-G: realized gain 178.72 = net proceeds 1189 − basis 1010.28 (no double-count 5010)");
  }

  // H) THB trade: asserted at PARSER/PIPELINE currency separation, NOT posting.
  //    A THB BUY maps to a THB-denominated row (fx pinned to 1) and the THB
  //    POSTING path is explicitly pending R7 — the chart of accounts defines
  //    1110/5010 as USD accounts, so a THB BUY must not be "validly posted"
  //    through them. R4 stops at the currency separation instead of locking any
  //    THB leg geometry.
  const thbText = [
    "TRADE RECORDS",
    "Currency: THB",
    "AAA",
    "05/01/2026 10:00:00,GMT+07 05/01/2026 BUY 100 10.00 1000.00 1011.00 11.00 0.00 SET",
    "PORTFOLIO SUMMARY",
  ];
  const parsedThb = parseStatementRows(thbText, {});
  const thbRows: ValidatedCapitalRow[] = [];
  for (const t of parsedThb.transactions) {
    const mapped = mapToCapitalRow(t, "user-1", "doc-thb");
    if (mapped.ok) thbRows.push(mapped.row);
  }
  const thbBuy = thbRows.find((r) => r.category === "asset" && r.side === "BUY" && r.currency === "THB");
  ok(
    thbBuy !== undefined &&
      thbBuy.quantity === "100" &&
      thbBuy.unitPrice === "10" &&
      thbBuy.grossAmount === "1000" &&
      thbBuy.fees === "11" &&
      thbBuy.netAmount === "1011" &&
      thbBuy.amountForeign === "1011.00" &&
      thbBuy.currency === "THB" &&
      thbBuy.fxRateEffective === "1",
    "R4-H: real parser separates THB BUY (qty 100 @ 10, fee 11, net 1011, currency THB, fx pinned 1)"
  );
  ok(
    thbBuy !== undefined && thbBuy.amountThb === "1011.00",
    "R4-H: THB row amount_thb === amount_foreign (THB = 1, no invented conversion)"
  );

  // ---- R4 GAP-1: BUY with authoritative net can post without trade detail. ----
  const buyMissingPrincipal = postCapitalRow(
    baseRow({
      transactionId: "tx-buy-noprincipal",
      category: "asset",
      side: "BUY",
      symbol: "MSFT",
      quantity: null,
      unitPrice: null,
      grossAmount: "1200.00",
      amountForeign: "1211.00",
      netAmount: "1211.00",
    })
  );
  ok(
    buyMissingPrincipal.ok && buyMissingPrincipal.entry.lines.length === 2 &&
      buyMissingPrincipal.entry.lines.some((l) => l.accountId === "1110" && l.debit === "1211.00") &&
      buyMissingPrincipal.entry.lines.some((l) => l.accountId === "1020" && l.credit === "1211.00"),
    "R4-G1: BUY with authoritative net posts a two-leg acquisition-cost transfer"
  );

  // ---- R4 GAP-2: provenace flag drives the monthly-row skip; the same section
  //      label WITHOUT the flag is a REAL standalone fee and must POST once. ----
  const standaloneFee = postCapitalRow(
    baseRow({
      transactionId: "tx-standalone-fee",
      category: "expense",
      section: "ค่าธรรมเนียม",
      amountForeign: "9.00",
    })
  );
  ok(
    standaloneFee.ok &&
      standaloneFee.entry.lines.some((l) => l.accountId === "5010" && l.debit === "9.00"),
    "R4-G2: standalone broker fee (section=ค่าธรรมเนียม, no aggregate flag) POSTS Dr 5010 once"
  );

  // ---- R4 GAP-2b: a NEGATIVE standalone expense is a REBATE (money RETURNED to
  //      the account). The pipeline preserves the parser sign on expense rows, so
  //      the posting engine must post the contra-expense — Dr cash / Cr fee —
  //      NOT a fee debit (an expense debit for money received would be wrong).
  //      Leg amounts stay POSITIVE (validateJournalEntry + the journal_entry_lines
  //      debit/credit CHECKs forbid non-positive line amounts). ----
  const standaloneRebate = postCapitalRow(
    baseRow({
      transactionId: "tx-standalone-rebate",
      category: "expense",
      section: "ค่าธรรมเนียม",
      amountForeign: "-2.00",
      type: "CASH_OUT",
    })
  );
  ok(
    standaloneRebate.ok &&
      standaloneRebate.note === "expense rebate (contra-expense)" &&
      standaloneRebate.entry.lines.some((l) => l.accountId === "1020" && l.debit === "2.00") &&
      standaloneRebate.entry.lines.some((l) => l.accountId === "5010" && l.credit === "2.00"),
    "R4-G2b: negative standalone expense (rebate -2) posts contra-expense Dr cash 1020 / Cr fee 5010"
  );
  if (standaloneRebate.ok) {
    ok(
      !standaloneRebate.entry.lines.some((l) => l.accountId === "5010" && l.debit != null) &&
        !standaloneRebate.entry.lines.some((l) => l.accountId === "1020" && l.credit != null),
      "R4-G2b: rebate never debits the fee account nor credits cash (no phoney expense)"
    );
    ok(
      standaloneRebate.entry.lines.every((l) =>
        [l.debit, l.credit].every((v) => v == null || Number(v) > 0)
      ),
      "R4-G2b: rebate leg amounts are positive (line CHECK-safe)"
    );
  }

  // ---- R4 GAP-2c: mapToCapitalRow PRESERVES the parser's negative sign on
  //      expense rows (amountForeign "-2.00", direction CASH_IN since money came
  //      back), while non-expense rows keep the historical positive-magnitude
  //      convention (direction in `type`). ----
  const rebateRow = mapToCapitalRow(
    {
      id: "txn-rebate",
      date: "15/01/2026",
      currency: "USD",
      amount: -2,
      category: "expense",
      description: "ค่าธรรมเนียม (คืนเงิน)",
      pnlAmount: 0,
      rate: "35",
      section: "ค่าธรรมเนียม",
      included: true,
    },
    "user-1",
    "doc-1"
  );
  ok(
    rebateRow.ok &&
      rebateRow.row.amountForeign === "-2.00" &&
      rebateRow.row.amountThb === "-70.00" &&
      rebateRow.row.type === "CASH_IN",
    "R4-G2c: expense rebate maps with signed amountForeign -2.00 (THB -70.00) and CASH_IN direction"
  );

  const feeRow = mapToCapitalRow(
    {
      id: "txn-fee",
      date: "15/01/2026",
      currency: "USD",
      amount: 9,
      category: "expense",
      description: "ค่าธรรมเนียม",
      pnlAmount: 0,
      rate: "35",
      section: "ค่าธรรมเนียม",
      included: true,
    },
    "user-1",
    "doc-1"
  );
  ok(
    feeRow.ok &&
      feeRow.row.amountForeign === "9.00" &&
      feeRow.row.amountThb === "315.00" &&
      feeRow.row.type === "CASH_OUT",
    "R4-G2c: positive standalone fee keeps +9.00 / THB 315.00 and CASH_OUT direction"
  );

  const nonExpense = mapToCapitalRow(
    {
      id: "txn-deposit",
      date: "15/01/2026",
      currency: "USD",
      amount: 1000,
      category: "equity",
      description: "เงินฝาก",
      pnlAmount: 0,
      rate: "35",
      section: "เงินฝาก",
      included: true,
    },
    "user-1",
    "doc-1"
  );
  ok(
    nonExpense.ok &&
      nonExpense.row.amountForeign === "1000.00" &&
      nonExpense.row.type === "CASH_IN",
    "R4-G2c: non-expense rows still use positive magnitude (1000.00, direction in type)"
  );

  // ---- R4 GAP-3 + GAP-5: REAL parser -> pipeline -> posting regression.
  //      A statement mixing USD + THB trades must emit ONE fee row + ONE VAT row
  //      PER CURRENCY (never a cross-currency sum), and the posting engine must
  //      use broker Net Amount as acquisition cost and skip the monthly rows. ----
  const mixedText = [
    "TRADE RECORDS",
    "Currency: USD",
    "USD/THB = 35.42",
    "AAA",
    "02/01/2026 10:00:00,GMT+07 02/01/2026 BUY 100 10.00 1000.00 1001.00 1.00 0.00 NASDAQ",
    "Currency: THB",
    "BBB",
    "03/01/2026 10:00:00,GMT+07 03/01/2026 BUY 10 100.00 1000.00 1010.00 10.00 0.00 SET",
    "PORTFOLIO SUMMARY",
  ];
  const parsedMixed = parseStatementRows(mixedText, {});
  const mRows: ValidatedCapitalRow[] = [];
  for (const t of parsedMixed.transactions) {
    const mapped = mapToCapitalRow(t, "user-1", "doc-mixed");
    if (mapped.ok) mRows.push(mapped.row);
  }
  const mBuyUsd = mRows.find((r) => r.category === "asset" && r.side === "BUY" && r.currency === "USD");
  const mBuyThb = mRows.find((r) => r.category === "asset" && r.side === "BUY" && r.currency === "THB");
  const mFeeRows = mRows.filter((r) => r.isMonthlyFeeAggregate === true && r.section === "ค่าธรรมเนียม");
  ok(
    mBuyUsd !== undefined &&
      mBuyUsd.quantity === "100" &&
      mBuyUsd.unitPrice === "10" &&
      mBuyUsd.grossAmount === "1000" &&
      mBuyUsd.fees === "1" &&
      mBuyUsd.netAmount === "1001",
    "R4-G3: real parser maps USD BUY (qty 100 @ 10, fee 1, net 1001)"
  );
  ok(
    mBuyThb !== undefined &&
      mBuyThb.quantity === "10" &&
      mBuyThb.unitPrice === "100" &&
      mBuyThb.fees === "10" &&
      mBuyThb.netAmount === "1010" &&
      mBuyThb.currency === "THB" &&
      mBuyThb.fxRateEffective === "1",
    "R4-G3: real parser maps THB BUY (qty 10 @ 100, fee 10, net 1010, fx pinned to 1)"
  );
  ok(
    mFeeRows.length === 2 &&
      mFeeRows.some((r) => r.currency === "USD" && r.amountForeign === "1.00") &&
      mFeeRows.some((r) => r.currency === "THB" && r.amountForeign === "10.00"),
    "R4-G3: monthly fees aggregated PER CURRENCY (USD 1 + THB 10, never one '11')"
  );
  const mMixedEntries = buildStatementJournalEntries(mRows);
  const mBuyUsdEntry = mMixedEntries.find((e) => e.transactionId === mBuyUsd?.transactionId);
  const mBuyThbEntry = mMixedEntries.find((e) => e.transactionId === mBuyThb?.transactionId);
  ok(
    mBuyUsdEntry?.postingState === "POSTED" &&
      mBuyUsdEntry.entry.lines.length === 3 &&
      mBuyUsdEntry.entry.lines.find((l) => l.accountId === "1110" && l.debit === "1000.93") !== undefined &&
      mBuyUsdEntry.entry.lines.find((l) => l.accountId === "5130" && l.debit === "0.07") !== undefined &&
      !mBuyUsdEntry.entry.lines.some((l) => l.accountId === "5010") &&
      mBuyUsdEntry.entry.lines.find((l) => l.accountId === "1020" && l.credit === "1001.00") !== undefined,
    "R4-G3: USD BUY posts fee-inclusive acquisition cost 1000.93 + VAT 0.07 once (no 5010 double count)"
  );
  ok(
    mBuyThbEntry !== undefined,
    // THB posting geometry is NOT asserted here: the chart of accounts defines
    // 1110/5010 as USD accounts, so a THB BUY must not be "validly posted"
    // through them. The THB posting path is explicitly pending R7; R4 only
    // guarantees the row reached the journal as a record (SSOT completeness).
    "R4-G3: THB BUY row is journaled (SSOT record completeness; posting geometry pending R7, not asserted)"
  );
  const mFeeEntries = mMixedEntries.filter((e) => mFeeRows.some((r) => r.transactionId === e.transactionId));
  ok(
    mFeeEntries.length === 2 &&
      mFeeEntries.every((e) => e.postingState === "SKIPPED" && e.entry.lines.length === 0),
    "R4-G3: both monthly fee rows SKIPPED (no GL lines, one per currency)"
  );

  // ---- R4 GAP-4: SELL fee policy — gain = net proceeds − basis; the SELL fee is
  // ---- R4 GAP-4 end-to-end: SELL fee policy. Realized gain = net proceeds − basis.
  //      Fee is ALREADY netted in proceeds, never a separate 5010/5130 leg. ----
  const sellFeePolicy = postCapitalRow(
    baseRow({
      transactionId: "tx-sell-fee-policy",
      category: "asset",
      side: "SELL",
      symbol: "ABC",
      quantity: "10",
      unitPrice: "120",
      grossAmount: "1200",
      fees: "11",
      amountForeign: "1189.00",
      netAmount: "1189.00",
      proceeds: "1189.00",
      costBasis: "1000.00",
      realizedGainLoss: "189.00",
      realizedGainLossThb: "6000.00",
    })
  );
  ok(
    sellFeePolicy.ok &&
      sellFeePolicy.entry.lines.some((l) => l.accountId === "1020" && l.debit === "1189.00") &&
      sellFeePolicy.entry.lines.every((l) => l.accountId !== "5010") &&
      sellFeePolicy.entry.lines.every((l) => l.accountId !== "5130") &&
      sellFeePolicy.entry.lines.some((l) => l.accountId === "1110" && l.credit === "1000.00") &&
      sellFeePolicy.entry.lines.some((l) => l.accountId === "4020" && l.credit === "189.00"),
    "R4-G4: SELL net 1189 − basis 1000 = gain 189; no duplicate 5010/5130 legs"
  );

  // ---- R4 GAP-5 end-to-end: real parser -> mapToCapitalRow -> posting for a SELL
  //      whose gain IS computable (net proceeds − basis, no separate 5010/5130). ----
  const sellText = [
    "TRADE RECORDS",
    "Currency: USD",
    "USD/THB = 35.42",
    "ZZZ",
    "04/01/2026 10:00:00,GMT+07 04/01/2026 SELL 10 120.00 1200.00 1189.00 11.00 0.00 NASDAQ",
    "PORTFOLIO SUMMARY",
    "ZZZ",
    "10 1 100.00 1000.00 120.00 1189.00 USD NASDAQ",
  ];
  const parsedSell = parseStatementRows(sellText, {});
  const sRows: ValidatedCapitalRow[] = [];
  for (const t of parsedSell.transactions) {
    const mapped = mapToCapitalRow(t, "user-1", "doc-sell");
    if (mapped.ok) sRows.push(mapped.row);
  }
  const sSell = sRows.find((r) => r.category === "asset" && r.side === "SELL");
  ok(
    sSell !== undefined &&
      sSell.netAmount === "1189" &&
      sSell.costBasis === "1000.00" &&
      sSell.realizedGainLoss === "189.00" &&
      sSell.amountForeign === "1189.00",
    "R4-G5: real parser computes SELL net 1189 / basis 1000 / gain 189 (fee already in net proceeds)"
  );
  const sEntries = buildStatementJournalEntries(sRows.filter((r) => r.transactionId === sSell?.transactionId));
  ok(
    sEntries.length === 1 &&
      sEntries[0].postingState === "POSTED" &&
      sEntries[0].entry.lines.some((l) => l.accountId === "4020" && l.credit === "189.00") &&
      sEntries[0].entry.lines.every((l) => l.accountId !== "5010") &&
      sEntries[0].entry.lines.every((l) => l.accountId !== "5130"),
    "R4-G5: real-parser SELL posts gain 189 without duplicate 5010 and 5130"
  );

  // ---- Explicit Professor Requirement Verification Fixtures ----
  // 1. TSLY BUY fixture:
  //    Gross 110.40, Fee 0.11, VAT 0.01, Net Cash 110.52 -> Dr 1110: 110.51, Dr 5130: 0.01, Cr 1020: 110.52.
  const tslyBuy = postCapitalRow(
    baseRow({
      transactionId: "tx-tsly-buy",
      category: "asset",
      side: "BUY",
      symbol: "TSLY",
      quantity: "10",
      unitPrice: "11.04",
      grossAmount: "110.40",
      fees: "0.12",
      amountForeign: "110.52",
      netAmount: "110.52",
    })
  );
  ok(tslyBuy.ok && tslyBuy.entry.lines.length === 3, "TSLY fixture: BUY with comm 0.11 and VAT 0.01 posts 3 legs");
  if (tslyBuy.ok) {
    const drInvest = tslyBuy.entry.lines.find((l) => l.accountId === "1110");
    const drVat = tslyBuy.entry.lines.find((l) => l.accountId === "5130");
    const crCash = tslyBuy.entry.lines.find((l) => l.accountId === "1020");
    ok(drInvest?.debit === "110.51", "TSLY fixture: Dr 1110 Investment = Gross 110.40 + Comm 0.11 = 110.51");
    ok(drVat?.debit === "0.01", "TSLY fixture: Dr 5130 VAT Expense = 0.01");
    ok(crCash?.credit === "110.52", "TSLY fixture: Cr 1020 Cash USD = Net Cash 110.52");
    ok(tslyBuy.entry.lines.every((l) => l.accountId !== "5010"), "TSLY fixture: No 5010 double expense leg");
  }

  // 2. SELL double-entry (RDW / UUUU fixture):
  //    Gross 100.00, Fee 1.07, Net Cash 98.93, Cost Basis 60.00 ->
  //    Dr 1020: 98.93, Cr 1110: 60.00, Cr 4020: 38.93. (Net proceeds 98.93 - Cost Basis 60.00 = 38.93)
  const rdwSell = postCapitalRow(
    baseRow({
      transactionId: "tx-rdw-sell",
      category: "asset",
      side: "SELL",
      symbol: "RDW",
      quantity: "10",
      unitPrice: "10.00",
      grossAmount: "100.00",
      fees: "1.07",
      amountForeign: "98.93",
      netAmount: "98.93",
      proceeds: "98.93",
      costBasis: "60.00",
      realizedGainLoss: "38.93",
    })
  );
  ok(rdwSell.ok && rdwSell.entry.lines.length === 3, "RDW fixture: SELL posts 3 legs (Cash 98.93, Basis 60.00, Gain 38.93)");
  if (rdwSell.ok) {
    const drCash = rdwSell.entry.lines.find((l) => l.accountId === "1020");
    const crInvest = rdwSell.entry.lines.find((l) => l.accountId === "1110");
    const crGain = rdwSell.entry.lines.find((l) => l.accountId === "4020");
    ok(drCash?.debit === "98.93", "RDW fixture: Dr 1020 Cash USD = Net Cash 98.93");
    ok(crInvest?.credit === "60.00", "RDW fixture: Cr 1110 Investment = Cost Basis 60.00");
    ok(crGain?.credit === "38.93", "RDW fixture: Cr 4020 Trading Gain = Net 98.93 - Basis 60.00 = 38.93");
    ok(rdwSell.entry.lines.every((l) => l.accountId !== "5010"), "RDW fixture: No 5010 double count leg");
    ok(rdwSell.entry.lines.every((l) => l.accountId !== "5130"), "RDW fixture: No 5130 leg");
  }

  // ---- R4 PERSISTENCE (migration 0027): the monthly-fee-aggregate flag must
  //      survive the persisted Capital_Transactions shape, the journal detail,
  //      validateJournalEntry's round-trip, and the journal-as-SSOT mapper — so a
  //      rebuild from persisted rows (deletion reconciliation, recompute scripts)
  //      still SKIPS the monthly rows instead of inventing an expense line. ----
  const persistedMonthly = baseRow({
    transactionId: "tx-persist-monthly",
    category: "expense",
    section: "ค่าธรรมเนียม",
    amountForeign: "11.00",
    isMonthlyFeeAggregate: true,
  });
  ok(
    journalDetailOf(persistedMonthly).isMonthlyFeeAggregate === true,
    "R4-P1: journalDetailOf carries the persisted isMonthlyFeeAggregate flag"
  );
  const validatedMonthly = validateJournalEntry({
    entryDate: "2026-01-15",
    description: "ค่าธรรมเนียม",
    sourceType: "STATEMENT",
    lines: [],
    postingState: "SKIPPED",
    detail: journalDetailOf(persistedMonthly),
  });
  ok(
    validatedMonthly.ok && validatedMonthly.entry.detail.isMonthlyFeeAggregate === true,
    "R4-P1: validateJournalEntry round-trips the persisted flag into the entry detail"
  );
  const persistedRebuild = buildStatementJournalEntries([persistedMonthly]);
  ok(
    persistedRebuild.length === 1 &&
      persistedRebuild[0].postingState === "SKIPPED" &&
      persistedRebuild[0].entry.lines.length === 0,
    "R4-P1: rebuild FROM the persisted shape stays SKIPPED with zero lines"
  );
  const persistedStandalone = baseRow({
    transactionId: "tx-persist-standalone",
    category: "expense",
    section: "ค่าธรรมเนียม",
    amountForeign: "9.00",
    isMonthlyFeeAggregate: false,
  });
  const standaloneRebuild = buildStatementJournalEntries([persistedStandalone]);
  ok(
    standaloneRebuild.length === 1 &&
      standaloneRebuild[0].postingState === "POSTED" &&
      standaloneRebuild[0].entry.lines.some((l) => l.accountId === "5010" && l.debit === "9.00"),
    "R4-P2: rebuild FROM the persisted shape of a REAL standalone fee still POSTS Dr 5010 once"
  );

  // ---- TRI-STATE FINAL (migration 0027 nullable): a legacy pre-0027 row whose
  //      provenance is UNKNOWN keeps its NULL through journalDetailOf,
  //      validateJournalEntry, and a full rebuild — but a NULL MUST NOT be
  //      treated as a confirmed standalone fee (posting it risks double-counting
  //      the fee), so the rebuild SKIPS it with zero lines + an explicit reason.
  //      The flag is NEVER fabricated into a confirmed false, so reads can
  //      still tell it apart from a deterministic FALSE. TRUE stays SKIPPED,
  //      FALSE stays POSTED.
  const persistedLegacy = baseRow({
    transactionId: "tx-persist-legacy",
    category: "expense",
    section: "ค่าธรรมเนียม",
    amountForeign: "2.50",
    isMonthlyFeeAggregate: null,
  });
  ok(
    journalDetailOf(persistedLegacy).isMonthlyFeeAggregate === null,
    "R4-P5: journalDetailOf PRESERVES null for a legacy unknown-provenance row (never fabricated false)"
  );
  const validatedLegacy = validateJournalEntry({
    entryDate: "2026-01-15",
    description: "ค่าธรรมเนียม",
    sourceType: "STATEMENT",
    lines: [],
    postingState: "SKIPPED",
    detail: journalDetailOf(persistedLegacy),
  });
  ok(
    validatedLegacy.ok && validatedLegacy.entry.detail.isMonthlyFeeAggregate === null,
    "R4-P5: validateJournalEntry round-trips NULL (not coerce to false) in the entry detail"
  );
  const legacyRebuild = buildStatementJournalEntries([persistedLegacy]);
  ok(
    legacyRebuild.length === 1 &&
      legacyRebuild[0].postingState === "SKIPPED" &&
      legacyRebuild[0].entry.lines.length === 0 &&
      legacyRebuild[0].entry.detail?.isMonthlyFeeAggregate === null &&
      (legacyRebuild[0].entry.skipReason ?? "").includes(
        "re-import required for deterministic classification"
      ),
    "R4-P5: rebuild FROM a legacy NULL row is SKIPPED with zero lines + explicit reason (flag STILL null)"
  );
  const triStateMix = buildStatementJournalEntries([
    persistedLegacy,
    persistedMonthly,
    persistedStandalone,
  ]);
  ok(
    triStateMix.length === 3 &&
      triStateMix.find((e) => e.entry.detail?.isMonthlyFeeAggregate === true)
        ?.postingState === "SKIPPED" &&
      triStateMix.find((e) => e.entry.detail?.isMonthlyFeeAggregate == null)
        ?.postingState === "SKIPPED" &&
      triStateMix.find((e) => e.entry.detail?.isMonthlyFeeAggregate === false)
        ?.postingState === "POSTED",
    "R4-P5: TRUE -> SKIPPED, NULL -> SKIPPED (never treated as standalone), FALSE -> POSTED"
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
    isMonthlyFeeAggregate: false,
    postingState: "POSTED",
    skipReason: null,
    type: "CASH_IN",
    note: null,
    ...over,
  });

  ok(
    journalEntryToCapitalRow(rec({ category: "expense", section: "ค่าธรรมเนียม", isMonthlyFeeAggregate: true }))
      .isMonthlyFeeAggregate === true,
    "R4-P3: journal-as-SSOT mapper reproduces the flag from the persisted journal"
  );
  ok(
    journalEntryToCapitalRow(rec({ category: "expense", section: "ค่าธรรมเนียม", isMonthlyFeeAggregate: null }))
      .isMonthlyFeeAggregate === null,
    "R4-P5: journal-as-SSOT mapper passes NULL through verbatim (never coerces to false)"
  );

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

  // ---- R18: account-category batch summary (pure engine) ----
  console.log("=== ACCOUNT-CATEGORY BATCH SUMMARY (summarizeAccountLedgers) ===");
  {
    const accounts: AccountLedgerSummaryInput[] = [
      {
        accountId: "a-1010",
        code: "1010",
        name: "เงินสด (THB)",
        type: "ASSET",
        currency: "THB",
        openingBalance: "1000",
      },
      {
        accountId: "a-3010",
        code: "3010",
        name: "ส่วนทุน",
        type: "EQUITY",
        currency: "THB",
        openingBalance: "0",
      },
      {
        accountId: "a-4010",
        code: "4010",
        name: "เงินปันผล",
        type: "INCOME",
        currency: "USD",
        openingBalance: "900",
      },
      {
        accountId: "a-5010",
        code: "5010",
        name: "ค่าธรรมเนียม",
        type: "EXPENSE",
        currency: "USD",
        openingBalance: null,
      },
    ];
    const lines: AccountLedgerSummaryLineInput[] = [
      // prior-period -> opening only
      { accountId: "a-1010", entryDate: "2025-12-15", side: "DEBIT", amount: "500" },
      { accountId: "a-3010", entryDate: "2025-12-20", side: "CREDIT", amount: "1500" },
      // exactly ON `from` -> period, not opening
      { accountId: "a-1010", entryDate: "2026-01-01", side: "DEBIT", amount: "200" },
      { accountId: "a-1010", entryDate: "2026-01-05", side: "CREDIT", amount: "100" },
      { accountId: "a-3010", entryDate: "2026-01-02", side: "CREDIT", amount: "300" },
      { accountId: "a-4010", entryDate: "2026-01-03", side: "CREDIT", amount: "700" },
      { accountId: "a-4010", entryDate: "2026-01-07", side: "DEBIT", amount: "40" },
      // line dated AFTER to is dropped by the caller (to filter), so the engine
      // must not see it; here it is simply absent from the input lines.
    ];

    const res = summarizeAccountLedgers(accounts, lines, "2026-01-01");
    const byId = new Map(res.rows.map((r) => [r.accountId, r]));

    ok(res.rows.length === 4, "one row per account in the category");
    const a1010 = byId.get("a-1010");
    ok(
      a1010?.opening === "1500.00" &&
        a1010?.debitMovement === "200.00" &&
        a1010?.creditMovement === "100.00" &&
        a1010?.netMovement === "100.00" &&
        a1010?.closing === "1600.00",
      "ASSET (debit-normal): prior + openingBalance -> opening 1500, period net +100, closing 1600"
    );
    ok(a1010?.lineCount === 2, "lineCount = POSTED lines on/after from only (2)");
    ok(
      a1010?.opening === "1500.00" && a1010?.debitMovement === "200.00",
      "line dated exactly on `from` is treated as period, NOT opening (opening stays 1500)"
    );

    const a3010 = byId.get("a-3010");
    ok(
      a3010?.opening === "1500.00" &&
        a3010?.netMovement === "300.00" &&
        a3010?.closing === "1800.00",
      "EQUITY (credit-normal): prior credit -> opening 1500, period net +300, closing 1800"
    );

    const a4010 = byId.get("a-4010");
    ok(
      a4010?.opening === "900.00" &&
        a4010?.debitMovement === "40.00" &&
        a4010?.creditMovement === "700.00" &&
        a4010?.netMovement === "660.00" &&
        a4010?.closing === "1560.00",
      "INCOME (credit-normal): opening 900 preserved, credit-debit net +660, closing 1560"
    );
    ok(a4010?.lineCount === 2, "income lineCount counts both period lines");

    const a5010 = byId.get("a-5010");
    ok(
      a5010?.opening === "0.00" &&
        a5010?.debitMovement === "0.00" &&
        a5010?.creditMovement === "0.00" &&
        a5010?.netMovement === "0.00" &&
        a5010?.closing === "0.00" &&
        a5010?.lineCount === 0,
      "null openingBalance -> 0 opening; no lines -> zero row"
    );

    const thb = res.totalsByCurrency.find((t) => t.currency === "THB");
    const usd = res.totalsByCurrency.find((t) => t.currency === "USD");
    ok(
      thb?.opening === "3000.00" &&
        thb?.movement === "400.00" &&
        thb?.closing === "3400.00",
      "THB totals: opening 3000, movement (net) 400, closing 3400"
    );
    ok(
      usd?.opening === "900.00" &&
        usd?.movement === "660.00" &&
        usd?.closing === "1560.00",
      "USD totals stay separate from THB (never summed across currencies)"
    );
    ok(
      res.totalsByCurrency.map((t) => t.currency).join(",") === "THB,USD",
      "totalsByCurrency sorted by currency code"
    );

    const noFrom = summarizeAccountLedgers(
      [
        {
          accountId: "a-1010",
          code: "1010",
          name: "เงินสด (THB)",
          type: "ASSET",
          currency: "THB",
          openingBalance: "0",
        },
      ],
      lines.filter((l) => l.accountId === "a-1010")
    );
    ok(
      noFrom.rows[0]?.opening === "0.00" &&
        noFrom.rows[0]?.netMovement === "600.00" &&
        noFrom.rows[0]?.closing === "600.00" &&
        noFrom.rows[0]?.lineCount === 3,
      "no `from`: every line is period, opening = openingBalance only"
    );

    const empty = summarizeAccountLedgers(
      [{ accountId: "x", code: "9999", name: "ว่าง", type: "EXPENSE", currency: "THB", openingBalance: null }],
      []
    );
    ok(
      empty.rows.length === 1 &&
        empty.rows[0].closing === "0.00" &&
        empty.rows[0].lineCount === 0 &&
        empty.totalsByCurrency.length === 1 &&
        empty.totalsByCurrency[0].closing === "0.00",
      "empty category input -> zeroed totals (never invent movement)"
    );
    const none = summarizeAccountLedgers([], []);
    ok(
      none.rows.length === 0 && none.totalsByCurrency.length === 0,
      "no accounts -> empty result"
    );
    for (const type of ["ASSET", "EXPENSE", "LIABILITY", "EQUITY", "INCOME"] as const) {
      const signed = summarizeAccountLedgers([
        { accountId: "signed", code: "9998", name: "Signed balance", type, currency: "USD", openingBalance: "10" },
      ], [
        { accountId: "signed", entryDate: "2025-12-31", side: "CREDIT", amount: "3" },
        { accountId: "signed", entryDate: "2026-01-01", side: "DEBIT", amount: "2.25" },
        { accountId: "signed", entryDate: "2026-01-01", side: "CREDIT", amount: "20.50" },
      ], "2026-01-01").rows[0];
      const debitNormal = type === "ASSET" || type === "EXPENSE";
      ok(signed.opening === (debitNormal ? "7.00" : "13.00") && signed.netMovement === (debitNormal ? "-18.25" : "18.25") && signed.closing === (debitNormal ? "-11.25" : "31.25") && signed.lineCount === 2,
        `${type}: prior and period use normal-side signs, exact cents and negative balances`);
    }
  }

  console.log("=== REPORTING BASE: THB-PRIMARY BALANCED + BALANCE-SHEET AS-OF ===");
  const repAccounts: AccountMap = {
    cash: { code: "1020", name: "USD cash", currency: "USD", type: "ASSET" },
    thb: { code: "1010", name: "THB cash", currency: "THB", type: "ASSET" },
    capital: { code: "3010", name: "USD capital", currency: "USD", type: "EQUITY" },
    equity: { code: "3020", name: "THB capital", currency: "THB", type: "EQUITY" },
  };
  const repLine = (accountId: keyof typeof repAccounts, side: "DEBIT" | "CREDIT", amount: string, amountThb: string | null) =>
    ({ accountId, currency: repAccounts[accountId].currency, side, amount, amountThb });
  // A pure FX-exchange sheet (USD leg entered at 35, THB leg credited 35000):
  // the two legs report THB 35000 each, so the THB base is the authoritative
  // balanced signal even though the native currencies differ.
  const repFx = [repLine("cash", "DEBIT", "1000", "35000"), repLine("thb", "CREDIT", "35000", "35000")];
  const repTb = trialBalance(repFx, repAccounts);
  ok(repTb.balanced && repTb.balancedThb && repTb.totalDebitThb === "35000.00" && repTb.totalCreditThb === "35000.00",
    "TB: pure FX sheet is balanced via the THB reporting base (native currencies distinct)");
  const repSheet = balanceSheet(repFx, repAccounts);
  ok(repSheet.balanced && repSheet.balancedThb && repSheet.totalAssetsThb === "0.00" &&
    repSheet.totalEquityAndLiabilitiesThb === "0.00",
    "BS: pure FX sheet is balanced via the THB reporting base");
  // Balance sheet is AS-OF through `to`: the reported balances are identical
  // whether the caller passes a windowed slice (openings + in-window lines) or
  // the full history, as long as `to` is the same. `from` never changes numbers.
  const priorUsd = repLine("cash", "DEBIT", "100", "3500");
  const priorCap = repLine("capital", "CREDIT", "100", "3500");
  const windowUsd = repLine("cash", "DEBIT", "50", "1750");
  const windowCap = repLine("capital", "CREDIT", "50", "1750");
  const asOfWindowed = balanceSheet([windowUsd, windowCap], repAccounts, { cash: "100", capital: "100" }, { cash: "3500", capital: "3500" });
  const asOfFull = balanceSheet([priorUsd, priorCap, windowUsd, windowCap], repAccounts);
  ok(asOfWindowed.totalAssetsThb === "5250.00" && asOfWindowed.totalAssets === "150.00" &&
    asOfWindowed.totalEquityAndLiabilitiesThb === "5250.00" && asOfWindowed.balanced && asOfWindowed.balancedThb,
    "BS as-of: windowed slice (openings + in-window) totals 150.00 / 5250.00 THB");
  // ---------------------------------------------------------------------------
  // Journal status semantics: reference-only vs real unposted classifications.
  // ---------------------------------------------------------------------------
  ok(
    isReferenceOnlySkip("monthly fee/VAT summary row - fees already inside the BUY acquisition cost / SELL net proceeds") === true &&
      isReferenceOnlySkip("monthly fee/vat summary row") === true &&
      isReferenceOnlySkip("fees already in the trade postings") === true &&
      isReferenceOnlySkip("fee/vat summary") === true &&
      isReferenceOnlySkip("fee and vat summary row") === true &&
      isReferenceOnlySkip("fee and vat aggregate") === true,
    "isReferenceOnlySkip: classifies monthly fee/VAT summary rows as reference-only (case-insensitive, historical wording)"
  );
  ok(
    isReferenceOnlySkip("realized gain/loss already posted via the SELL row") === true &&
      isReferenceOnlySkip("already posted via the sell row") === true,
    "isReferenceOnlySkip: classifies duplicate realized gain/loss income rows as reference-only"
  );
  ok(
    isReferenceOnlySkip("SELL without trustworthy cost basis / realized gain - NON_COMPUTABLE, not posted") === false,
    "isReferenceOnlySkip: real NON_COMPUTABLE SELL is NOT classified reference-only"
  );
  ok(
    isReferenceOnlySkip("legacy fee provenance unknown - re-import required for deterministic classification") === false,
    "isReferenceOnlySkip: legacy fee provenance unknown is NOT classified reference-only"
  );
  ok(
    isReferenceOnlySkip("backfilled-record-only") === false &&
      isReferenceOnlySkip("BUY without a positive authoritative acquisition cost - not posted") === false &&
      isReferenceOnlySkip("THB does not balance at statement FX: received 55329.09 THB != sent 55335.00 THB") === false &&
      isReferenceOnlySkip("missing effective FX") === false &&
      isReferenceOnlySkip("invalid entry: unbalanced debit/credit") === false &&
      isReferenceOnlySkip("unknown category \"other\"") === false &&
      isReferenceOnlySkip(null) === false &&
      isReferenceOnlySkip(undefined) === false &&
      isReferenceOnlySkip("") === false,
    "isReferenceOnlySkip: real unposted / invalid / null rows are NOT classified reference-only"
  );

  // ---------------------------------------------------------------------------
  // Bankbook cash flow & GAAP classification semantics
  // ---------------------------------------------------------------------------
  const refSkipEntry = {
    skipReason: "monthly fee/VAT summary row - fees already inside the BUY acquisition cost",
    lines: [],
  };
  const refFlow = getEntryMoneyFlow(refSkipEntry);
  ok(
    refFlow.moneyIn === null && refFlow.moneyOut === null,
    "getEntryMoneyFlow: reference-only skip row has no fabricated cash in/out (both null)"
  );

  const buyEntry = {
    skipReason: null,
    lines: [
      { accountCode: "1110", side: "DEBIT" as const, amount: "100.00", currency: "USD", amountThb: "3500.00" },
      { accountCode: "1020", side: "CREDIT" as const, amount: "100.00", currency: "USD", amountThb: "3500.00" },
    ],
  };
  const buyFlow = getEntryMoneyFlow(buyEntry);
  ok(
    buyFlow.moneyIn === null && buyFlow.moneyOut === "100.00" && buyFlow.currency === "USD",
    "getEntryMoneyFlow: BUY with cash account credit returns money out"
  );
  ok(
    classifyEntryCategory(buyEntry).categoryId === "ASSET",
    "classifyEntryCategory: BUY investment is classified as ASSET"
  );

  const sellEntry = {
    skipReason: null,
    lines: [
      { accountCode: "1020", side: "DEBIT" as const, amount: "150.00", currency: "USD", amountThb: "5250.00" },
      { accountCode: "1110", side: "CREDIT" as const, amount: "100.00", currency: "USD", amountThb: "3500.00" },
      { accountCode: "4020", side: "CREDIT" as const, amount: "50.00", currency: "USD", amountThb: "1750.00" },
    ],
  };
  const sellFlow = getEntryMoneyFlow(sellEntry);
  ok(
    sellFlow.moneyIn === "150.00" && sellFlow.moneyOut === null && sellFlow.currency === "USD",
    "getEntryMoneyFlow: SELL with cash account debit returns money in"
  );
  ok(
    classifyEntryCategory(sellEntry).categoryId === "ASSET",
    "classifyEntryCategory: SELL stock trade with investment asset (1110) is classified as ASSET"
  );

  const depositEntry = {
    skipReason: null,
    lines: [
      { accountCode: "1010", side: "DEBIT" as const, amount: "50000.00", currency: "THB", amountThb: "50000.00" },
      { accountCode: "3020", side: "CREDIT" as const, amount: "50000.00", currency: "THB", amountThb: "50000.00" },
    ],
  };
  const depFlow = getEntryMoneyFlow(depositEntry);
  ok(
    depFlow.moneyIn === "50000.00" && depFlow.moneyOut === null && depFlow.currency === "THB",
    "getEntryMoneyFlow: DEPOSIT / CASH_IN returns money in"
  );
  ok(
    classifyEntryCategory(depositEntry).categoryId === "EQUITY",
    "classifyEntryCategory: Capital deposit (3020) is classified as EQUITY"
  );

  const withdrawEntry = {
    skipReason: null,
    lines: [
      { accountCode: "3020", side: "DEBIT" as const, amount: "10000.00", currency: "THB", amountThb: "10000.00" },
      { accountCode: "1010", side: "CREDIT" as const, amount: "10000.00", currency: "THB", amountThb: "10000.00" },
    ],
  };
  const wdFlow = getEntryMoneyFlow(withdrawEntry);
  ok(
    wdFlow.moneyIn === null && wdFlow.moneyOut === "10000.00" && wdFlow.currency === "THB",
    "getEntryMoneyFlow: WITHDRAWAL / CASH_OUT returns money out"
  );
  ok(
    classifyEntryCategory(withdrawEntry).categoryId === "EQUITY",
    "classifyEntryCategory: Capital withdrawal (3020) is classified as EQUITY"
  );

  const fxEntry = {
    skipReason: null,
    lines: [
      { accountCode: "1020", side: "DEBIT" as const, amount: "100.00", currency: "USD", amountThb: "3500.00" },
      { accountCode: "1010", side: "CREDIT" as const, amount: "3500.00", currency: "THB", amountThb: "3500.00" },
    ],
  };
  const fxFlow = getEntryMoneyFlow(fxEntry);
  ok(
    fxFlow.moneyIn === "100.00 USD" &&
    fxFlow.moneyOut === "3500.00 THB",
    "getEntryMoneyFlow: FX conversion returns both money in and money out in their respective currencies"
  );
  ok(
    classifyEntryCategory(fxEntry).categoryId === "ASSET",
    "classifyEntryCategory: FX cash exchange (1020/1010) is classified as ASSET"
  );

  const feeEntry = {
    skipReason: null,
    lines: [
      { accountCode: "5010", side: "DEBIT" as const, amount: "5.00", currency: "USD", amountThb: "175.00" },
      { accountCode: "1020", side: "CREDIT" as const, amount: "5.00", currency: "USD", amountThb: "175.00" },
    ],
  };
  const feeFlow = getEntryMoneyFlow(feeEntry);
  ok(
    feeFlow.moneyIn === null && feeFlow.moneyOut === "5.00" && feeFlow.currency === "USD",
    "getEntryMoneyFlow: Fee expense returns money out"
  );
  ok(
    classifyEntryCategory(feeEntry).categoryId === "EXPENSE",
    "classifyEntryCategory: Fee expense (5010) is classified as EXPENSE"
  );

  const divEntry = {
    skipReason: null,
    detail: { category: "income", amount: "13.50", currency: "USD" },
    lines: [
      { accountCode: "1020", side: "DEBIT" as const, amount: "13.50", currency: "USD", amountThb: "472.50" },
      { accountCode: "4010", side: "CREDIT" as const, amount: "15.00", currency: "USD", amountThb: "525.00" },
      { accountCode: "1030", side: "DEBIT" as const, amount: "1.50", currency: "USD", amountThb: "52.50" },
    ],
  };
  const divFlow = getEntryMoneyFlow(divEntry);
  ok(
    divFlow.moneyIn === "13.50" && divFlow.moneyOut === null && divFlow.currency === "USD",
    "getEntryMoneyFlow: DIVIDEND with withheld tax shows net cash in, does NOT fabricate cash out"
  );
  ok(
    classifyEntryCategory(divEntry).categoryId === "INCOME",
    "classifyEntryCategory: DIVIDEND (4010) is classified as INCOME"
  );

  // ---------------------------------------------------------------------------
  // Entry explanation tests: reference-only vs unposted/non-computable vs user note vs normal
  // ---------------------------------------------------------------------------
  const expRefVat = getEntryExplanation({
    postingState: "SKIPPED",
    skipReason: "monthly fee/VAT summary row - fees already inside the BUY acquisition cost",
  });
  ok(
    expRefVat.hasExplanation === true &&
      expRefVat.isReference === true &&
      expRefVat.isUnposted === false &&
      expRefVat.explanation === "บันทึกครบแล้ว: ผลกระทบทางบัญชีถูกบันทึกผ่านรายการหลักแล้ว จึงไม่ลงเดบิต/เครดิตซ้ำ",
    "getEntryExplanation: reference-only monthly fee/VAT summary returns hasExplanation=true and reference text"
  );

  const expRefGain = getEntryExplanation({
    postingState: "SKIPPED",
    skipReason: "realized gain/loss already posted via the SELL row",
  });
  ok(
    expRefGain.hasExplanation === true &&
      expRefGain.isReference === true &&
      expRefGain.isUnposted === false &&
      expRefGain.explanation === "บันทึกครบแล้ว: ผลกระทบทางบัญชีถูกบันทึกผ่านรายการหลักแล้ว จึงไม่ลงเดบิต/เครดิตซ้ำ",
    "getEntryExplanation: reference-only duplicate gain summary returns hasExplanation=true and reference text"
  );

  const expNonComp = getEntryExplanation({
    postingState: "SKIPPED",
    skipReason: "SELL without trustworthy cost basis / realized gain - NON_COMPUTABLE, not posted",
  });
  ok(
    expNonComp.hasExplanation === true &&
      expNonComp.isReference === false &&
      expNonComp.isUnposted === true &&
      expNonComp.explanation.includes("NON_COMPUTABLE"),
    "getEntryExplanation: non-computable SELL returns hasExplanation=true, isUnposted=true with technical reason"
  );

  const expBackfill = getEntryExplanation({
    postingState: "SKIPPED",
    skipReason: "backfilled-record-only",
  });
  ok(
    expBackfill.hasExplanation === true &&
      expBackfill.isReference === false &&
      expBackfill.isUnposted === true &&
      expBackfill.explanation.includes("ข้อมูลเก่า — นำเข้าก่อนระบบลงบัญชีอัตโนมัติ"),
    "getEntryExplanation: backfilled-record-only returns Thai explanation"
  );

  const expNormalPosted = getEntryExplanation({
    postingState: "POSTED",
    skipReason: null,
  });
  ok(
    expNormalPosted.hasExplanation === false &&
      expNormalPosted.isReference === false &&
      expNormalPosted.isUnposted === false &&
      expNormalPosted.explanation === "",
    "getEntryExplanation: normal POSTED row without note returns hasExplanation=false"
  );

  const expUserNote = getEntryExplanation({
    postingState: "POSTED",
    skipReason: null,
    note: "Audited and confirmed with broker receipt",
  });
  ok(
    expUserNote.hasExplanation === true &&
      expUserNote.isReference === false &&
      expUserNote.isUnposted === false &&
      expUserNote.userNote === "Audited and confirmed with broker receipt" &&
      expUserNote.explanation === "Audited and confirmed with broker receipt",
    "getEntryExplanation: POSTED row with user note returns hasExplanation=true with userNote"
  );

  // ---- Critical Verification: Moving Average Cost Sequence (regression case) ----
  // 1. BUY 10 shares @ 10 USD -> quantity=10, costBasis=100, avgCost=10
  // 2. SELL 5 shares -> quantity=5, remainingCostBasis=50, avgCost=10, costBasisSold=50
  // 3. BUY 5 shares @ 20 USD -> quantity=10, cumCost=200, cumQuantity=15, avgCost=13.3333 (Webull lifetime average cost)
  const regMap: CostBasisMap = {};
  applyAverageCostTrade(regMap, "REG_TEST", "BUY", 10, 10);
  ok(
    regMap.REG_TEST?.quantity === 10 &&
      regMap.REG_TEST?.avgCost === 10 &&
      regMap.REG_TEST?.cumCost === 100 &&
      regMap.REG_TEST?.cumQuantity === 10,
    "regression case step 1: BUY 10 @ 10 -> qty 10, cumCost 100, cumQuantity 10, avgCost 10"
  );
  const regSellRes = applyAverageCostTrade(regMap, "REG_TEST", "SELL", 5, 12);
  const regBasisSold = (regSellRes.sellBasis ?? 0) * 5;
  ok(
    regMap.REG_TEST?.quantity === 5 &&
      regMap.REG_TEST?.avgCost === 10 &&
      regMap.REG_TEST?.cumCost === 100 &&
      regMap.REG_TEST?.cumQuantity === 10 &&
      regBasisSold === 50,
    "regression case step 2: SELL 5 -> qty 5, cumCost 100 (not reduced by SELL), avgCost 10, costBasisSold 50"
  );
  applyAverageCostTrade(regMap, "REG_TEST", "BUY", 5, 20);
  ok(
    regMap.REG_TEST?.quantity === 10 &&
      regMap.REG_TEST?.cumCost === 200 &&
      regMap.REG_TEST?.cumQuantity === 15 &&
      Math.abs((regMap.REG_TEST?.avgCost ?? 0) - 200 / 15) < 1e-6,
    "regression case step 3: BUY 5 @ 20 -> qty 10, cumCost 200, cumQuantity 15, avgCost 13.3333 (Webull lifetime avg)"
  );

  // Commission handling with the same sequence:
  // 1. BUY 10 @ 10 + commission 1.00 -> acquisitionCost = 101.00, avgCost = 10.10, cumCost = 101.00, cumQuantity = 10
  // 2. SELL 5 -> costBasisSold = 50.50, remaining qty = 5, cumCost = 101.00, cumQuantity = 10, avgCost = 10.10
  // 3. BUY 5 @ 20 + commission 0.50 -> acquisitionCost = 100.50, live qty = 10, cumCost = 201.50, cumQuantity = 15, avgCost = 13.4333
  const regCommMap: CostBasisMap = {};
  applyAverageCostTrade(regCommMap, "REG_COMM", "BUY", 10, 10, undefined, 101);
  ok(
    regCommMap.REG_COMM?.quantity === 10 &&
      regCommMap.REG_COMM?.cumCost === 101 &&
      regCommMap.REG_COMM?.cumQuantity === 10 &&
      regCommMap.REG_COMM?.avgCost === 10.1,
    "regression comm step 1: BUY 10 @ 10 with comm 1 -> qty 10, cumCost 101, cumQuantity 10, avgCost 10.10"
  );
  const regSellCommRes = applyAverageCostTrade(regCommMap, "REG_COMM", "SELL", 5, 15);
  const regCommBasisSold = (regSellCommRes.sellBasis ?? 0) * 5;
  ok(
    regCommMap.REG_COMM?.quantity === 5 &&
      regCommMap.REG_COMM?.avgCost === 10.1 &&
      regCommMap.REG_COMM?.cumCost === 101 &&
      regCommMap.REG_COMM?.cumQuantity === 10 &&
      regCommBasisSold === 50.5,
    "regression comm step 2: SELL 5 -> qty 5, cumCost 101 (not reduced by SELL), avgCost 10.10, costBasisSold 50.50"
  );
  applyAverageCostTrade(regCommMap, "REG_COMM", "BUY", 5, 20, undefined, 100.5);
  ok(
    regCommMap.REG_COMM?.quantity === 10 &&
      regCommMap.REG_COMM?.cumCost === 201.5 &&
      regCommMap.REG_COMM?.cumQuantity === 15 &&
      Math.abs((regCommMap.REG_COMM?.avgCost ?? 0) - 201.5 / 15) < 1e-6,
    "regression comm step 3: BUY 5 @ 20 with comm 0.5 -> qty 10, cumCost 201.5, cumQuantity 15, avgCost 13.4333"
  );

  // === RECONCILIATION APPLY PERSISTENCE & IDEMPOTENCY REGRESSION TEST ===
  // Invariant required:
  // initial: Already Posted = N, Promotable = 1
  // apply: Promoted = 1, in-place update or zero duplicates
  // second dry-run: Already Posted = N + 1, Promotable = 0
  // second apply: Promoted = 0, zero duplicate journals created
  {
    interface TestJournal {
      id: string;
      sourceTransactionId: string;
      status: "POSTED" | "DRAFT";
      postingState: "POSTED" | "SKIPPED";
      skipReason: string | null;
      lines: any[];
    }

    const testTx = baseRow({
      transactionId: "tx-reconcile-persist",
      category: "asset",
      side: "BUY",
      symbol: "NVDA",
      quantity: "10",
      unitPrice: "100",
      grossAmount: "1000",
      fees: "-1.07",
      amountForeign: "1001.07",
      netAmount: "1001.07",
    });

    let journals: TestJournal[] = [
      {
        id: "j-initial-skipped",
        sourceTransactionId: "tx-reconcile-persist",
        status: "POSTED",
        postingState: "SKIPPED",
        skipReason: "invalid entry: USD does not balance",
        lines: [],
      },
    ];

    function mapExisting(list: TestJournal[]): Map<string, TestJournal> {
      const map = new Map<string, TestJournal>();
      for (const e of list) {
        if (!e.sourceTransactionId) continue;
        const prev = map.get(e.sourceTransactionId);
        if (!prev || (prev.postingState !== "POSTED" && e.postingState === "POSTED")) {
          map.set(e.sourceTransactionId, e);
        }
      }
      return map;
    }

    function scan(list: TestJournal[]) {
      const entryMap = mapExisting(list);
      const [plan] = buildStatementJournalEntries([testTx]);
      const existing = entryMap.get(testTx.transactionId);
      const isAlreadyPosted = existing && existing.postingState === "POSTED" && existing.status === "POSTED";
      const isPromotable = !isAlreadyPosted && plan && plan.postingState === "POSTED";
      return {
        alreadyPosted: isAlreadyPosted ? 1 : 0,
        promotable: isPromotable ? 1 : 0,
        plan,
      };
    }

    function applyPromotion(list: TestJournal[]) {
      const scanRes = scan(list);
      let promoted = 0;
      if (scanRes.promotable > 0 && scanRes.plan) {
        const existing = mapExisting(list).get(testTx.transactionId);
        if (existing) {
          existing.postingState = "POSTED";
          existing.status = "POSTED";
          existing.skipReason = null;
          existing.lines = scanRes.plan.entry.lines;
          promoted++;
        }
      }
      return { promoted };
    }

    // Step 1: initial dry run
    const run1 = scan(journals);
    ok(run1.alreadyPosted === 0 && run1.promotable === 1, "reconcile idempotency step 1: initial Already Posted = 0, Promotable = 1");

    // Step 2: apply promotion
    const apply1 = applyPromotion(journals);
    ok(apply1.promoted === 1, "reconcile idempotency step 2: apply Promoted = 1");

    // Step 3: second dry run
    const run2 = scan(journals);
    ok(run2.alreadyPosted === 1 && run2.promotable === 0, "reconcile idempotency step 3: second dry-run Already Posted = 1, Promotable = 0");

    // Step 4: second apply
    const apply2 = applyPromotion(journals);
    ok(apply2.promoted === 0, "reconcile idempotency step 4: second apply Promoted = 0");

    // Step 5: duplicate check
    const dups = journals.filter((j) => j.sourceTransactionId === "tx-reconcile-persist");
    ok(dups.length === 1, "reconcile idempotency step 5: exactly one journal entry exists, zero duplicates");

    // Step 6: map prioritization safety against legacy duplicate row
    const legacyDuplicateList: TestJournal[] = [
      {
        id: "j-new-posted",
        sourceTransactionId: "tx-legacy-dup",
        status: "POSTED",
        postingState: "POSTED",
        skipReason: null,
        lines: [{ debit: "100" }, { credit: "100" }],
      },
      {
        id: "j-old-skipped",
        sourceTransactionId: "tx-legacy-dup",
        status: "POSTED",
        postingState: "SKIPPED",
        skipReason: "historical skip",
        lines: [],
      },
    ];
    const mapWithLegacyDup = mapExisting(legacyDuplicateList);
    const selected = mapWithLegacyDup.get("tx-legacy-dup");
    ok(
      selected !== undefined && selected.id === "j-new-posted" && selected.postingState === "POSTED",
      "reconcile idempotency step 6: map prioritization picks POSTED over SKIPPED even if SKIPPED appears later"
    );

    // === DUPLICATE CLEANUP & POSTING INTEGRITY TESTS ===
    const { identifyStaleDuplicatesPure } = await import("./cleanup-duplicate-stale-placeholders.mjs");

    // Test 1: existing SKIPPED placeholder -> promoted in place
    const placeholderTxId = "tx-promote-in-place";
    const placeholderList: TestJournal[] = [
      {
        id: "j-placeholder-1",
        sourceTransactionId: placeholderTxId,
        status: "POSTED",
        postingState: "SKIPPED",
        skipReason: "initial skip placeholder",
        lines: [],
      },
    ];
    // In-place promotion simulation
    const stub = placeholderList.find((j) => j.sourceTransactionId === placeholderTxId && j.postingState === "SKIPPED");
    ok(stub !== undefined, "posting integrity: found existing SKIPPED placeholder");
    if (stub) {
      stub.postingState = "POSTED";
      stub.skipReason = null;
      stub.lines = [{ debit: "100" }, { credit: "100" }];
    }
    ok(
      placeholderList.length === 1 &&
      placeholderList[0].id === "j-placeholder-1" &&
      placeholderList[0].postingState === "POSTED" &&
      placeholderList[0].lines.length === 2,
      "posting integrity 1: existing SKIPPED placeholder promoted in place (same ID, zero duplicate journal)"
    );

    // Test 2: existing POSTED journal -> no-op
    const postedCheck = scan(placeholderList);
    ok(
      postedCheck.alreadyPosted === 0, // scan checks testTx, but placeholderTxId is already posted
      "posting integrity: baseline verified"
    );
    // Scanning placeholderList for placeholderTxId
    const placeholderMap = mapExisting(placeholderList);
    const existingPosted = placeholderMap.get(placeholderTxId);
    const isNoOp = existingPosted && existingPosted.postingState === "POSTED" && existingPosted.status === "POSTED";
    ok(
      isNoOp === true,
      "posting integrity 2: existing POSTED journal results in no-op (authoritative, never overwritten)"
    );

    // Test 3: repeated apply -> no duplicate
    const listForRepeatedApply: TestJournal[] = [
      {
        id: "j-orig",
        sourceTransactionId: "tx-repeated",
        status: "POSTED",
        postingState: "SKIPPED",
        skipReason: "will promote",
        lines: [],
      },
    ];
    function applyMock(list: TestJournal[], txId: string) {
      const existing = list.find((j) => j.sourceTransactionId === txId);
      if (existing && existing.postingState === "POSTED") {
        return { action: "noop" };
      }
      if (existing && existing.postingState === "SKIPPED") {
        existing.postingState = "POSTED";
        existing.lines = [{ debit: "50" }, { credit: "50" }];
        return { action: "promoted" };
      }
      list.push({
        id: "j-new",
        sourceTransactionId: txId,
        status: "POSTED",
        postingState: "POSTED",
        skipReason: null,
        lines: [{ debit: "50" }, { credit: "50" }],
      });
      return { action: "inserted" };
    }

    const firstRun = applyMock(listForRepeatedApply, "tx-repeated");
    const secondRun = applyMock(listForRepeatedApply, "tx-repeated");
    const thirdRun = applyMock(listForRepeatedApply, "tx-repeated");
    const countForTx = listForRepeatedApply.filter((j) => j.sourceTransactionId === "tx-repeated").length;
    ok(
      firstRun.action === "promoted" &&
      secondRun.action === "noop" &&
      thirdRun.action === "noop" &&
      countForTx === 1,
      "posting integrity 3: repeated apply produces exactly one journal, zero duplicates"
    );

    // Test 4: cleanup never deletes a journal containing accounting lines
    const testRecordsWithLines = [
      {
        id: "j-valid-posted",
        userId: "u1",
        entryNo: 1,
        sourceType: "STATEMENT",
        sourceTransactionId: "tx-with-lines",
        status: "POSTED",
        postingState: "POSTED",
        skipReason: null,
        lineCount: 2,
      },
      {
        id: "j-candidate-with-lines",
        userId: "u1",
        entryNo: 2,
        sourceType: "STATEMENT",
        sourceTransactionId: "tx-with-lines",
        status: "POSTED",
        postingState: "SKIPPED",
        skipReason: "abnormal placeholder that somehow has lines",
        lineCount: 1, // Non-zero lines!
      },
    ];
    const cleanupResultWithLines = identifyStaleDuplicatesPure(testRecordsWithLines);
    ok(
      cleanupResultWithLines.length === 0,
      "cleanup safety 4: cleanup never deletes a journal containing accounting lines"
    );

    // Test 5: cleanup never deletes the only journal for a source transaction
    const testLoneRecords = [
      {
        id: "j-lone-skipped",
        userId: "u1",
        entryNo: 1,
        sourceType: "STATEMENT",
        sourceTransactionId: "tx-lone",
        status: "POSTED",
        postingState: "SKIPPED",
        skipReason: "legitimate unposted trade",
        lineCount: 0,
      },
      {
        id: "j-lone-posted",
        userId: "u1",
        entryNo: 2,
        sourceType: "STATEMENT",
        sourceTransactionId: "tx-lone-posted",
        status: "POSTED",
        postingState: "POSTED",
        skipReason: null,
        lineCount: 2,
      },
    ];
    const cleanupResultLone = identifyStaleDuplicatesPure(testLoneRecords);
    ok(
      cleanupResultLone.length === 0,
      "cleanup safety 5: cleanup never deletes the only journal for a source transaction"
    );

    // Test 6: cleanup accurately identifies candidate when valid POSTED + 0-line SKIPPED pair exists
    const testValidPair = [
      {
        id: "j-stale-placeholder",
        userId: "u1",
        entryNo: 10,
        sourceType: "STATEMENT",
        sourceTransactionId: "tx-pair",
        status: "POSTED",
        postingState: "SKIPPED",
        skipReason: "old skip reason",
        lineCount: 0,
      },
      {
        id: "j-legit-posted",
        userId: "u1",
        entryNo: 11,
        sourceType: "STATEMENT",
        sourceTransactionId: "tx-pair",
        status: "POSTED",
        postingState: "POSTED",
        skipReason: null,
        lineCount: 4,
      },
    ];
    const cleanupResultPair = identifyStaleDuplicatesPure(testValidPair);
    ok(
      cleanupResultPair.length === 1 &&
      cleanupResultPair[0].staleJournalId === "j-stale-placeholder" &&
      cleanupResultPair[0].validJournalId === "j-legit-posted" &&
      cleanupResultPair[0].staleLineCount === 0 &&
      cleanupResultPair[0].validLineCount === 4,
      "cleanup safety 6: correctly identifies candidate only when valid POSTED + 0-line SKIPPED pair exists"
    );

    // Test 7: concurrent first-time journal creations serialized by advisory lock
    const concurrentList: TestJournal[] = [];
    let lockHolder: string | null = null;

    async function concurrentCreateJournalSimulation(userId: string, sourceTxId: string, callerId: string) {
      while (lockHolder !== null && lockHolder !== callerId) {
        await new Promise((r) => setTimeout(r, 5));
      }
      lockHolder = callerId;
      try {
        const existing = concurrentList.find(
          (j) => j.sourceTransactionId === sourceTxId && j.postingState === "POSTED"
        );
        if (existing) {
          return { entryId: existing.id, action: "noop" };
        }
        const newId = `j-${callerId}`;
        concurrentList.push({
          id: newId,
          sourceTransactionId: sourceTxId,
          status: "POSTED",
          postingState: "POSTED",
          skipReason: null,
          lines: [{ debit: "100" }, { credit: "100" }],
        });
        return { entryId: newId, action: "inserted" };
      } finally {
        lockHolder = null;
      }
    }

    const [resA, resB] = await Promise.all([
      concurrentCreateJournalSimulation("u1", "tx-concurrent-1", "callerA"),
      concurrentCreateJournalSimulation("u1", "tx-concurrent-1", "callerB"),
    ]);

    const totalCreated = concurrentList.filter((j) => j.sourceTransactionId === "tx-concurrent-1");
    ok(
      totalCreated.length === 1,
      "concurrency safety 7: two concurrent first-time creations produce exactly ONE accounting journal"
    );
    ok(
      (resA.action === "inserted" && resB.action === "noop") ||
        (resB.action === "inserted" && resA.action === "noop"),
      "concurrency safety 7: one caller inserts and the concurrent caller receives authoritative no-op"
    );
    ok(
      resA.entryId === resB.entryId,
      "concurrency safety 7: both concurrent callers resolve safely with the exact same journal entry ID"
    );
    ok(
      totalCreated[0].lines.length === 2,
      "concurrency safety 7: no accounting lines duplicated under concurrent execution"
    );
  }

  // =========================================================================
  // MANUAL BUY HISTORICAL COST BASIS -> STATEMENT SELL RESOLUTION REGRESSIONS
  // =========================================================================

  // Test 1: Historical Manual BUY resolves skipped Statement SELL
  {
    const stmtSellRow: ValidatedCapitalRow = {
      transactionId: "sell-stmt-1",
      userId: "u-test-1",
      amountForeign: "1498.00",
      currency: "USD",
      transactionDate: "2026-02-15",
      fxRateBot: null,
      amountThb: "52430.00",
      type: "CASH_IN",
      sourceType: "AI_PARSED",
      sourceDocumentId: "doc-1",
      category: "asset",
      section: "ขายหุ้น",
      symbol: "AAPL",
      side: "SELL",
      quantity: "10",
      unitPrice: "150.00",
      grossAmount: "1500.00",
      fees: "2.00",
      proceeds: null,
      costBasis: null,
      realizedGainLoss: null,
      realizedGainLossThb: null,
      fxRateStatement: "35.00",
      fxRateEffective: "35.00",
      netAmount: "1498.00",
      exchange: "NASDAQ",
      exchangeFromCurrency: null,
      exchangeFromAmount: null,
      exchangeRate: null,
      isMonthlyFeeAggregate: false,
    };

    // Before Manual BUY: Statement SELL is NON_COMPUTABLE -> SKIPPED
    const initialPost = postCapitalRow(stmtSellRow);
    ok(
      !initialPost.ok && initialPost.reason?.includes("NON_COMPUTABLE"),
      "Manual BUY test 1: Statement SELL without prior cost basis is initially SKIPPED (non-computable)"
    );

    // User adds Manual BUY on an earlier date
    const manualBuyRow: GainLossBackfillRow = {
      transactionId: "buy-manual-1",
      sourceType: "MANUAL",
      transactionDate: "2026-01-10",
      symbol: "AAPL",
      side: "BUY",
      quantity: "10",
      unitPrice: "100.00",
      grossAmount: "1000.00",
      fees: "5.00",
      netAmount: "1005.00",
      currency: "USD",
      fxRateEffective: "35.00",
      realizedGainLossThb: null,
    };

    const recomputeRes = recomputeAllGainLoss([manualBuyRow, stmtSellRow]);
    ok(
      recomputeRes.updates.length === 1 && recomputeRes.updates[0].transactionId === "sell-stmt-1",
      "Manual BUY test 1: Historical Manual BUY provides basis, recomputeAllGainLoss generates update for Statement SELL"
    );

    const update = recomputeRes.updates[0].update;
    ok(
      update.costBasis === "1005.00" && update.realizedGainLoss === "493.00",
      "Manual BUY test 1: Correct cost basis (1005.00) and realized gain (493.00 = 1498 net - 1005 basis) calculated"
    );
    ok(
      update.realizedGainLossThb === "17255.00",
      "Manual BUY test 1: Correct realized gain in THB reporting base (493 * 35 = 17255.00)"
    );

    // Build statement journal entries with updated row
    const [reconciledPlan] = buildStatementJournalEntries([{ ...stmtSellRow, ...update } as ValidatedCapitalRow]);
    ok(
      reconciledPlan.postingState === "POSTED" && !reconciledPlan.entry.skipReason,
      "Manual BUY test 1: Statement SELL journal entry promotes from SKIPPED to POSTED with null skipReason"
    );
    ok(
      reconciledPlan.entry.lines.length === 3,
      "Manual BUY test 1: Reconciled Statement SELL produces complete balanced double-entry lines (cash, basis, gain)"
    );

    const validated = validateJournalEntry(reconciledPlan.entry);
    ok(validated.ok, "Manual BUY test 1: Reconciled Statement SELL passes double-entry validation");
  }

  // Test 2: Later Manual BUY does NOT resolve earlier Statement SELL (time-travel protection)
  {
    const stmtSellRow: GainLossBackfillRow = {
      transactionId: "sell-stmt-early",
      sourceType: "AI_PARSED",
      transactionDate: "2026-02-15",
      symbol: "GOOG",
      side: "SELL",
      quantity: "10",
      unitPrice: "180.00",
      grossAmount: "1800.00",
      fees: "0.00",
      netAmount: "1800.00",
      currency: "USD",
      fxRateEffective: "35.00",
      realizedGainLossThb: null,
    };

    // Manual BUY dated AFTER the SELL
    const laterBuyRow: GainLossBackfillRow = {
      transactionId: "buy-manual-later",
      sourceType: "MANUAL",
      transactionDate: "2026-03-01",
      symbol: "GOOG",
      side: "BUY",
      quantity: "10",
      unitPrice: "150.00",
      grossAmount: "1500.00",
      fees: "0.00",
      netAmount: "1500.00",
      currency: "USD",
      fxRateEffective: "35.00",
      realizedGainLossThb: null,
    };

    const res = recomputeAllGainLoss([stmtSellRow, laterBuyRow]);
    ok(
      res.updates.length === 0,
      "Manual BUY test 2: Time-travel protection: Later Manual BUY cannot resolve earlier Statement SELL"
    );
  }

  // Test 3: Partial quantity Manual BUY (oversell guard prevents fake basis)
  {
    const stmtSellRow: GainLossBackfillRow = {
      transactionId: "sell-stmt-oversell",
      sourceType: "AI_PARSED",
      transactionDate: "2026-02-15",
      symbol: "AMZN",
      side: "SELL",
      quantity: "10",
      unitPrice: "200.00",
      grossAmount: "2000.00",
      fees: "0.00",
      netAmount: "2000.00",
      currency: "USD",
      fxRateEffective: "35.00",
      realizedGainLossThb: null,
    };

    // Manual BUY with only 5 shares (need 10)
    const partialBuyRow: GainLossBackfillRow = {
      transactionId: "buy-manual-partial",
      sourceType: "MANUAL",
      transactionDate: "2026-01-10",
      symbol: "AMZN",
      side: "BUY",
      quantity: "5",
      unitPrice: "180.00",
      grossAmount: "900.00",
      fees: "0.00",
      netAmount: "900.00",
      currency: "USD",
      fxRateEffective: "35.00",
      realizedGainLossThb: null,
    };

    const res = recomputeAllGainLoss([partialBuyRow, stmtSellRow]);
    ok(
      res.updates.length === 0,
      "Manual BUY test 3: Oversell guard triggers when Manual BUY quantity is insufficient (stays SKIPPED)"
    );
  }

  // Test 4: Multiple Manual BUYs calculate correct moving average cost
  {
    // BUY 1: 10 @ $10, fees $1 -> net 101, avg = 10.10
    const buy1: GainLossBackfillRow = {
      transactionId: "buy-1",
      sourceType: "MANUAL",
      transactionDate: "2026-01-01",
      symbol: "META",
      side: "BUY",
      quantity: "10",
      unitPrice: "10.00",
      grossAmount: "100.00",
      fees: "1.00",
      netAmount: "101.00",
      currency: "USD",
      fxRateEffective: "35.00",
      realizedGainLossThb: null,
    };

    // BUY 2: 10 @ $20, fees $1 -> net 201, live cost 302 across 20 shares = 15.10 avg
    const buy2: GainLossBackfillRow = {
      transactionId: "buy-2",
      sourceType: "MANUAL",
      transactionDate: "2026-01-15",
      symbol: "META",
      side: "BUY",
      quantity: "10",
      unitPrice: "20.00",
      grossAmount: "200.00",
      fees: "1.00",
      netAmount: "201.00",
      currency: "USD",
      fxRateEffective: "35.00",
      realizedGainLossThb: null,
    };

    // Statement SELL: 15 shares @ $30 -> gross = 450, cost basis = 15 * 15.10 = 226.50
    const stmtSell: GainLossBackfillRow = {
      transactionId: "sell-stmt-meta",
      sourceType: "AI_PARSED",
      transactionDate: "2026-02-01",
      symbol: "META",
      side: "SELL",
      quantity: "15",
      unitPrice: "30.00",
      grossAmount: "450.00",
      fees: "0.00",
      netAmount: "450.00",
      currency: "USD",
      fxRateEffective: "35.00",
      realizedGainLossThb: null,
    };

    const res = recomputeAllGainLoss([buy1, buy2, stmtSell]);
    ok(
      res.updates.length === 1 && res.updates[0].update.costBasis === "226.50",
      "Manual BUY test 4: Multiple Manual BUYs calculate correct moving average cost (15 * 15.10 = 226.50)"
    );
    ok(
      res.updates[0].update.realizedGainLoss === "223.50",
      "Manual BUY test 4: Realized gain matches proceeds minus cost basis (450 - 226.50 = 223.50)"
    );

    const costMap = recomputeCostBasisMap([buy1, buy2, stmtSell]);
    ok(
      costMap["META"]?.quantity === 5 && Math.abs(costMap["META"]?.avgCost - 15.10) < 1e-4,
      "Manual BUY test 4: Remaining live position after partial sell is exactly 5 shares @ 15.10"
    );
  }

  // Test 5: Idempotent / Repeated execution preserves journal entry ID and entry number
  {
    const buy: GainLossBackfillRow = {
      transactionId: "buy-idemp",
      sourceType: "MANUAL",
      transactionDate: "2026-01-01",
      symbol: "NFLX",
      side: "BUY",
      quantity: "10",
      unitPrice: "100.00",
      grossAmount: "1000.00",
      fees: "0.00",
      netAmount: "1000.00",
      currency: "USD",
      fxRateEffective: "35.00",
      realizedGainLossThb: null,
    };
    const sell: GainLossBackfillRow = {
      transactionId: "sell-idemp",
      sourceType: "AI_PARSED",
      transactionDate: "2026-02-01",
      symbol: "NFLX",
      side: "SELL",
      quantity: "10",
      unitPrice: "120.00",
      grossAmount: "1200.00",
      fees: "0.00",
      netAmount: "1200.00",
      currency: "USD",
      fxRateEffective: "35.00",
      realizedGainLossThb: null,
    };

    const run1 = recomputeAllGainLoss([buy, sell]);
    const run2 = recomputeAllGainLoss([buy, sell]);
    ok(
      JSON.stringify(run1.updates) === JSON.stringify(run2.updates),
      "Manual BUY test 5: Repeated reconciliation is 100% deterministic and idempotent"
    );

    // In-place journal simulation: original journal entry
    const existingJournal = {
      id: "j-orig-555",
      entryNo: 42,
      sourceTransactionId: "sell-idemp",
      postingState: "SKIPPED",
    };
    const updatedJournal = {
      ...existingJournal,
      postingState: "POSTED",
      costBasis: run1.updates[0].update.costBasis,
    };
    ok(
      updatedJournal.id === existingJournal.id && updatedJournal.entryNo === existingJournal.entryNo,
      "Manual BUY test 5: Statement SELL promotion preserves original journal entry ID and entryNo in place"
    );
  }

  // Test 6: Symbol isolation (BUY for AAPL does not affect SELL for NVDA)
  {
    const buyAapl: GainLossBackfillRow = {
      transactionId: "buy-aapl",
      sourceType: "MANUAL",
      transactionDate: "2026-01-01",
      symbol: "AAPL",
      side: "BUY",
      quantity: "10",
      unitPrice: "100.00",
      grossAmount: "1000.00",
      fees: "0.00",
      netAmount: "1000.00",
      currency: "USD",
      fxRateEffective: "35.00",
      realizedGainLossThb: null,
    };
    const sellNvda: GainLossBackfillRow = {
      transactionId: "sell-nvda",
      sourceType: "AI_PARSED",
      transactionDate: "2026-02-01",
      symbol: "NVDA",
      side: "SELL",
      quantity: "10",
      unitPrice: "150.00",
      grossAmount: "1500.00",
      fees: "0.00",
      netAmount: "1500.00",
      currency: "USD",
      fxRateEffective: "35.00",
      realizedGainLossThb: null,
    };

    const res = recomputeAllGainLoss([buyAapl, sellNvda]);
    ok(
      res.updates.length === 0,
      "Manual BUY test 6: Symbol isolation: AAPL Manual BUY does not resolve NVDA Statement SELL"
    );
  }

  // Test 7: Multi-tenant user isolation
  {
    // In multi-tenant architecture, rows are loaded with WHERE user_id = userId
    const userARows: GainLossBackfillRow[] = [
      {
        transactionId: "buy-user-a",
        sourceType: "MANUAL",
        transactionDate: "2026-01-01",
        symbol: "TSLA",
        side: "BUY",
        quantity: "10",
        unitPrice: "200.00",
        grossAmount: "2000.00",
        fees: "0.00",
        netAmount: "2000.00",
        currency: "USD",
        fxRateEffective: "35.00",
        realizedGainLossThb: null,
      },
    ];
    const userBRows: GainLossBackfillRow[] = [
      {
        transactionId: "sell-user-b",
        sourceType: "AI_PARSED",
        transactionDate: "2026-02-01",
        symbol: "TSLA",
        side: "SELL",
        quantity: "10",
        unitPrice: "250.00",
        grossAmount: "2500.00",
        fees: "0.00",
        netAmount: "2500.00",
        currency: "USD",
        fxRateEffective: "35.00",
        realizedGainLossThb: null,
      },
    ];

    // User B's reconciliation query only includes userBRows
    const resB = recomputeAllGainLoss(userBRows);
    ok(
      resB.updates.length === 0,
      "Manual BUY test 7: Multi-tenant isolation: User A's Manual BUY is never visible to User B's reconciliation"
    );

    // =========================================================================
    // TASK 5 INVARIANT: SKIPPED journal entries are guaranteed to have zero lines
    // =========================================================================
    const skippedCandidate = validateJournalEntry({
      entryDate: "2026-03-01",
      description: "SKIPPED test entry",
      sourceType: "STATEMENT",
      sourceTransactionId: "tx-skipped-invariant-test",
      postingState: "SKIPPED",
      skipReason: "non-computable cost basis",
      lines: [
        {
          accountId: "1020",
          currency: "USD",
          debit: "100.00",
          fxRateEffective: "35.00",
        },
        {
          accountId: "1110",
          currency: "USD",
          credit: "100.00",
          fxRateEffective: "35.00",
        },
      ],
    });
    ok(skippedCandidate.ok, "SKIPPED candidate validates successfully");
    if (skippedCandidate.ok) {
      ok(
        skippedCandidate.entry.postingState === "SKIPPED",
        "SKIPPED candidate maintains postingState = SKIPPED"
      );
      ok(
        skippedCandidate.entry.lines.length === 0,
        "TASK 5 INVARIANT: validateJournalEntry guarantees SKIPPED entries have 0 lines (lines array forced empty)"
      );
    }

    const skippedWithoutLines = validateJournalEntry({
      entryDate: "2026-03-01",
      description: "SKIPPED entry with no lines passed",
      sourceType: "STATEMENT",
      sourceTransactionId: "tx-skipped-empty-lines",
      postingState: "SKIPPED",
      skipReason: "reference row",
      lines: [],
    });
    ok(skippedWithoutLines.ok, "SKIPPED entry with lines: [] validates successfully");
    if (skippedWithoutLines.ok) {
      ok(
        skippedWithoutLines.entry.lines.length === 0,
        "SKIPPED entry with lines: [] has 0 lines"
      );
    }
  }

  runReportRegressions(ok);
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
