// Opt-in smoke test of the BUILT Node server, never a deployment/live provider.
// Start it with the same local TEST_DATABASE_URL as DATABASE_URL first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { access, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const databaseUrl = new URL(process.env.TEST_DATABASE_URL ?? "http://invalid");
const base = new URL(process.env.TEST_BASE_URL ?? "http://invalid");
if (!['localhost', '127.0.0.1'].includes(databaseUrl.hostname)
  || !databaseUrl.pathname.endsWith('_test')
  || !['localhost', '127.0.0.1'].includes(base.hostname)
  || process.env.STORAGE_MODE !== 'local') {
  throw new Error("Set local TEST_DATABASE_URL ending in _test, local TEST_BASE_URL, and STORAGE_MODE=local (also on the server)");
}
const sql = postgres(databaseUrl.toString(), { max: 1 });
const email = `release-node-${randomUUID()}@test.local`;
const password = "ReleaseNodeTest!234";
const stockId = randomUUID();
const fixtureSymbol = "R" + randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
let userId;
let token;
let count = 0;
const check = (condition, label) => { assert.ok(condition, label); count++; console.log(`PASS ${label}`); };
async function request(path, method = "GET", body, authorized = true) {
  const response = await fetch(new URL(`/api/v1/${path}`, base), {
    method,
    headers: { ...(authorized && token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() };
}
// A real text PDF exercises multipart parsing and PDF extraction in the built server.
function statementPdf(lines = ["TRADE RECORDS", "Currency: USD", "USD/THB = 35.42", "HTTPSMOKE",
  "02/01/2026 10:00:00,GMT+07 02/01/2026 BUY 100 10.00 1000.00 1000.00 1.00 0.07 NASDAQ", "PORTFOLIO SUMMARY"]) {
  const content = "BT\n/F1 10 Tf\n" + lines.map((line, i) => `${i ? "0 -14" : "72 720"} Td (${line}) Tj`).join("\n") + "\nET\n";
  const objects = ["<</Type/Catalog/Pages 2 0 R>>", "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${Buffer.byteLength(content)}>>\nstream\n${content}endstream`, "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  return Buffer.from(pdf + `trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
}
async function postPdf(route, bytes, name = "http-smoke.pdf", type = "application/pdf") {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  const response = await fetch(new URL(`/api/v1/statements/${route}`, base), {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, body: await response.json() };
}
try {
  check((await fetch(base, { signal: AbortSignal.timeout(10000) })).status === 200, "built server root responds");
  check((await request("auth/session", "GET", undefined, false)).status === 401, "built server routes unauthenticated API safely");
  const registered = await request("auth/register", "POST", { email, password }, false);
  check(registered.status === 201, "HTTP register succeeds");
  // Establish that the running server and cleanup connection use the SAME DB.
  const [stored] = await sql`SELECT id FROM "User" WHERE email=${email}`;
  assert.ok(stored, "server must point at the disposable TEST_DATABASE_URL");
  userId = stored.id;
  const login = await request("auth/login", "POST", { email: ` ${email.toUpperCase()} `, password }, false);
  token = login.body.data?.accessToken;
  check(login.status === 200 && !!token, "HTTP normalized login succeeds");
  const session = await request("auth/session");
  check(session.status === 200 && session.body.data.userId === userId && session.body.data.status === "ACTIVE", "HTTP session resolves database identity");
  check((await request("auth/heartbeat", "POST")).status === 200, "HTTP heartbeat POST succeeds");
  check((await sql`SELECT last_seen_at FROM "User" WHERE id=${userId}`)[0].last_seen_at !== null, "heartbeat persisted");

  await sql`INSERT INTO stock_prices (id,symbol,price_date,close_price,currency,created_at,updated_at)
    VALUES (${stockId},${fixtureSymbol},'2026-09-10','123.45','USD',${new Date().toISOString()},${new Date().toISOString()})`;
  const price = await request(`stock-prices?symbols=${fixtureSymbol}`);
  check(price.status === 200 && price.body.data[0]?.close === 123.45, "HTTP stock read serves seeded cache (zero provider calls)");
  check((await request("stock-prices?symbols=..%2Fbad")).status === 400, "HTTP invalid ticker rejected");
  check((await request("stock-prices/refresh", "GET", undefined, false)).status === 401, "HTTP cron without secret denied");
  check((await request("stock-prices/refresh", "POST")).status === 403, "HTTP USER refresh denied");

  const entry = await request("journal", "POST", {
    entryDate: "2026-09-10", description: "release HTTP reversal",
    lines: [{ accountId: "1020", currency: "USD", debit: "100", fxRateEffective: "1" },
      { accountId: "3010", currency: "USD", credit: "100", fxRateEffective: "1" }],
  });
  check(entry.status === 201, "HTTP balanced journal entry created");
  const reversed = await request(`journal/${entry.body.data.entryId}/reverse`, "POST");
  check(reversed.status === 200, "HTTP own journal reversal succeeds");
  const entries = await sql`SELECT status FROM journal_entries WHERE id=${entry.body.data.entryId} AND user_id=${userId}`;
  check(entries[0]?.status === "REVERSED", "reversal changes original state");
  const lines = await sql`SELECT COALESCE(sum(debit_amount),0)-COALESCE(sum(credit_amount),0) AS net FROM journal_entry_lines WHERE user_id=${userId}`;
  check(Number(lines[0].net) === 0, "double-entry debit/credit remains balanced after reversal");
  check((await request(`journal/${entry.body.data.entryId}/reverse`, "POST")).status === 400, "sequential second reversal rejected");
  for (const path of ["accounts", "journal", "ledger/summary", "cash-summary", "cost-basis", "documents", "trading-journal",
    "reports/trial-balance", "reports/income-statement", "reports/balance-sheet", "settings", "notifications"]) {
    check((await request(path)).status === 200, `HTTP ${path} works`);
  }
  check((await request("admin/users")).status === 403, "HTTP USER cannot read admin users");
  for (const endpoint of ["admin/documents", "admin/stats", "admin/audit-logs"]) {
    check((await request(endpoint)).status === 403, `HTTP USER denied ${endpoint}`);
  }
  for (const endpoint of ["admin/users", "admin/documents", "admin/stats", "admin/audit-logs"]) {
    check((await request(endpoint, "GET", undefined, false)).status === 401, `HTTP anonymous denied ${endpoint}`);
  }

  const financialPaths = ["capital-ledgers", "ledger/summary", "cash-summary", "cost-basis", "trading-journal",
    "reports/trial-balance", "reports/income-statement", "reports/balance-sheet"];
  const beforeStatement = new Map();
  for (const endpoint of financialPaths) beforeStatement.set(endpoint, JSON.stringify(await request(endpoint)));

  const pdf = statementPdf();
  for (const [bytes, name, type] of [[pdf, "bad.txt", "application/pdf"], [pdf, "bad.pdf", "text/plain"],
    [Buffer.from("not a PDF"), "bad.pdf", "application/pdf"], [Buffer.alloc(20 * 1024 * 1024 + 1), "large.pdf", "application/pdf"]]) {
    check((await postPdf("upload", bytes, name, type)).status === 400, `HTTP rejects invalid PDF: ${name}/${type}`);
  }
  const broken = await postPdf("upload", Buffer.from("%PDF-1.4\nbroken\n"));
  check(broken.status >= 400, "HTTP corrupt PDF rejected");
  check((await postPdf("upload", statementPdf([]))).status === 422, "HTTP textless PDF rejected");
  check((await sql`SELECT id FROM documents WHERE user_id=${userId}`).length === 0, "failed PDF uploads leave no document rows");
  const failedFiles = await readdir(path.resolve("storage/statements/statements", userId)).catch(error => {
    if (error.code === "ENOENT") return []; throw error;
  });
  check(failedFiles.length === 0, "failed PDF uploads leave no storage objects");
  const preview = await postPdf("preview", pdf);
  check(preview.status === 200 && preview.body.success, "HTTP deterministic PDF preview succeeds");
  check((await sql`SELECT id FROM documents WHERE user_id=${userId}`).length === 0, "preview does not persist document");
  // Block only this fresh fixture user's storage directory, then restore it.
  const fixtureDirectory = path.resolve("storage/statements/statements", userId);
  await mkdir(path.dirname(fixtureDirectory), { recursive: true });
  await writeFile(fixtureDirectory, "fixture storage unavailable", { flag: "wx" });
  try {
    check((await postPdf("upload", pdf)).status === 500, "HTTP storage write failure returns safe error");
    check((await sql`SELECT id FROM documents WHERE user_id=${userId}`).length === 0, "storage write failure leaves no document rows");
  } finally {
    await unlink(fixtureDirectory);
  }
  const imported = await postPdf("upload", pdf);
  const documentId = imported.body.data?.documentId;
  check(imported.status === 200 && imported.body.data?.saved > 0 && documentId, "HTTP PDF import persists transactions");
  check((await request("documents")).body.data.some(doc => doc.id === documentId), "HTTP imported document listed");
  const transactions = await request(`documents/${documentId}/transactions`);
  check(transactions.status === 200 && transactions.body.data.transactions.length > 0, "HTTP document transactions readable");
  const download = await fetch(new URL(`/api/v1/documents/${documentId}/download`, base), { headers: { Authorization: `Bearer ${token}` } });
  check(download.status === 200 && Buffer.from(await download.arrayBuffer()).equals(pdf), "HTTP downloaded PDF matches upload bytes");
  check((await postPdf("upload", pdf)).body.data.existingDocumentId === documentId, "HTTP duplicate returns existing document");
  check((await request("portfolio/HTTPSMOKE")).status === 200, "HTTP imported symbol portfolio works");
  const [storedDoc] = await sql`SELECT file_path FROM documents WHERE id=${documentId} AND user_id=${userId}`;
  const importedEntries = await sql`SELECT id FROM journal_entries WHERE user_id=${userId} AND source_document_id=${documentId}`;
  const importedLines = await sql`SELECT id FROM journal_entry_lines WHERE user_id=${userId} AND journal_entry_id IN ${sql(importedEntries.map(row => row.id))}`;
  check(importedEntries.length === imported.body.data.saved && importedLines.length > 0, "HTTP import creates complete journal dataset");
  check((await request(`documents/${documentId}`, "DELETE")).status === 200, "HTTP document delete succeeds");
  await sql`UPDATE "User" SET role='ADMIN' WHERE id=${userId}`;
  try {
    const audits = await request("admin/audit-logs?limit=200");
    const deletion = audits.body.data?.find(row => row.action === "STATEMENT_DELETE" && row.entityId === documentId);
    check(audits.status === 200 && deletion?.details.originalName === "http-smoke.pdf", "HTTP admin audit exposes deleted originalName");
    check(deletion && JSON.stringify(Object.keys(deletion.details).sort()) === JSON.stringify(["method", "originalName", "result", "route"]), "HTTP deletion audit never includes filePath");
    const adminDocs = await request("admin/documents");
    check(adminDocs.status === 200 && !adminDocs.body.data.some(row => row.id === documentId), "HTTP reloaded admin documents excludes deletion");
    const stats = await request("admin/stats");
    const [actual] = await sql`SELECT count(*)::int AS total FROM documents`;
    check(stats.status === 200 && stats.body.data.documents.total === actual.total, "HTTP reloaded admin stats matches remaining documents");
    check((await request("admin/documents", "DELETE")).status === 405, "HTTP admin documents has no delete capability");
    check((await request(`admin/users/${userId}`, "PATCH", { status: "SUSPENDED" })).status === 400, "HTTP ADMIN account cannot be suspended");
    check((await request(`admin/users/${userId}`, "PATCH", { status: "ACTIVE" })).status === 400, "HTTP ADMIN account cannot be reactivated through USER endpoint");
  } finally {
    await sql`UPDATE "User" SET role='USER' WHERE id=${userId}`;
  }
  const remains = await access(path.resolve("storage/statements", storedDoc.file_path)).then(() => true, error => {
    if (error.code === "ENOENT") return false; throw error;
  });
  check(!remains, "HTTP document delete removes stored PDF");
  check((await sql`SELECT transaction_id FROM "Capital_Transactions" WHERE source_document_id=${documentId}`).length === 0, "document delete removes linked transactions");
  check((await request(`documents/${documentId}/transactions`)).status === 404, "deleted document is safely missing");
  check((await sql`SELECT id FROM journal_entries WHERE user_id=${userId} AND id IN ${sql(importedEntries.map(row => row.id))}`).length === 0, "HTTP deletion removes statement journal entries");
  check((await sql`SELECT id FROM journal_entry_lines WHERE user_id=${userId} AND id IN ${sql(importedLines.map(row => row.id))}`).length === 0, "HTTP deletion removes statement journal lines");
  for (const endpoint of financialPaths) {
    check(JSON.stringify(await request(endpoint)) === beforeStatement.get(endpoint), `HTTP ${endpoint} excludes deleted statement`);
  }
  check((await request("portfolio/HTTPSMOKE")).status === 404, "HTTP deleted symbol portfolio is gone");
  const reimport = await postPdf("upload", pdf);
  check(reimport.status === 200 && reimport.body.data.documentId !== documentId && reimport.body.data.saved === imported.body.data.saved, "HTTP re-import creates one fresh dataset");
  check((await sql`SELECT id FROM journal_entries WHERE user_id=${userId} AND source_document_id IS NOT NULL`).length === importedEntries.length, "HTTP re-import never doubles journal data");
  check((await sql`SELECT transaction_id FROM "Capital_Transactions" WHERE user_id=${userId} AND source_document_id IS NOT NULL`).length === imported.body.data.saved, "HTTP re-import never doubles capital data");
  check((await sql`SELECT id FROM journal_entry_lines WHERE user_id=${userId} AND journal_entry_id IN
    (SELECT id FROM journal_entries WHERE user_id=${userId} AND source_document_id=${reimport.body.data.documentId})`).length === importedLines.length,
    "HTTP re-import has exactly one fresh set of posting lines");
  console.log(`Node production smoke: ${count} PASS / 0 FAIL`);
} finally {
  // Also recover the fixture if an assertion failed immediately after register.
  userId ??= (await sql`SELECT id FROM "User" WHERE email=${email}`)[0]?.id;
  await sql`DELETE FROM stock_prices WHERE id=${stockId}`;
  if (userId) {
    const docs = await sql`SELECT file_path FROM documents WHERE user_id=${userId}`;
    const storageRoot = path.resolve("storage/statements");
    for (const doc of docs) {
      const file = path.resolve(storageRoot, doc.file_path);
      assert.ok(file.startsWith(storageRoot + path.sep), "fixture path must remain inside local storage");
      await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
    await sql`DELETE FROM journal_entry_lines WHERE user_id=${userId}`;
    await sql`DELETE FROM journal_entries WHERE user_id=${userId}`;
    await sql`DELETE FROM "Capital_Transactions" WHERE user_id=${userId}`;
    await sql`DELETE FROM documents WHERE user_id=${userId}`;
    await sql`DELETE FROM cost_basis_state WHERE user_id=${userId}`;
    await sql`DELETE FROM accounts WHERE user_id=${userId}`;
    await sql`DELETE FROM notifications WHERE user_id=${userId}`;
    await sql`DELETE FROM audit_logs WHERE user_id=${userId}`;
    await sql`DELETE FROM user_settings WHERE user_id=${userId}`;
    await sql`DELETE FROM "User" WHERE id=${userId}`;
  }
  await sql.end();
}
