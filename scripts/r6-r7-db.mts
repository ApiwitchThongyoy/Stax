import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { hash } from "bcryptjs";

/** Called only by the TEST_DATABASE_URL-guarded integration harness. */
export async function runCurrencyExchangeTests(sql: postgres.Sql, ok: (value: boolean, label: string) => void) {
  const service = await import("../app/lib/ledger-service");
  const pipeline = await import("../app/lib/statement-pipeline");
  const posting = await import("../app/lib/posting-engine");
  const { getCashSummary } = await import("../app/lib/cash-summary");
  const userId = randomUUID(), docId = randomUUID();
  const check = (value: boolean, label: string) => ok(value, "REG-R67: " + label);
  try {
    await sql`INSERT INTO "User" (id,email,password_hash,role,status)
      VALUES (${userId},${userId + "@r67.test"},${await hash(randomUUID(), 4)},'USER','ACTIVE')`;
    await service.seedDefaultChartOfAccounts(userId);
    const now = new Date().toISOString();
    await sql`INSERT INTO documents (id,user_id,original_name,file_path,mime_type,file_size,created_at,updated_at)
      VALUES (${docId},${userId},'r67.pdf','/tmp/r67-no-file.pdf','application/pdf',1,${now},${now})`;
    const mapped = pipeline.mapToCapitalRow({
      id: "r67", date: "01/01/2026", description: "THB to USD", currency: "USD", amount: 1000,
      category: "asset", pnlAmount: 0, rate: "35", section: "exchange", included: true,
      exchangeFromCurrency: "THB", exchangeFromAmount: 35000, exchangeRate: 35,
    }, userId, docId);
    if (!mapped.ok) throw new Error(mapped.reason);
    const fx = mapped.row;
    check(fx.type === "FX_CONVERSION", "mapper classifies exchange separately from external capital");
    const bad = { ...fx, transactionId: randomUUID(), fxRateEffective: "34.50" };
    const thbBuy = { ...fx, transactionId: randomUUID(), side: "BUY" as const, type: "CASH_OUT" as const,
      currency: "THB", amountForeign: "1000", fxRateEffective: "1", quantity: "1", unitPrice: "1000",
      exchangeFromCurrency: null, exchangeFromAmount: null };
    await service.insertStatementImport(userId, [fx, bad, thbBuy]);
    const headers = await sql`SELECT * FROM journal_entries WHERE user_id=${userId}`;
    const goodHeader = headers.find(e => e.source_transaction_id === fx.transactionId)!;
    const badHeader = headers.find(e => e.source_transaction_id === bad.transactionId)!;
    const buyHeader = headers.find(e => e.source_transaction_id === thbBuy.transactionId)!;
    const lines = await sql`SELECT l.*,a.code,a.currency AS account_currency FROM journal_entry_lines l
      JOIN accounts a ON a.id=l.account_id WHERE l.journal_entry_id=${goodHeader.id}`;
    check(goodHeader.posting_state === "POSTED" && goodHeader.is_fx_conversion && goodHeader.type === null,
      "exchange persists POSTED marker and no external Cash In/Out type");
    check(lines.length === 2 && lines.some(l => l.code === "1020" && l.currency === "USD" && l.debit_amount === "1000.00") &&
      lines.some(l => l.code === "1010" && l.currency === "THB" && l.credit_amount === "35000.00"),
      "exchange persists USD debit 1000 and THB credit 35000");
    check(lines.every(l => l.amount_thb === "35000.00" && l.currency === l.account_currency),
      "both reporting legs equal THB 35000 and match account currencies");
    check(badHeader.posting_state === "SKIPPED" && badHeader.skip_reason.includes("THB does not balance"),
      "FX 34.50 rejects reporting imbalance without inventing balancing lines");
    check(buyHeader.posting_state === "SKIPPED" && buyHeader.skip_reason.includes("compatible"),
      "THB BUY cannot use USD investment account");
    const rebuilt = posting.buildStatementJournalEntries([{
      ...fx, amountForeign: goodHeader.amount, exchangeFromAmount: goodHeader.exchange_from_amount,
      currency: goodHeader.currency, fxRateEffective: goodHeader.fx_rate_effective,
    }])[0];
    check(rebuilt.postingState === "POSTED", "rebuild from persisted exchange fields uses identical policy");
    const summary = await getCashSummary(userId);
    check(summary.totalCashInThb === "0" && summary.totalCashOutThb === "0" &&
      summary.exchanges.some(e => e.transactionId === fx.transactionId),
      "cash summary lists FX separately and excludes it from deposits/withdrawals");
    for (const currency of ["THB", "USD"]) {
      const txId = randomUUID();
      await sql`INSERT INTO "Capital_Transactions"
        (transaction_id,user_id,amount_foreign,currency,transaction_date,type,source_type,category,amount_thb)
        VALUES (${txId},${userId},100,${currency},'2026-01-01','CASH_IN','MANUAL','equity',${currency === "THB" ? "100" : "3500"})`;
      const input = { transactionId: txId, type: "CASH_IN" as const, amountForeign: "100",
        currency, transactionDate: "2026-01-01", fxRateEffective: currency === "THB" ? "1" : "35",
        amountThb: currency === "THB" ? "100" : "3500" };
      const manual = await service.insertManualCashJournal(userId, input);
      check(manual.ok, currency + " manual cash remains recorded");
      const [entry] = await sql`SELECT * FROM journal_entries WHERE source_transaction_id=${txId}`;
      const manualLines = await sql`SELECT l.*,a.code,a.currency AS account_currency FROM journal_entry_lines l
        JOIN accounts a ON a.id=l.account_id WHERE l.journal_entry_id=${entry.id}`;
      check(entry.posting_state === "POSTED" && manualLines.length === 2 &&
        manualLines.every(l => l.currency === l.account_currency) &&
        manualLines.some(l => l.code === (currency === "THB" ? "1010" : "1020")) &&
        manualLines.some(l => l.code === (currency === "THB" ? "3020" : "3010")),
        currency + " manual path enforces the same account-currency rule");
      await service.syncCapitalLedgerJournal(userId, txId, { ...input, currency: "USD", fxRateEffective: "35" });
      const updated = await sql`SELECT l.*,a.currency AS account_currency FROM journal_entry_lines l
        JOIN accounts a ON a.id=l.account_id WHERE l.journal_entry_id=${entry.id}`;
      check(updated.length === 2 && updated.every(l => l.currency === "USD" && l.account_currency === "USD"),
        currency + " manual update resolves UUID accounts and compatible currency");
      await service.syncCapitalLedgerJournal(userId, txId, { ...input, currency: "THB", fxRateEffective: "1" });
      const [after] = await sql`SELECT posting_state,
        (SELECT count(*)::int FROM journal_entry_lines l WHERE l.journal_entry_id=e.id) AS line_count
        FROM journal_entries e WHERE id=${entry.id}`;
      check(after.posting_state === "POSTED" && after.line_count === 2,
        "manual update to THB posts compatible 1010/3020 lines");
    }
    for (const [currency, cash] of [["THB", "1020"], ["USD", "1010"]]) {
      const rejected = await service.createJournalEntry(userId, {
        entryDate: "2026-01-01", description: "invalid currency",
        lines: [{ accountId: cash, currency, debit: "100", fxRateEffective: "35" },
          { accountId: "3010", currency, credit: "100", fxRateEffective: "35" }],
      });
      check(!rejected.ok && rejected.errors.some(e => e.includes("denominated")),
        currency + " mismatched manual journal is rejected");
    }
    await sql`UPDATE accounts SET currency='THB' WHERE user_id=${userId} AND code='1020'`;
    const incompatibleReversal = await service.reverseJournalEntry(userId, goodHeader.id);
    check(!incompatibleReversal.ok, "reversal rejects an account whose currency no longer matches");
    const [stillPosted] = await sql`SELECT status FROM journal_entries WHERE id=${goodHeader.id}`;
    check(stillPosted.status === "POSTED", "rejected reversal leaves the original entry unchanged");
    await sql`UPDATE accounts SET currency='USD' WHERE user_id=${userId} AND code='1020'`;
    const fakeFx = posting.buildStatementJournalEntries([fx])[0].entry;
    const forged = await service.createJournalEntry(userId, {
      ...fakeFx, lines: fakeFx.lines.map(l => l.currency === "USD" ? { ...l, accountId: "4010" } : l),
    });
    check(!forged.ok, "FX marker cannot turn an income account into an asset transfer");
    const reversal = await service.reverseJournalEntry(userId, goodHeader.id);
    check(reversal.ok, "exchange reversal succeeds with explicit exchange marker");
    if (reversal.ok) {
      const reversed = await sql`SELECT l.*,a.code,a.currency AS account_currency FROM journal_entry_lines l
        JOIN accounts a ON a.id=l.account_id WHERE l.journal_entry_id=${reversal.reversalEntryId}`;
      check(reversed.length === 2 && reversed.every(l => l.currency === l.account_currency && l.amount_thb === "35000.00") &&
        reversed.some(l => l.code === "1010" && l.debit_amount === "35000.00") &&
        reversed.some(l => l.code === "1020" && l.credit_amount === "1000.00"),
        "reversal preserves compatible accounts, native amounts and THB equality");
    }
    const mismatches = await sql`SELECT l.id FROM journal_entry_lines l JOIN accounts a ON a.id=l.account_id
      WHERE l.user_id=${userId} AND l.currency<>a.currency`;
    check(mismatches.length === 0, "no incompatible line persisted across all tested paths");
  } finally {
    await sql`DELETE FROM journal_entry_lines WHERE user_id=${userId}`;
    await sql`DELETE FROM journal_entries WHERE user_id=${userId}`;
    await sql`DELETE FROM "Capital_Transactions" WHERE user_id=${userId}`;
    await sql`DELETE FROM documents WHERE user_id=${userId}`;
    await sql`DELETE FROM accounts WHERE user_id=${userId}`;
    await sql`DELETE FROM "User" WHERE id=${userId}`;
  }
}
