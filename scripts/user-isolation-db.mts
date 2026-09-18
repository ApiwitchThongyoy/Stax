// Invoked by run-tests.mts after its TEST_DATABASE_URL guard. Real routes + DB.
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type postgres from "postgres";

export async function runUserIsolationTests(
  sql: postgres.Sql,
  ok: (condition: boolean, label: string) => void,
  makePdf: (lines: string[]) => Uint8Array,
  adminToken: string,
) {
  const check = (condition: boolean, label: string) => ok(condition, `REG-isolation: ${label}`);
  const a = randomUUID(), b = randomUUID();
  const now = new Date().toISOString();
  const email = (id: string) => `isolation-${id}@test.local`;
  const token = (id: string, role = "USER") => jwt.sign({ userId: id, email: email(id), role }, process.env.JWT_SECRET!, { expiresIn: "1h" });
  const ta = token(a), tb = token(b);
  const service = await import("../app/lib/ledger-service");
  const pipeline = await import("../app/lib/statement-pipeline");
  const storage = await import("../app/lib/storage/statement-storage");
  const { getStorageDriver } = await import("../app/lib/storage/storage-driver");
  const files = new Set<string>();
  const call = async (route: string, method: string, auth: string, params = {}, body?: unknown, query = "") => {
    const mod = await import(`../app/routes/api/${route}.ts`);
    const response: Response = await mod[method === "GET" ? "loader" : "action"]({
      request: new Request(`http://test.local/api${query}`, {
        method, headers: { Authorization: `Bearer ${auth}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), params,
    });
    return { status: response.status, body: await response.json() };
  };
  const snapshotB = async () => JSON.stringify(await Promise.all([
    sql`SELECT * FROM documents WHERE user_id=${b} ORDER BY id`,
    sql`SELECT * FROM "Capital_Transactions" WHERE user_id=${b} ORDER BY transaction_id`,
    sql`SELECT * FROM journal_entries WHERE user_id=${b} ORDER BY id`,
    sql`SELECT * FROM journal_entry_lines WHERE user_id=${b} ORDER BY id`,
    sql`SELECT * FROM accounts WHERE user_id=${b} ORDER BY id`,
    sql`SELECT * FROM corporate_actions WHERE user_id=${b} ORDER BY id`,
    sql`SELECT * FROM notifications WHERE user_id=${b} ORDER BY id`,
    sql`SELECT * FROM cost_basis_state WHERE user_id=${b} ORDER BY id`,
    sql`SELECT * FROM user_settings WHERE user_id=${b} ORDER BY id`,
  ]));
  const pdf = new File([makePdf([
    "TRADE RECORDS", "Currency: USD", "USD/THB = 35.42", "ISOPDF",
    "02/01/2026 10:00:00,GMT+07 02/01/2026 BUY 100 10.00 1000.00 1000.00 1.00 0.07 NASDAQ",
    "PORTFOLIO SUMMARY",
  ]) as BlobPart], "isolation-private.pdf", { type: "application/pdf" });
  const postPdf = async (route: string, auth: string) => {
    const mod = await import(`../app/routes/api/statements/${route}.ts`);
    const form = new FormData();
    form.append("file", pdf);
    // These attacker-supplied fields must never determine identity or storage.
    form.append("userId", b);
    form.append("documentId", b);
    const response = await mod.action({ request: new Request("http://test.local/api", {
      method: "POST", headers: { Authorization: `Bearer ${auth}` }, body: form,
    }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    for (const id of [a, b]) {
      await sql`INSERT INTO "User" (id,email,password_hash,role,status,created_at) VALUES (${id},${email(id)},'unused-test-token-only','USER','ACTIVE',${now})`;
      await service.seedDefaultChartOfAccounts(id);
    }
    const stored = await storage.saveStatementPdf({ userId: b, file: pdf });
    if (!stored.ok) throw new Error("Isolation PDF fixture failed");
    const docB = stored.document.id;
    files.add(stored.document.filePath);
    const bytesB = await getStorageDriver().readPdf(stored.document.filePath);
    const fixtures = new Map<string, { cash: string; entry: string; account: string; trade: string }>();
    for (const [id, auth, amount] of [[a, ta, "100"], [b, tb, "900"]]) {
      const cash = await call("capital-ledgers", "POST", auth, {}, {
        // Use supported USD cash/equity accounts; rate 1 is explicit fixture data.
        amountForeign: amount, currency: "USD", transactionDate: "2026-01-01", fxRateBot: "1", amountThb: amount,
        type: "CASH_IN", sourceType: "MANUAL", userId: b,
      });
      check(cash.status === 201 && cash.body.data.userId === id, `${amount} cash fixture uses authenticated owner`);
      // Independent income fixture, USD at FX=1, to exercise all report families.
      const journal = await call("journal", "POST", auth, {}, {
        entryDate: "2026-01-02", description: `private-${id}`, userId: b,
        lines: [{ accountId: "1020", currency: "USD", debit: amount, fxRateEffective: "1" },
          { accountId: "4010", currency: "USD", credit: amount, fxRateEffective: "1" }],
      });
      check(journal.status === 201, `${amount} income fixture created`);
      const [account] = await sql`SELECT id FROM accounts WHERE user_id=${id} AND code='1020'`;
      const trade = randomUUID();
      await sql`INSERT INTO "Capital_Transactions" (transaction_id,user_id,amount_foreign,currency,transaction_date,amount_thb,type,source_type,source_document_id)
        VALUES (${trade},${id},${amount},'USD','2026-01-03',${amount},'CASH_OUT','AI_PARSED',${id === b ? docB : null})`;
      await sql`INSERT INTO journal_entries (id,user_id,entry_no,entry_date,description,source_type,status,posting_state,source_transaction_id,source_document_id,side,category,symbol,quantity,unit_price,amount,amount_thb,currency,fx_rate_effective,created_at,updated_at)
        VALUES (${randomUUID()},${id},999,'2026-01-03',${`private-${id}`},'STATEMENT','POSTED','SKIPPED',${trade},${id === b ? docB : null},'BUY','asset','ISOX',${amount},'1',${amount},${amount},'USD','1',${now},${now})`;
      await sql`INSERT INTO cost_basis_state (id,user_id,symbol,quantity,avg_cost,cum_quantity,cum_cost,updated_at)
        VALUES (${randomUUID()},${id},'ISOX',${amount},'1',${amount},${amount},${now})`;
      fixtures.set(id, { cash: cash.body.data.transactionId, entry: journal.body.data.entryId, account: account.id, trade });
      await call("settings", "GET", auth);
    }
    const fb = fixtures.get(b)!;
    const ca = randomUUID(), notification = randomUUID();
    await sql`INSERT INTO corporate_actions (id,user_id,symbol,action_type,transaction_date,created_at,updated_at)
      VALUES (${ca},${b},'ONLYB','SPLIT','2026-01-01',${now},${now})`;
    await sql`INSERT INTO notifications (id,user_id,type,title,message,is_read,created_at)
      VALUES (${notification},${b},'SYSTEM','private title','private message',false,${now})`;
    const before = await snapshotB();

    // All foreign-ID failures must be indistinguishable from a nonexistent ID.
    const denials: [string, string, string, string, unknown?][] = [
      ["documents.$id.download", "GET", "id", docB],
      ["documents.$id.transactions", "GET", "id", docB],
      ["documents.$id", "DELETE", "id", docB],
      ["capital-ledgers.$id", "GET", "id", fb.trade],
      ["capital-ledgers.$id", "PUT", "id", fb.cash, { amountForeign: "1" }],
      ["capital-ledgers.$id", "PATCH", "id", fb.cash, { amountForeign: "1" }],
      ["capital-ledgers.$id", "DELETE", "id", fb.cash],
      ["corporate-actions.$id", "DELETE", "id", ca],
      ["notifications.$id.read", "PATCH", "id", notification],
      ["ledger.$accountId", "GET", "accountId", fb.account],
      ["journal.$id.reverse", "POST", "id", fb.entry],
      ["trading-journal.$transactionId.note", "PUT", "transactionId", fb.trade, { note: "attack" }],
      ["trading-journal.$transactionId.note", "DELETE", "transactionId", fb.trade],
    ];
    for (const [route, method, key, id, body] of denials) {
      const foreign = await call(route, method, ta, { [key]: id }, body);
      const missing = await call(route, method, ta, { [key]: randomUUID() }, body);
      check(foreign.status === 404 && JSON.stringify(foreign) === JSON.stringify(missing), `${method} ${route}: foreign = missing safe 404`);
      check(![email(b), stored.document.filePath, "private title", "private message", "stack", "PostgresError"].some(s => JSON.stringify(foreign).includes(s)), `${method} ${route}: no private data/error leak`);
    }
    for (const route of ["documents.$id", "corporate-actions.$id"]) {
      const response = await call(route, "GET", ta, { id: docB });
      check(response.status === 405, `${route} metadata GET is N/A (405)`);
    }
    const docs = await call("documents", "GET", ta);
    check(docs.status === 200 && docs.body.data.length === 0, "A document list excludes B metadata");
    const capital = await call("capital-ledgers", "GET", ta);
    check(capital.status === 200 && !JSON.stringify(capital).includes(fb.trade) && !JSON.stringify(capital).includes(fb.cash), "A capital list excludes B");
    const corp = await call("corporate-actions", "GET", ta);
    check(corp.status === 200 && !JSON.stringify(corp).includes(ca), "A corporate-action list excludes B");
    await call("notifications", "PATCH", ta);
    const notices = await call("notifications", "GET", ta);
    check(notices.status === 200 && !JSON.stringify(notices).includes(notification), "A notification list/read-all excludes B");
    const settingsAttack = await call("settings", "PATCH", ta, {}, { userId: b, notificationEnabled: false });
    check(settingsAttack.status === 400, "settings rejects body userId");
    const settingsUpdate = await call("settings", "PATCH", ta, {}, { notificationEnabled: false });
    check(settingsUpdate.status === 200 && settingsUpdate.body.data.userId === a, "valid settings mutation uses A only");
    check(await snapshotB() === before, "all denied mutations + settings/read-all leave every B row unchanged");

    const forged = await call("journal", "POST", ta, {}, {
      entryDate: "2026-01-02", description: "forged-account",
      lines: [{ accountId: fb.account, currency: "USD", debit: "100", fxRateEffective: "1" },
        { accountId: "4010", currency: "USD", credit: "100", fxRateEffective: "1" }],
    });
    check(forged.status === 422, "journal POST rejects B account ID");
    const serviceInput = { entryDate: "2026-01-02", description: "forged-link", sourceType: "MANUAL" as const,
      lines: [{ accountId: "1020", currency: "USD", debit: "100", fxRateEffective: "1" },
        { accountId: "4010", currency: "USD", credit: "100", fxRateEffective: "1" }] };
    for (const link of [{ sourceDocumentId: docB }, { sourceTransactionId: fb.trade }]) {
      const result = await service.createJournalEntry(a, { ...serviceInput, ...link });
      check(!result.ok, `service rejects foreign ${Object.keys(link)[0]}`);
    }
    const importRow = {
      transactionId: randomUUID(), userId: b, sourceDocumentId: docB, amountForeign: "1", amountThb: "1", currency: "THB",
      transactionDate: "2026-01-04", type: "CASH_IN", sourceType: "AI_PARSED", category: "equity", fxRateEffective: "1",
    };
    for (const insert of [pipeline.insertStatementTransactions, service.insertStatementImport]) {
      let rejected = false;
      try { await insert(a, [importRow as never]); } catch { rejected = true; }
      check(rejected, `${insert.name} rejects foreign document link`);
    }
    const [badWrites] = await sql`SELECT count(*)::int AS n FROM journal_entries WHERE user_id=${a} AND description IN ('forged-link','forged-account')`;
    const [badImports] = await sql`SELECT count(*)::int AS n FROM "Capital_Transactions" WHERE transaction_id=${importRow.transactionId}`;
    check(badWrites.n === 0 && badImports.n === 0 && await snapshotB() === before, "forged relationships leave no writes or partial imports");

    // Direct-SQL corrupt relationships cannot make aggregate joins expose B.
    // This is defense in depth: the API already rejects these relationships.
    const fa = fixtures.get(a)!;
    const rogue1 = randomUUID(), rogue2 = randomUUID();
    await sql`INSERT INTO journal_entry_lines (id,journal_entry_id,user_id,account_id,currency,debit_amount,amount_thb,fx_rate_effective)
      VALUES (${rogue1},${fb.entry},${a},${fa.account},'USD','777','777','1'),
             (${rogue2},${fa.entry},${a},${fb.account},'USD','888','888','1')`;
    const corruptRead = await call("journal", "GET", ta);
    check(corruptRead.status === 200 && !JSON.stringify(corruptRead).includes(`private-${b}`)
      && !JSON.stringify(corruptRead).includes(rogue1) && !JSON.stringify(corruptRead).includes(rogue2), "inconsistent legacy line ownership cannot join B header/account into A reads");

    for (const [auth, amount] of [[ta, 100], [tb, 900]] as const) {
      const get = async (r: string, params = {}) => {
        const result = await call(r, "GET", auth, params, undefined, `?userId=${auth === ta ? b : a}`);
        check(result.status === 200, `${amount} ${r} succeeds`);
        return result.body.data;
      };
      check(Number((await get("cash-summary")).totalCashInThb) === amount, `${amount} cash summary isolated`);
      check(Number((await get("ledger.summary")).totalsThb.totalAssets) === amount * 2, `${amount} ledger summary isolated (cash + income)`);
      check(Number((await get("reports/trial-balance")).totalDebitThb) === amount * 2, `${amount} trial balance isolated`);
      check(Number((await get("reports/income-statement")).netIncomeThb) === amount, `${amount} income statement isolated`);
      check(Number((await get("reports/balance-sheet")).totalAssetsThb) === amount * 2, `${amount} balance sheet isolated`);
      const basis = await get("cost-basis");
      check(basis.length === 1 && Number(basis[0].quantity) === amount, `${amount} cost basis isolated`);
      const portfolio = await get("portfolio.$symbol", { symbol: "ISOX" });
      check(Number(portfolio.holding.quantity) === amount && portfolio.trades.length === 1, `${amount} portfolio holding/trades isolated`);
      const trading = await get("trading-journal");
      check(trading.entries.length === 1 && Number(trading.holdings[0].quantity) === amount, `${amount} trading journal isolated`);
    }
    await sql`DELETE FROM journal_entry_lines WHERE id IN (${rogue1},${rogue2}) AND user_id=${a}`;
    const ownLedger = await call("ledger.$accountId", "GET", tb, { accountId: fb.account });
    // Both supported USD cash and income fixtures now use this USD cash account.
    check(ownLedger.status === 200 && ownLedger.body.data.lines.length === 2, "B can read own account ledger");
    const ownDoc = await call("documents.$id.transactions", "GET", tb, { id: docB });
    check(ownDoc.status === 200 && ownDoc.body.data.transactions.length === 1, "B can read own document transactions");

    for (const route of ["admin/users", "admin/stats", "admin/audit-logs", "admin/documents", "admin/users.$id", "exchange-rates/status"]) {
      const method = route.endsWith(".$id") ? "PATCH" : "GET";
      const params = { id: a };
      const body = method === "PATCH" ? { status: "ACTIVE" } : undefined;
      const normal = await call(route, method, ta, params, body);
      const forgedRole = await call(route, method, token(a, "ADMIN"), params, body);
      const admin = await call(route, method, adminToken, params, body);
      check(normal.status === 403 && forgedRole.status === 403, `${route} rejects USER and stale/forged ADMIN claim`);
      check(admin.status === 200, `${route} still works for DB ADMIN`);
    }

    const preview = await postPdf("preview", ta);
    check(preview.status === 200 && !JSON.stringify(preview).includes(docB), "A preview of B PDF does not disclose B document ID");
    const upload = await postPdf("upload", ta);
    check(upload.status === 200 && upload.body.data.documentId !== docB && upload.body.data.saved > 0, "same PDF imports as a new A document");
    const docA = upload.body.data.documentId;
    const [savedA] = await sql`SELECT * FROM documents WHERE id=${docA} AND user_id=${a}`;
    if (savedA) files.add(savedA.file_path);
    check(!!savedA && savedA.file_path.includes(a) && savedA.file_path !== stored.document.filePath, "A/B storage keys separated");
    check(![docB, stored.document.filePath, email(b)].some(s => JSON.stringify(upload).includes(s)), "same-hash upload exposes no B metadata");
    const dup = await postPdf("upload", ta);
    check(dup.status === 200 && dup.body.data.existingDocumentId === docA && !JSON.stringify(dup).includes(docB), "A duplicate resolves only A document");
    await sql`DELETE FROM journal_entry_lines WHERE user_id=${a} AND journal_entry_id IN (SELECT id FROM journal_entries WHERE user_id=${a} AND source_document_id=${docA})`;
    await sql`DELETE FROM journal_entries WHERE user_id=${a} AND source_document_id=${docA}`;
    await sql`DELETE FROM "Capital_Transactions" WHERE user_id=${a} AND source_document_id=${docA}`;
    const rebuilt = await postPdf("upload", ta);
    check(rebuilt.body.data.rebuilt === true && rebuilt.body.data.documentId === docA, "A rebuild uses own document only");
    const removed = await call("documents.$id", "DELETE", ta, { id: docA });
    check(removed.status === 200 && !(await getStorageDriver().readPdf(savedA.file_path)), "A own document deletion removes A PDF");
    check(await snapshotB() === before, "A duplicate/import/rebuild/delete leaves all B rows unchanged");
    const finalBytesB = await getStorageDriver().readPdf(stored.document.filePath);
    check(!!bytesB && !!finalBytesB && Buffer.from(bytesB).equals(Buffer.from(finalBytesB)), "B PDF bytes survive all A attacks and deletion");

    // Prove the inherited userId fix in BOTH import paths, with no document link.
    for (const insert of [pipeline.insertStatementTransactions, service.insertStatementImport]) {
      const id = randomUUID();
      await insert(a, [{ ...importRow, sourceDocumentId: null, transactionId: id } as never]);
      const [row] = await sql`SELECT user_id FROM "Capital_Transactions" WHERE transaction_id=${id}`;
      check(row?.user_id === a, `${insert.name} ignores row.userId=B, persists as A`);
    }
  } finally {
    // Only resources belonging to the two fresh task fixtures are removed.
    const docs = await sql`SELECT file_path FROM documents WHERE user_id IN (${a},${b})`;
    for (const doc of docs) files.add(doc.file_path);
    for (const file of files) await storage.deleteStoredFile(file);
    for (const id of [a, b]) {
      await sql`DELETE FROM journal_entry_lines WHERE user_id=${id}`;
      await sql`DELETE FROM journal_entries WHERE user_id=${id}`;
      await sql`DELETE FROM "Capital_Transactions" WHERE user_id=${id}`;
      await sql`DELETE FROM documents WHERE user_id=${id}`;
      await sql`DELETE FROM cost_basis_state WHERE user_id=${id}`;
      await sql`DELETE FROM corporate_actions WHERE user_id=${id}`;
      await sql`DELETE FROM notifications WHERE user_id=${id}`;
      await sql`DELETE FROM audit_logs WHERE user_id=${id}`;
      await sql`DELETE FROM user_settings WHERE user_id=${id}`;
      await sql`DELETE FROM accounts WHERE user_id=${id}`;
      await sql`DELETE FROM "User" WHERE id=${id}`;
    }
    check((await sql`SELECT id FROM "User" WHERE id IN (${a},${b})`).length === 0, "two-user fixtures cleaned up");
    check((await Promise.all([...files].map(file => getStorageDriver().readPdf(file)))).every(file => file === null), "all fixture PDFs cleaned up");
  }
}
