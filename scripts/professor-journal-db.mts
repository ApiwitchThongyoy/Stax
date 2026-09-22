import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { hash } from "bcryptjs";

/**
 * DB-backed regression suite for Professor Bankbook Journal, Edit Atomicity,
 * Cost-Basis Recompute, Structured Manual Entries, and Reference-Only Semantics.
 *
 * Called only by the TEST_DATABASE_URL-guarded integration harness.
 */
export async function runProfessorJournalDbTests(
  sql: postgres.Sql,
  ok: (value: boolean, label: string) => void
) {
  const check = (value: boolean, label: string) =>
    ok(value, "REG-PROF-JOURNAL: " + label);

  const service = await import("../app/lib/ledger-service");
  const pipeline = await import("../app/lib/statement-pipeline");
  const audit = await import("../app/lib/audit-log");
  const generalLedger = await import("../app/lib/general-ledger");

  const userId = randomUUID();
  const otherUserId = randomUUID();
  const docId = randomUUID();
  const now = new Date().toISOString();

  try {
    // 1. Setup isolated test users & seed Chart of Accounts
    await sql`INSERT INTO "User" (id, email, password_hash, role, status)
      VALUES (${userId}, ${userId + "@prof.test"}, ${await hash(randomUUID(), 4)}, 'USER', 'ACTIVE')`;
    await sql`INSERT INTO "User" (id, email, password_hash, role, status)
      VALUES (${otherUserId}, ${otherUserId + "@prof.test"}, ${await hash(randomUUID(), 4)}, 'USER', 'ACTIVE')`;

    await service.seedDefaultChartOfAccounts(userId);
    await service.seedDefaultChartOfAccounts(otherUserId);

    await sql`INSERT INTO documents (id, user_id, original_name, file_path, mime_type, file_size, created_at, updated_at)
      VALUES (${docId}, ${userId}, 'prof-test.pdf', '/tmp/prof-test.pdf', 'application/pdf', 1, ${now}, ${now})`;

    // =========================================================================
    // 2. Structured Manual Entries: VAT, GAIN_LOSS, BUY, SELL
    // =========================================================================
    const manualVat = await service.createStructuredManualJournal(userId, {
      transactionType: "VAT",
      entryDate: "2026-03-01",
      description: "ค่าภาษีมูลค่าเพิ่ม บล. ประจำเดือน",
      amount: "70.00",
      currency: "USD",
      fxRateEffective: "35.00",
    });
    check(manualVat.ok === true, "Manual VAT entry creates successfully");
    if (!manualVat.ok || !manualVat.entryId) throw new Error("Failed to create manual VAT entry");

    const vatEntry = await sql`
      SELECT e.*, l.account_id, l.debit_amount, l.credit_amount, l.currency AS line_currency, a.code
      FROM journal_entries e
      JOIN journal_entry_lines l ON l.journal_entry_id = e.id
      JOIN accounts a ON a.id = l.account_id
      WHERE e.id = ${manualVat.entryId}`;

    check(
      vatEntry[0]?.source_type === "MANUAL" &&
        vatEntry[0]?.source_document_id === null &&
        vatEntry.some((l) => (l.code === "5130" || l.code === "5010") && l.debit_amount === "70.00") &&
        vatEntry.some((l) => l.code === "1020" && l.credit_amount === "70.00"),
      "Manual VAT posts Dr 5130 (70.00) / Cr 1020 (70.00) with sourceType MANUAL and null document"
    );

    const manualGain = await service.createStructuredManualJournal(userId, {
      transactionType: "GAIN_LOSS",
      entryDate: "2026-03-02",
      description: "กำไรจากการขายสินทรัพย์ลงทุน",
      amount: "500.00",
      side: "GAIN",
      currency: "USD",
      fxRateEffective: "35.00",
    });
    check(manualGain.ok === true, "Manual GAIN entry creates successfully");
    if (!manualGain.ok || !manualGain.entryId) throw new Error("Failed to create manual GAIN entry");

    const gainEntry = await sql`
      SELECT e.*, l.account_id, l.debit_amount, l.credit_amount, l.currency AS line_currency, a.code
      FROM journal_entries e
      JOIN journal_entry_lines l ON l.journal_entry_id = e.id
      JOIN accounts a ON a.id = l.account_id
      WHERE e.id = ${manualGain.entryId}`;

    check(
      gainEntry.some((l) => l.code === "1020" && l.debit_amount === "500.00") &&
        gainEntry.some((l) => l.code === "4020" && l.credit_amount === "500.00"),
      "Manual GAIN posts Dr 1020 (500.00 USD) / Cr 4020 (500.00 USD)"
    );

    // =========================================================================
    // 3. Edit Safety: User Isolation & Reversal Guards
    // =========================================================================
    // 3.1 Cannot edit another user's entry
    const crossUserEdit = await service.editJournalEntry(
      otherUserId,
      manualVat.entryId,
      { description: "Hacked by User B" },
      "Attacking other user"
    );
    check(
      crossUserEdit.ok === false && crossUserEdit.status === 404,
      "User B cannot edit User A's journal entry (returns 404)"
    );

    // 3.2 Cannot edit a reversed entry
    const revResult = await service.reverseJournalEntry(userId, manualVat.entryId);
    check(revResult.ok === true, "Manual VAT entry reversed successfully");

    const editReversed = await service.editJournalEntry(
      userId,
      manualVat.entryId,
      { description: "Edit after reversal" },
      "Trying to edit reversed"
    );
    check(
      editReversed.ok === false &&
        editReversed.status === 400 &&
        editReversed.errors?.[0]?.includes("reversed"),
      "Cannot edit a REVERSED journal entry (rejected with 400)"
    );

    // =========================================================================
    // 4. Cost-Basis Recompute & Downstream SELL Replay on Historical BUY Edit
    // =========================================================================
    // Seed an authoritative BUY trade followed by a downstream SELL trade
    const buyTxnId = randomUUID();
    const sellTxnId = randomUUID();

    const buyRow = pipeline.mapToCapitalRow(
      {
        id: "trade-buy-1",
        date: "10/01/2026",
        description: "BUY AAPL",
        currency: "USD",
        amount: 1000,
        category: "asset",
        pnlAmount: 0,
        rate: "35.00",
        section: "trade",
        included: true,
        symbol: "AAPL",
        quantity: 10,
        unitPrice: 100,
        netAmount: 1000,
        grossAmount: 1000,
        fees: 0,
        side: "BUY",
      },
      userId,
      docId
    );
    if (!buyRow.ok) throw new Error(buyRow.reason);
    buyRow.row.transactionId = buyTxnId;

    const sellRow = pipeline.mapToCapitalRow(
      {
        id: "trade-sell-1",
        date: "15/01/2026",
        description: "SELL AAPL",
        currency: "USD",
        amount: 750,
        category: "asset",
        pnlAmount: 250,
        rate: "35.00",
        section: "trade",
        included: true,
        symbol: "AAPL",
        quantity: 5,
        unitPrice: 150,
        netAmount: 750,
        grossAmount: 750,
        fees: 0,
        side: "SELL",
      },
      userId,
      docId
    );
    if (!sellRow.ok) throw new Error(sellRow.reason);
    sellRow.row.transactionId = sellTxnId;

    await service.insertStatementImport(userId, [buyRow.row, sellRow.row]);
    await service.reconcileStatementImport(userId, new Set(["AAPL"]));

    // Verify initial downstream SELL state (cost basis = 500.00, gain = 250.00)
    const initialSellTxn = await sql`
      SELECT cost_basis, realized_gain_loss FROM "Capital_Transactions"
      WHERE transaction_id = ${sellTxnId} AND user_id = ${userId}`;
    check(
      Number(initialSellTxn[0]?.cost_basis) === 500 &&
        Number(initialSellTxn[0]?.realized_gain_loss) === 250,
      "Initial SELL row has cost_basis 500.00 and realized_gain_loss 250.00 (10 @ $100 -> sell 5 @ $150)"
    );

    // Find BUY journal entry
    const [buyEntryHeader] = await sql`
      SELECT id, entry_no, entry_date, description, amount, unit_price
      FROM journal_entries
      WHERE source_transaction_id = ${buyTxnId} AND user_id = ${userId}`;

    check(!!buyEntryHeader, "Found BUY journal entry in database");

    // Edit BUY price from $100 to $120 (Total Net Amount $1,200)
    const editBuyResult = await service.editJournalEntry(
      userId,
      buyEntryHeader.id,
      {
        unitPrice: "120.00",
        grossAmount: "1200.00",
        netAmount: "1200.00",
        amount: "1200.00",
        description: "BUY 10 AAPL @ 120.00",
      },
      "Corrected BUY price per broker confirmation"
    );
    check(editBuyResult.ok === true, "editJournalEntry succeeded for historical BUY trade");

    // Verify BUY journal entry lines updated to 1200.00
    const updatedBuyLines = await sql`
      SELECT l.*, a.code FROM journal_entry_lines l
      JOIN accounts a ON a.id = l.account_id
      WHERE l.journal_entry_id = ${buyEntryHeader.id}`;
    check(
      updatedBuyLines.some((l) => l.code === "1110" && l.debit_amount === "1200.00") &&
        updatedBuyLines.some((l) => l.code === "1020" && l.credit_amount === "1200.00"),
      "BUY journal lines updated to Dr 1110 (1,200.00) / Cr 1020 (1,200.00)"
    );

    // Verify downstream SELL was atomically recomputed:
    // New avg cost is 120.00. Draining 5 shares -> cost basis is 5 * 120 = 600.00.
    // Realized gain = 750 - 600 = 150.00.
    const recomputedSellTxn = await sql`
      SELECT cost_basis, realized_gain_loss FROM "Capital_Transactions"
      WHERE transaction_id = ${sellTxnId} AND user_id = ${userId}`;

    check(
      Number(recomputedSellTxn[0]?.cost_basis) === 600 &&
        Number(recomputedSellTxn[0]?.realized_gain_loss) === 150,
      "Downstream SELL automatically recomputed to cost_basis 600.00 and realized_gain_loss 150.00"
    );

    // =========================================================================
    // 5. Audit History Snapshot Verification
    // =========================================================================
    const auditRows = await sql`
      SELECT * FROM audit_logs
      WHERE entity_id = ${buyEntryHeader.id} AND action = ${audit.AuditAction.CAPITAL_TRANSACTION_UPDATE}`;
    check(
      auditRows.length >= 1 &&
        auditRows[0].details?.reason === "Corrected BUY price per broker confirmation" &&
        Number(auditRows[0].details?.oldValues?.netAmount) === 1000 &&
        Number(auditRows[0].details?.newValues?.netAmount) === 1200,
      "Audit trail records CAPITAL_TRANSACTION_UPDATE with oldValues (1000.00) and newValues (1200.00)"
    );

    // =========================================================================
    // 6. Transaction Rollback Atomicity on Audit/Recompute Failure
    // =========================================================================
    // Create a standalone manual entry to test forced rollback
    const testRollbackEntry = await service.createStructuredManualJournal(userId, {
      transactionType: "FEE",
      entryDate: "2026-03-05",
      description: "Original fee to test rollback",
      amount: "15.00",
      currency: "USD",
    });
    check(testRollbackEntry.ok === true, "Created test entry for rollback test");
    if (!testRollbackEntry.ok || !testRollbackEntry.entryId) throw new Error("Failed to create test rollback entry");

    // Force a failure during the transaction by attempting an invalid audit action or DB constraint
    // We test that when an error throws inside the transaction, nothing is committed.
    let threw = false;
    try {
      await sql.begin(async (tx) => {
        // Update header
        await tx`
          UPDATE journal_entries
          SET description = 'Modified description that must rollback'
          WHERE id = ${testRollbackEntry.entryId}`;

        // Attempt a strict audit log with invalid action violating chk_audit_logs_action
        await audit.insertAuditLogStrict(
          {
            userId,
            action: "ILLEGAL_FORCED_ACTION_THAT_VIOLATES_CHECK_CONSTRAINT" as any,
            entityType: "JOURNAL_ENTRY",
            entityId: testRollbackEntry.entryId,
            details: {},
          },
          tx as any
        );
      });
    } catch {
      threw = true;
    }
    check(threw === true, "Strict audit log insert threw on constraint violation");

    // Verify description was NOT changed in the database (rolled back!)
    const [entryAfterRollback] = await sql`
      SELECT description FROM journal_entries WHERE id = ${testRollbackEntry.entryId}`;
    check(
      entryAfterRollback?.description === "Original fee to test rollback",
      "Transaction rolled back completely: journal entry description was NOT mutated"
    );

    // =========================================================================
    // 7. Reference-Only Cash Semantics
    // =========================================================================
    const refSkipReason =
      "monthly fee/VAT summary row - fees already inside the BUY acquisition cost / SELL net proceeds";
    const refFlow = generalLedger.getEntryMoneyFlow({
      postingState: "SKIPPED",
      skipReason: refSkipReason,
      lines: [],
    });
    check(
      refFlow.moneyIn === null && refFlow.moneyOut === null,
      "getEntryMoneyFlow: reference row has null moneyIn and null moneyOut"
    );

    const refCat = generalLedger.classifyEntryCategory({
      category: "expense",
      detail: { isMonthlyFeeAggregate: true },
    });
    check(
      refCat.categoryId === "EXPENSE",
      "classifyEntryCategory: monthly fee aggregate correctly identified as EXPENSE"
    );
  } finally {
    // Self-cleaning: Clean up all data created for this test run
    for (const u of [userId, otherUserId]) {
      await sql`DELETE FROM journal_entry_lines WHERE user_id = ${u}`;
      await sql`DELETE FROM journal_entries WHERE user_id = ${u}`;
      await sql`DELETE FROM accounts WHERE user_id = ${u}`;
      await sql`DELETE FROM "Capital_Transactions" WHERE user_id = ${u}`;
      await sql`DELETE FROM cost_basis_state WHERE user_id = ${u}`;
      await sql`DELETE FROM corporate_actions WHERE user_id = ${u}`;
      await sql`DELETE FROM documents WHERE user_id = ${u}`;
      await sql`DELETE FROM audit_logs WHERE user_id = ${u}`;
      await sql`DELETE FROM "User" WHERE id = ${u}`;
    }
  }
}
