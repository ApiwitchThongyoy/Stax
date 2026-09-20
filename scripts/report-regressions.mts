import { balanceSheet, buildMonthlyClosing, incomeStatement, trialBalance, type AccountLedgerSummaryInput, type AccountMap, type MonthlyClosingLineInput, type Side } from "../app/lib/general-ledger";

export function runReportRegressions(ok: (value: boolean, label: string) => void) {
  const accounts: AccountMap = {
    cash: { code: "cash", name: "USD cash", currency: "USD", type: "ASSET" },
    capital: { code: "capital", name: "USD capital", currency: "USD", type: "EQUITY" },
    income: { code: "income", name: "USD income", currency: "USD", type: "INCOME" },
    expense: { code: "expense", name: "USD expense", currency: "USD", type: "EXPENSE" },
    thb: { code: "thb", name: "THB cash", currency: "THB", type: "ASSET" },
    equity: { code: "equity", name: "THB equity", currency: "THB", type: "EQUITY" },
    liability: { code: "liability", name: "THB liability", currency: "THB", type: "LIABILITY" },
    revenue: { code: "revenue", name: "THB income", currency: "THB", type: "INCOME" },
  };
  const line = (accountId: string, side: Side, amount: string, amountThb: string | null) => ({ accountId, currency: accounts[accountId].currency, side, amount, amountThb });
  const check = (v: boolean, label: string) => ok(v, "R9-12: " + label);
  const mixed = [line("cash", "DEBIT", "100", "3500"), line("capital", "CREDIT", "100", "3500"), line("thb", "DEBIT", "1000", "1000"), line("equity", "CREDIT", "1000", "1000")];
  const tb = trialBalance(mixed, accounts);
  check(tb.totalDebit === null && tb.totalCredit === null, "mixed native totals are unavailable, never 1100");
  check(tb.totalsByCurrency.some(t => t.currency === "USD" && t.debit === "100.00") && tb.totalsByCurrency.some(t => t.currency === "THB" && t.debit === "1000.00"), "native currency buckets remain distinct");
  check(tb.totalDebitThb === "4500.00" && tb.totalCreditThb === "4500.00" && tb.balancedThb, "consolidated TB balances at THB 4500");
  const opening = trialBalance([], accounts, { thb: "1000", equity: "1000" });
  check(opening.totalDebit === "1000.00" && opening.totalCredit === "1000.00" && opening.balancedThb, "TB includes normal-side account openings");
  const contra = trialBalance([line("capital", "DEBIT", "50", "1750")], accounts);
  check(contra.rows[0].debit === "50.00" && contra.rows[0].credit === "0.00", "contra equity balance appears on debit side");
  const earnings = [line("income", "CREDIT", "200", "7000"), line("expense", "DEBIT", "50", "1750")];
  const income = incomeStatement(earnings, accounts);
  check(income.netIncome === "150.00" && income.totalsByCurrency[0].netIncome === "150.00", "USD 200 - 50 = 150");
  check(income.netIncomeThb === "5250.00" && income.reportingStatus === "COMPLETE", "THB 7000 - 1750 = 5250");
  const multiIncome = incomeStatement([...earnings, line("revenue", "CREDIT", "1000", "1000")], accounts);
  check(multiIncome.netIncome === null && multiIncome.netIncomeThb === "6250.00", "multicurrency income consolidates only stored THB");
  const unknown = incomeStatement([line("income", "CREDIT", "200", null), earnings[1]], accounts);
  check(unknown.totalIncomeThb === null && unknown.netIncomeThb === null && unknown.reportingStatus === "PARTIAL", "missing income THB propagates null and partial status");
  check(incomeStatement([line("income", "CREDIT", "200", null)], accounts).reportingStatus === "UNAVAILABLE", "all reporting values missing is unavailable");
  const bsLines = [line("thb", "DEBIT", "40500", "40500"), line("liability", "CREDIT", "5000", "5000"), line("equity", "CREDIT", "30000", "30000"), line("revenue", "CREDIT", "5500", "5500")];
  const sheet = balanceSheet(bsLines, accounts);
  check(sheet.totalAssetsThb === "40500.00" && sheet.totalLiabilitiesThb === "5000.00" && sheet.totalEquityThb === "30000.00" && sheet.netIncomeThb === "5500.00" && sheet.balancedThb, "40500 = 5000 + 30000 + 5500");
  check(sheet.totalsByCurrency[0].netIncome === "5500.00" && sheet.totalsByCurrency[0].balanced, "native BS includes net income in balance check");
  const prior = balanceSheet([...bsLines, line("thb", "DEBIT", "1000", "1000"), line("revenue", "CREDIT", "1000", "1000")], accounts, {}, {}, bsLines);
  check(prior.totalEquityThb === "31000.00" && prior.netIncomeThb === "5500.00" && prior.totalAssetsThb === "41500.00" && prior.balancedThb, "prior unclosed earnings move into report equity, current NI remains 5500");
  const unknownOpening = balanceSheet([], accounts, { cash: "100", capital: "100" });
  check(unknownOpening.totalAssetsThb === null && unknownOpening.totalEquityAndLiabilitiesThb === null && !unknownOpening.balancedThb && unknownOpening.reportingStatus === "UNAVAILABLE", "foreign openings never fabricate THB zero");
  const fx = [line("cash", "DEBIT", "1000", "35000"), line("thb", "CREDIT", "35000", "35000")];
  const fxSheet = balanceSheet(fx, accounts);
  check(fxSheet.totalAssets === null && fxSheet.balancedThb && !fxSheet.balanced, "FX balances in reporting base; native currency balances are informational");
  const skipped = [line("income", "CREDIT", "999", "34965"), line("cash", "DEBIT", "999", "34965")].map(l => ({ ...l, postingState: "SKIPPED" }));
  check(trialBalance(skipped, accounts).rows.length === 0, "SKIPPED has no TB effect");
  check(incomeStatement(skipped, accounts).netIncomeThb === "0.00", "SKIPPED has no income effect");
  check(balanceSheet(skipped, accounts).totalAssetsThb === "0.00", "SKIPPED has no balance-sheet effect");

  runMonthlyClosingRegressions(ok);
}

