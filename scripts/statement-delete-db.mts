import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type postgres from "postgres";

// Called only by the guarded TEST_DATABASE_URL harness. Real PDFs/routes/DB.
export async function runStatementDeleteTests(sql: postgres.Sql,
  ok: (condition: boolean, label: string) => void, makePdf: (lines: string[]) => Uint8Array) {
  const check = (condition: boolean, label: string) => ok(condition, `REG-delete: ${label}`);
  const users = [randomUUID(), randomUUID()];
  const [a, b] = users;
  const tokens = users.map(userId => jwt.sign({ userId, role: "USER", email: `${userId}@test.local` }, process.env.JWT_SECRET!));
  const service = await import("../app/lib/ledger-service");
  const storage = await import("../app/lib/storage/statement-storage");
  const files = new Set<string>();
  async function call(route: string, user = 0, method = "GET", params = {}, body?: unknown) {
    const mod = await import(`../app/routes/api/${route}.ts`);
    const response = await mod[method === "GET" ? "loader" : "action"]({ params,
      request: new Request("http://test.local/api", { method,
        headers: { Authorization: `Bearer ${tokens[user]}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    });
    return { status: response.status, body: await response.json() };
  }
  function pdf(symbol: string, side = "BUY", date = "02/01/2026") {
    const price = side === "SELL" ? "20.00" : "10.00";
    const amount = side === "SELL" ? "2000.00" : "1000.00";
    return makePdf(["TRADE RECORDS", "Currency: USD", "USD/THB = 35.42", symbol,
      `${date} 10:00:00,GMT+07 ${date} ${side} 100 ${price} ${amount} ${amount} 1.00 0.07 NASDAQ`, "PORTFOLIO SUMMARY"]);
  }
  async function upload(bytes: Uint8Array, user = 0, name = "delete-lifecycle-target.pdf") {
    const form = new FormData();
    form.append("file", new File([bytes as BlobPart], name, { type: "application/pdf" }));
    const mod = await import("../app/routes/api/statements/upload");
    const response = await mod.action({ request: new Request("http://test.local/api", {
      method: "POST", headers: { Authorization: `Bearer ${tokens[user]}` }, body: form,
    }) } as never);
    const body = await response.json();
    check(response.status === 200 && body.data.saved > 0, `${name} imported`);
    const [doc] = await sql`SELECT file_path FROM documents WHERE id=${body.data.documentId}`;
    if (doc) files.add(doc.file_path);
    return body.data;
  }
  async function financialSnapshot(userId: string) {
    return JSON.stringify(await Promise.all([
      sql`SELECT * FROM documents WHERE user_id=${userId} ORDER BY id`,
      sql`SELECT * FROM "Capital_Transactions" WHERE user_id=${userId} ORDER BY transaction_id`,
      sql`SELECT * FROM journal_entries WHERE user_id=${userId} ORDER BY id`,
      sql`SELECT * FROM journal_entry_lines WHERE user_id=${userId} ORDER BY id`,
      sql`SELECT * FROM corporate_actions WHERE user_id=${userId} ORDER BY id`,
      sql`SELECT * FROM cost_basis_state WHERE user_id=${userId} ORDER BY id`,
    ]));
  }
  const views = ["capital-ledgers", "ledger.summary", "cash-summary", "reports/trial-balance",
    "reports/income-statement", "reports/balance-sheet", "trading-journal"];
  const financialJson = (value: unknown) => JSON.stringify(value, (key, item) => key === "updatedAt" ? undefined : item);
  try {
    for (const id of users) {
      await sql`INSERT INTO "User" (id,email,password_hash,role,status,created_at)
        VALUES (${id},${`${id}@test.local`},'test-jwt-only','USER','ACTIVE',${new Date().toISOString()})`;
      await service.seedDefaultChartOfAccounts(id);
    }
    await upload(pdf("KEEP"), 0, "keep-statement.pdf");
    const bDoc = await upload(pdf("DELETEFIX"), 1, "user-b.pdf");
    const manual = await call("capital-ledgers", 0, "POST", {}, {
      amountForeign: "42", amountThb: "42", fxRateBot: "1", currency: "THB",
      transactionDate: "2026-01-01", type: "CASH_IN", sourceType: "MANUAL",
    });
    check(manual.status === 201, "manual transaction fixture created");
    const journal = await service.createJournalEntry(a, { entryDate: "2026-01-01", description: "keep manual",
      lines: [{ accountId: "1020", currency: "USD", debit: "7", fxRateEffective: "1" },
        { accountId: "3010", currency: "USD", credit: "7", fxRateEffective: "1" }] });
    check(journal.ok, "manual journal fixture created");
    const actionId = randomUUID();
    await sql`INSERT INTO corporate_actions (id,user_id,symbol,action_type,transaction_date,ratio_old,ratio_new,created_at,updated_at)
      VALUES (${actionId},${a},'KEEP','SPLIT','2026-01-01','1','1','2026-01-01','2026-01-01')`;
    const baseline = new Map<string, string>();
    for (const view of views) baseline.set(view, financialJson(await call(view)));
    const keepRows = JSON.stringify(await sql`SELECT * FROM journal_entries WHERE user_id=${a} ORDER BY id`);
    const keepCapital = JSON.stringify(await sql`SELECT * FROM "Capital_Transactions" WHERE user_id=${a} ORDER BY transaction_id`);
    const bBefore = await financialSnapshot(b);
    const bytes = pdf("DELETEFIX");
    const imported = await upload(bytes);
    const docId = imported.documentId;
    const capital = await sql`SELECT transaction_id,symbol FROM "Capital_Transactions" WHERE user_id=${a} AND source_document_id=${docId}`;
    const entries = await sql`SELECT id FROM journal_entries WHERE user_id=${a} AND source_document_id=${docId}`;
    const lines = await sql`SELECT id FROM journal_entry_lines WHERE user_id=${a} AND journal_entry_id IN ${sql(entries.map(row => row.id))}`;
    check(capital.length === imported.saved && entries.length === imported.saved && lines.length > 0, "import persists capital + journal + lines");
    // Legacy transaction-only mirror/reversal and document-only skipped header.
    const linked = await service.createJournalEntry(a, { entryDate: "2026-01-02", description: "linked mirror",
      sourceTransactionId: capital[0].transaction_id,
      lines: [{ accountId: "1020", currency: "USD", debit: "3", fxRateEffective: "1" },
        { accountId: "3010", currency: "USD", credit: "3", fxRateEffective: "1" }] });
    check(linked.ok, "transaction-only derived journal fixture created");
    const skippedId = randomUUID();
    await sql`INSERT INTO journal_entries (id,user_id,entry_no,entry_date,description,source_type,status,posting_state,source_document_id,created_at,updated_at)
      VALUES (${skippedId},${a},999,'2026-01-02','document-only','STATEMENT','POSTED','SKIPPED',${docId},'2026-01-02','2026-01-02')`;
    await sql`INSERT INTO csv_import_rows (id,user_id,document_id,row_hash,source_type,canonical_row,created_at)
      VALUES (${randomUUID()},${a},${docId},${randomUUID()},'CSV','{}','2026-01-02')`;
    check((await call("documents.$id", 0, "DELETE", { id: bDoc.documentId })).status === 404, "A cannot delete B statement");
    check(await financialSnapshot(b) === bBefore, "foreign delete leaves all B financial state unchanged");
    // Fail after journal/capital deletes: the enclosing transaction must restore everything.
    const beforeFailure = await financialSnapshot(a);
    await sql.unsafe(`CREATE FUNCTION stax_delete_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test delete failure'; END $$`);
    await sql.unsafe(`CREATE TRIGGER stax_delete_test_fail BEFORE DELETE ON documents FOR EACH ROW EXECUTE FUNCTION stax_delete_test_fail()`);
    try {
      check((await call("documents.$id", 0, "DELETE", { id: docId })).status === 500, "injected failure returns safe 500");
      check(await financialSnapshot(a) === beforeFailure, "failed deletion rolls back every financial row");
    } finally {
      await sql.unsafe("DROP TRIGGER stax_delete_test_fail ON documents");
      await sql.unsafe("DROP FUNCTION stax_delete_test_fail()");
    }
    check((await call("documents.$id", 0, "DELETE", { id: docId })).status === 200, "statement deletion succeeds");
    const deletionAudit = await sql`SELECT details FROM audit_logs WHERE user_id=${a} AND entity_id=${docId} AND action='STATEMENT_DELETE'`;
    check(deletionAudit.length === 1 && deletionAudit[0].details.originalName === "delete-lifecycle-target.pdf",
      "one successful deletion audit preserves originalName");
    check(deletionAudit[0]?.details.route === `/api/v1/documents/${docId}` && deletionAudit[0]?.details.method === "DELETE"
      && deletionAudit[0]?.details.result === "success", "deletion audit retains route/method/result");
    check(JSON.stringify(Object.keys(deletionAudit[0]?.details ?? {}).sort()) === JSON.stringify(["method", "originalName", "result", "route"]),
      "deletion audit contains only safe details, never filePath");
    check((await sql`SELECT id FROM documents WHERE id=${docId}`).length === 0, "document removed");
    check((await sql`SELECT transaction_id FROM "Capital_Transactions" WHERE source_document_id=${docId}`).length === 0, "capital dataset removed");
    check((await sql`SELECT id FROM journal_entries WHERE user_id=${a} AND (source_document_id=${docId} OR source_transaction_id IN ${sql(capital.map(row => row.transaction_id))})`).length === 0, "document-linked and transaction-linked journals removed");
    check((await sql`SELECT id FROM journal_entry_lines WHERE id IN ${sql(lines.map(row => row.id))}`).length === 0, "dependent journal lines removed");
    check((await sql`SELECT id FROM csv_import_rows WHERE document_id=${docId}`).length === 0, "legacy CSV dependent rows cascade");
    check((await call("portfolio.$symbol", 0, "GET", { symbol: "DELETEFIX" })).status === 404, "deleted portfolio and holding gone");
    check((await sql`SELECT id FROM cost_basis_state WHERE user_id=${a} AND symbol='DELETEFIX'`).length === 0, "deleted cost basis gone");
    for (const view of views) check(financialJson(await call(view)) === baseline.get(view), `${view} returns to baseline without deleted statement`);
    check(JSON.stringify(await sql`SELECT * FROM journal_entries WHERE user_id=${a} ORDER BY id`) === keepRows, "manual and other-statement journals unchanged");
    check(JSON.stringify(await sql`SELECT * FROM "Capital_Transactions" WHERE user_id=${a} ORDER BY transaction_id`) === keepCapital, "manual and other-statement capital rows unchanged");
    check((await sql`SELECT id FROM corporate_actions WHERE id=${actionId}`).length === 1, "unrelated corporate action preserved");
    check(await financialSnapshot(b) === bBefore, "own deletion leaves B completely unchanged");
    const fresh = await upload(bytes);
    check(fresh.documentId !== docId && fresh.saved === imported.saved, "same PDF re-import creates one fresh document");
    const symbolCount = capital.filter(row => row.symbol === "DELETEFIX").length;
    check(symbolCount > 0 && (await sql`SELECT id FROM journal_entries WHERE user_id=${a} AND symbol='DELETEFIX'`).length === symbolCount, "re-import has exactly one journal dataset");
    check((await sql`SELECT transaction_id FROM "Capital_Transactions" WHERE user_id=${a} AND symbol='DELETEFIX'`).length === symbolCount, "re-import has exactly one capital dataset");
    const sell = await upload(pdf("DELETEFIX", "SELL", "03/01/2026"), 0, "remaining-sell.pdf");
    check((await sql`SELECT cost_basis FROM "Capital_Transactions" WHERE source_document_id=${sell.documentId} AND side='SELL'`)[0].cost_basis !== null, "later statement SELL initially has basis");
    check((await sql`SELECT l.id FROM journal_entry_lines l JOIN accounts ac ON ac.id=l.account_id
      JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.source_document_id=${sell.documentId} AND ac.code='4020'`).length > 0,
      "later SELL initially posts real gain income");
    check((await call("documents.$id", 0, "DELETE", { id: fresh.documentId })).status === 200, "delete supporting BUY succeeds");
    const [remaining] = await sql`SELECT cost_basis,realized_gain_loss,realized_gain_loss_thb FROM "Capital_Transactions" WHERE source_document_id=${sell.documentId} AND side='SELL'`;
    check(Object.values(remaining).every(value => value === null), "remaining SELL loses stale basis and gain/loss");
    const [remainingJournal] = await sql`SELECT cost_basis,realized_gain_loss,realized_gain_loss_thb FROM journal_entries WHERE source_document_id=${sell.documentId} AND side='SELL'`;
    check(Object.values(remainingJournal).every(value => value === null), "remaining journal detail reconciled");
    const [uncomputable] = await sql`SELECT posting_state, skip_reason,
      (SELECT count(*)::int FROM journal_entry_lines l WHERE l.journal_entry_id = j.id) AS line_count
      FROM journal_entries j WHERE source_document_id=${sell.documentId} AND side='SELL'`;
    check(uncomputable.posting_state === "SKIPPED" && uncomputable.line_count === 0 &&
      !!uncomputable.skip_reason, "R8: deletion leaves visible SKIPPED SELL with reason and zero lines");
    const gainLines = await sql`SELECT l.id FROM journal_entry_lines l JOIN accounts ac ON ac.id=l.account_id
      JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.source_document_id=${sell.documentId} AND ac.code IN ('4020','5120')`;
    check(gainLines.length === 0, "reports lose stale gain/loss posting legs");
    check(await financialSnapshot(b) === bBefore, "gain/loss reconciliation never changes B");
  } finally {
    await sql.unsafe("DROP TRIGGER IF EXISTS stax_delete_test_fail ON documents");
    await sql.unsafe("DROP FUNCTION IF EXISTS stax_delete_test_fail()");
    for (const doc of await sql`SELECT file_path FROM documents WHERE user_id IN ${sql(users)}`) files.add(doc.file_path);
    for (const file of files) await storage.deleteStoredFile(file);
    for (const id of users) {
      await sql`DELETE FROM journal_entry_lines WHERE user_id=${id}`;
      await sql`DELETE FROM journal_entries WHERE user_id=${id}`;
      await sql`DELETE FROM "Capital_Transactions" WHERE user_id=${id}`;
      await sql`DELETE FROM documents WHERE user_id=${id}`;
      await sql`DELETE FROM cost_basis_state WHERE user_id=${id}`;
      await sql`DELETE FROM corporate_actions WHERE user_id=${id}`;
      await sql`DELETE FROM accounts WHERE user_id=${id}`;
      await sql`DELETE FROM notifications WHERE user_id=${id}`;
      await sql`DELETE FROM audit_logs WHERE user_id=${id}`;
      await sql`DELETE FROM user_settings WHERE user_id=${id}`;
      await sql`DELETE FROM "User" WHERE id=${id}`;
    }
  }
}