function runMonthlyClosingRegressions(ok: (value: boolean, label: string) => void) {
  const accounts: AccountLedgerSummaryInput[] = [
    { accountId: "cash", code: "cash", name: "USD cash", currency: "USD", type: "ASSET", openingBalance: null },
    { accountId: "capital", code: "capital", name: "USD capital", currency: "USD", type: "EQUITY", openingBalance: null },
    { accountId: "thb", code: "thb", name: "THB cash", currency: "THB", type: "ASSET", openingBalance: null },
    { accountId: "equity", code: "equity", name: "THB equity", currency: "THB", type: "EQUITY", openingBalance: null },
  ];
  const monthLine = (accountId: string, entryDate: string, side: Side, amount: string, amountThb?: string | null): MonthlyClosingLineInput => ({ accountId, entryDate, side, amount, amountThb });
  const check = (v: boolean, label: string) => ok(v, "R18 monthly closing: " + label);
  const full = [
    monthLine("cash", "2025-12-15", "DEBIT", "100"),
    monthLine("capital", "2025-12-15", "CREDIT", "100"),
    monthLine("cash", "2026-01-10", "DEBIT", "50"),
    monthLine("capital", "2026-01-10", "CREDIT", "50"),
    monthLine("cash", "2026-02-05", "DEBIT", "30"),
    monthLine("capital", "2026-02-05", "CREDIT", "30"),
  ];
  const janFeb = buildMonthlyClosing(accounts, full, "2026-01-01", "2026-02-28");
  check(janFeb.months.length === 2 && janFeb.months[0].month === "2026-01" && janFeb.months[1].month === "2026-02", "months reported ASC in the requested window");
  const jan = janFeb.months[0];
  check(jan.rows[0].opening === "100.00" && jan.rows[0].closing === "150.00" && jan.lineCount === 2, "January opening includes full prior history and closes at 150");
  check(jan.balanced, "January month lines balance (debit === credit)");
  check(jan.balancedThb === null, "missing THB base keeps balancedThb null, never fabricated");
  const feb = janFeb.months[1];
  const febUsd = feb.totalsByCurrency.find((t) => t.currency === "USD");
  check(feb.rows[0].opening === "150.00" && feb.rows[0].closing === "180.00" && febUsd?.closing === "360.00", "February carries January closing forward to 180 (totals sum both accounts)");
  check(janFeb.continuity.ok && janFeb.continuity.issues.length === 0, "continuity holds (next opening === previous closing)");
  const windowed = buildMonthlyClosing(accounts, full, "2026-02-01", "2026-02-28");
  check(windowed.months.length === 1 && windowed.months[0].rows[0].opening === "150.00" && windowed.months[0].rows[0].closing === "180.00", "from/to only limit reporting; numbers equal the full-history run");
  const thbLines = [
    monthLine("thb", "2026-01-10", "DEBIT", "1000", "1000"),
    monthLine("equity", "2026-01-10", "CREDIT", "1000", "1000"),
  ];
  const thbRes = buildMonthlyClosing(accounts, thbLines, "2026-01-01", "2026-01-31");
  check(thbRes.months[0].balancedThb === true, "full THB base reports a real balancedThb");
  const emptyMonth = buildMonthlyClosing(accounts, [monthLine("cash", "2025-11-01", "DEBIT", "10"), monthLine("capital", "2025-11-01", "CREDIT", "10")], "2025-11-01", "2026-01-31");
  const emptyJan = emptyMonth.months[1];
  check(emptyJan.lineCount === 0 && emptyJan.balanced && emptyJan.rows[0].opening === "10.00" && emptyJan.rows[0].closing === "10.00", "a month with no lines still reports opening/closing and stays balanced");
  check(emptyMonth.continuity.ok, "continuity survives empty months");
}
