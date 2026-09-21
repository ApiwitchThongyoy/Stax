// DB-free source-level Authorization / User-Isolation guard tests.
//
// These tests inspect the checked-in backend source (route libraries + data
// services) and lock in the invariants verified during the
// backend/user-isolation-audit review:
//   1. Every user-resource API route is registered next to its siblings in
//      app/routes.ts and calls verifyAuth (DB-row-resolved identity).
//   2. Every query/insert on a user-held table is scoped by the authenticated
//      userId — always `auth.userId` or the `userId` service parameter, NEVER a
//      client-supplied identifier (no params/body/query userId).
//   3. Every UPDATE/DELETE on a user-held table carries the userId condition
//      inside its own WHERE clause (no SELECT-then-pre-check race, no unscoped
//      mutation fork).
//   4. Cross-user / missing resources resolve to a safe 404.
//   5. Admin routes reject non-ADMIN callers with 403.
//   6. Service layer (ledger-service, journal-ledger-read, corporate-action-
//      service, statement-pipeline, statement-storage) is userId-scoped.
//   7. Statement duplicate detection is PER-USER: content_hash is only unique
//      per user (user_id, content_hash), so the same PDF in two accounts is NOT
//      a duplicate.
//   8. Storage object keys embed the userId and are generated server-side.
//
// No database or environment variables required — it reads the checked-in
// files. Run:  npx tsx scripts/test-user-isolation.mts
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

// Inspect only the same call chain; never borrow a WHERE from a later query.
function writeIsScoped(src: string, table: string, label: string) {
  const file = ts.createSourceFile("guard.ts", src, ts.ScriptTarget.Latest, true);
  let hits = 0;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["update", "delete"].includes(node.expression.name.text)
      && node.arguments[0]?.getText(file) === table) {
      hits++;
      let chain: ts.Node = node;
      while (chain.parent && (ts.isPropertyAccessExpression(chain.parent) || ts.isCallExpression(chain.parent))) chain = chain.parent;
      const text = chain.getText(file);
      const where = text.slice(text.indexOf(".where("));
      ok(text.includes(".where(") && where.includes(table + ".userId"), label + ": " + table + " mutation has its own ownership WHERE");
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  ok(hits > 0, label + ": writes found");
}

async function main() {
  const routesFile = read("app/routes.ts");

  // ---- 0. Auth surfaces are centralised & DB-authoritative ----
  const authMiddleware = read("app/lib/auth-middleware.ts");
  ok(
    /export async function verifyAuth/.test(authMiddleware) &&
      /user.*role|role.*user/i.test(authMiddleware),
    "verifyAuth resolves userId + role from the DB row (not the JWT body)"
  );
  ok(/authErrorResponse/.test(authMiddleware), "authErrorResponse helper exists");
  ok(
    /status\s*!==\s*["']ACTIVE["']|ACCOUNT_SUSPENDED/.test(authMiddleware),
    "verifyAuth rejects suspended accounts"
  );

  // ---- 1. Route registration ----
  const registered = [
    "api/v1/auth/login",
    "api/v1/auth/register",
    "api/v1/auth/session",
    "api/v1/auth/heartbeat",
    "api/v1/settings",
    "api/v1/notifications",
    "api/v1/notifications/:id/read",
    "api/v1/capital-ledgers",
    "api/v1/capital-ledgers/:id",
    "api/v1/cash-summary",
    "api/v1/corporate-actions",
    "api/v1/corporate-actions/:id",
    "api/v1/accounts",
    "api/v1/journal",
    "api/v1/journal/:id/reverse",
    "api/v1/ledger/accounts/:accountId",
    "api/v1/ledger/summary",
    "api/v1/cost-basis",
    "api/v1/portfolio/:symbol",
    "api/v1/trading-journal",
    "api/v1/trading-journal/:transactionId/note",
    "api/v1/reports/trial-balance",
    "api/v1/reports/income-statement",
    "api/v1/reports/balance-sheet",
    "api/v1/statements/upload",
    "api/v1/statements/preview",
    "api/v1/documents",
    "api/v1/documents/:id",
    "api/v1/documents/:id/download",
    "api/v1/documents/:id/transactions",
    "api/v1/admin/users",
    "api/v1/admin/users/:id",
    "api/v1/admin/stats",
    "api/v1/admin/audit-logs",
    "api/v1/admin/documents",
  ];
  for (const path of registered) {
    ok(routesFile.includes(`"${path}"`), `route registered: ${path}`);
  }

  // Every user-resource route requires authentication (verifyAuth is present).
  const userRouteFiles = [
    "app/routes/api/capital-ledgers.ts",
    "app/routes/api/capital-ledgers.$id.ts",
    "app/routes/api/documents.ts",
    "app/routes/api/documents.$id.ts",
    "app/routes/api/documents.$id.download.ts",
    "app/routes/api/documents.$id.transactions.ts",
    "app/routes/api/notifications.ts",
    "app/routes/api/notifications.$id.read.ts",
    "app/routes/api/corporate-actions.ts",
    "app/routes/api/corporate-actions.$id.ts",
    "app/routes/api/accounts.ts",
    "app/routes/api/journal.ts",
    "app/routes/api/journal.$id.reverse.ts",
    "app/routes/api/ledger.$accountId.ts",
    "app/routes/api/ledger.summary.ts",
    "app/routes/api/cost-basis.ts",
    "app/routes/api/portfolio.$symbol.ts",
    "app/routes/api/trading-journal.ts",
    "app/routes/api/trading-journal.$transactionId.note.ts",
    "app/routes/api/cash-summary.ts",
    "app/routes/api/settings.ts",
    "app/routes/api/statements/upload.ts",
    "app/routes/api/statements/preview.ts",
    "app/routes/api/reports/trial-balance.ts",
    "app/routes/api/reports/income-statement.ts",
    "app/routes/api/reports/balance-sheet.ts",
  ];
  for (const f of userRouteFiles) {
    const src = read(f);
    ok(/verifyAuth\(request\)/.test(src), `${f}: calls verifyAuth(request)`);
    ok(/authErrorResponse\(auth\)/.test(src), `${f}: returns authErrorResponse(auth)`);
    ok(/auth\.userId/.test(src), `${f}: scopes with auth.userId`);
  }

  // ---- 2. No client-supplied identity is ever trusted ----
  for (const f of userRouteFiles) {
    const src = read(f);
    ok(
      !/body\.userId\b|payload\.userId\b|\buserId\s*:\s*body|\buserId\s*:\s*parsedUserId/.test(src),
      `${f}: never reads userId from the body`
    );
    ok(
      !/(?:params|url\.searchParams)\.userId|params\.userId/.test(src),
      `${f}: identity never comes from path/query params`
    );
  }

  // identity sourced from verifyAuth only (heartbeat, session)
  const heartbeat = read("app/routes/api/auth/heartbeat.ts");
  ok(
    /\.where\(eq\(users\.id, auth\.userId\)\)/.test(heartbeat),
    "heartbeat: updates users by auth.userId (never a client id)"
  );

  // ---- 3. UPDATE/DELETE statements are userId-scoped (per file) ----
  writeIsScoped(
    read("app/routes/api/capital-ledgers.$id.ts"),
    "capitalTransactions",
    "capital-ledgers.$id"
  );
  writeIsScoped(
    read("app/routes/api/documents.$id.ts"),
    "documents",
    "documents.$id"
  );
  writeIsScoped(
    read("app/routes/api/documents.$id.ts"),
    "capitalTransactions",
    "documents.$id (cascade)"
  );
  writeIsScoped(
    read("app/routes/api/statements/upload.ts"),
    "documents",
    "statements/upload (cleanup)"
  );
  writeIsScoped(
    read("app/routes/api/notifications.ts"),
    "notifications",
    "notifications (read-all)"
  );
  writeIsScoped(
    read("app/routes/api/notifications.$id.read.ts"),
    "notifications",
    "notifications.$id.read"
  );
  writeIsScoped(
    read("app/routes/api/trading-journal.$transactionId.note.ts"),
    "journalEntries",
    "trading-journal note"
  );
  writeIsScoped(
    read("app/lib/statement-pipeline.ts"),
    "costBasisState",
    "statement-pipeline (cost basis)"
  );
  writeIsScoped(
    read("app/lib/statement-pipeline.ts"),
    "capitalTransactions",
    "statement-pipeline (gain/loss)"
  );
  writeIsScoped(
    read("app/lib/ledger-service.ts"),
    "journalEntryLines",
    "ledger-service (lines)"
  );
  writeIsScoped(
    read("app/lib/ledger-service.ts"),
    "journalEntries",
    "ledger-service (entries)"
  );
  writeIsScoped(
    read("app/lib/corporate-action-service.ts"),
    "corporateActions",
    "corporate-action-service"
  );

  writeIsScoped(read("app/routes/api/settings.ts"), "userSettings", "settings");

  // ---- 4. Service layer is userId-scoped ----
  const ledgerService = read("app/lib/ledger-service.ts");
  const ledgerRead = read("app/lib/journal-ledger-read.ts");
  const corporateSvc = read("app/lib/corporate-action-service.ts");
  const pipeline = read("app/lib/statement-pipeline.ts");
  const statementStorage = read("app/lib/storage/statement-storage.ts");

  ok(
    /export async function insertStatementImport\(\s*userId: string/.test(ledgerService),
    "ledger-service: import takes authoritative userId"
  );

  // createJournalEntry / reverseJournalEntry verify account ownership and scope
  // the mutating where by userId (regression: a forged B accountId in an entry
  // A creates must be rejected as unknown-account, never silently cross-user).
  ok(
    /loadAccountLookup\(userId\)/.test(ledgerService) ||
      /getAccounts\(userId\)/.test(ledgerService),
    "ledger-service: createJournalEntry resolves accounts under the caller's userId"
  );
  ok(
    /eq\(accounts\.userId, userId\)/.test(ledgerService),
    "ledger-service: account lookups are userId-scoped"
  );
  ok(
    /and\(eq\(accounts\.userId, userId\), eq\(accounts\.id, accountId\)\)/.test(ledgerService),
    "ledger-service: getAccountLedger verifies the accountId belongs to the user"
  );
  ok(
    /and\(eq\(journalEntries\.userId, userId\), eq\(journalEntries\.id, entryId\)\)/.test(ledgerService),
    "ledger-service: reverse/remove journal entry is scoped by userId + id"
  );
  ok(
    /and\(eq\(journalEntryLines\.journalEntryId, (?:entryId|owned\.id|id)\), eq\(journalEntryLines\.userId, userId\)\)/.test(ledgerService),
    "ledger-service: journal line mutation is scoped by entryId + userId"
  );

  const ledgerHelpers = [
    "listCapitalLedgerRows",
    "getCapitalLedgerRow",
    "listCapitalLedgerRowsByDocument",
    "listCapitalLedgerRowsBySymbol",
    "listCashSummaryRows",
    "listFxConversionRows",
  ];
  for (const fn of ledgerHelpers) {
    ok(
      new RegExp(`export async function ${fn}\\(\\s*userId`).test(ledgerRead),
      `journal-ledger-read: ${fn} takes userId first`
    );
    ok(
      /eq\(journalEntries\.userId, userId\)/.test(ledgerRead.split("export async function " + fn)[1]?.split("export async function ")[0] ?? ""),
      `journal-ledger-read: ${fn} scopes rows by journalEntries.userId`
    );
  }

  ok(
    /eq\(corporateActions\.userId, userId\)/.test(corporateSvc),
    "corporate-action-service: list/create/delete are userId-scoped"
  );

  ok(
    /eq\(costBasisState\.userId, userId\)/.test(pipeline) &&
      /eq\(capitalTransactions\.userId, userId\)/.test(pipeline),
    "statement-pipeline: cost basis + capital transactions are userId-scoped"
  );

  ok(
    /export async function findExistingDocumentByHash\(\s*userId: string,\s*contentHash: string/.test(
      statementStorage
    ),
    "statement-storage: findExistingDocumentByHash takes userId (per-user dedup)"
  );
  ok(
    /and\(eq\(documents\.userId, userId\), eq\(documents\.contentHash, contentHash\)\)/.test(
      statementStorage
    ),
    "statement-storage: dedup query scopes by user_id AND content_hash"
  );

  // Content-hash uniqueness is per-user: partial unique index on (user_id,
  // content_hash) — the same PDF held by two accounts is NOT a duplicate.
  const schema = read("app/db/schema.ts");
  const hashMigration = read("drizzle/0006_add_document_content_hash.sql");
  ok(
    /uniqueIndex\(["']documents_user_content_hash_key["']\)/.test(schema) &&
      /\.on\(table\.userId, table\.contentHash\)/.test(schema),
    "schema: content-hash uniqueness is per (user_id, content_hash)"
  );
  ok(
    /CREATE UNIQUE INDEX ["']documents_user_content_hash_key["']\s+ON ["']documents["']\s+USING btree\s*\(["']user_id["'],["']content_hash["']\)/.test(
      hashMigration
    ),
    "migration 0006: unique index scoped to (user_id, content_hash)"
  );

  // ---- 5. Cross-user / missing resources resolve to safe 404 ----
  const docsDel = read("app/routes/api/documents.$id.ts");
  ok(
    /eq\(documents\.id, id\), eq\(documents\.userId, auth\.userId\)/.test(docsDel),
    "documents.$id DELETE: ownership in the where clause"
  );
  const docDownload = read("app/routes/api/documents.$id.download.ts");
  ok(
    /eq\(documents\.id, id\), eq\(documents\.userId, auth\.userId\)/.test(docDownload),
    "documents.$id.download: ownership in the where clause (key from own row only)"
  );
  const docTxs = read("app/routes/api/documents.$id.transactions.ts");
  ok(
    /eq\(documents\.id, id\), eq\(documents\.userId, auth\.userId\)/.test(docTxs),
    "documents.$id.transactions: ownership verified before reading rows"
  );
  ok(
    /document.*not found|Document not found/.test(docTxs),
    "documents.$id.transactions: cross-user/missing → safe 404"
  );
  const noteRoute = read("app/routes/api/trading-journal.$transactionId.note.ts");
  ok(
    /eq\(journalEntries\.userId, auth\.userId\)/.test(noteRoute),
    "trading-journal note: ownership in the where clause"
  );
  const notifRead = read("app/routes/api/notifications.$id.read.ts");
  ok(
    /eq\(notifications\.id, id\), eq\(notifications\.userId, auth\.userId\)/.test(notifRead),
    "notifications.$id.read: ownership in the where clause"
  );
  const ledgerRoute = read("app/routes/api/ledger.$accountId.ts");
  ok(
    /getAccountLedger\(auth\.userId, accountId/.test(ledgerRoute),
    "ledger.$accountId: service resolves account under auth.userId"
  );
  const reverseRoute = read("app/routes/api/journal.$id.reverse.ts");
  ok(
    /reverseJournalEntry\(auth\.userId, entryId\)/.test(reverseRoute),
    "journal.$id.reverse: service scopes reversal by auth.userId"
  );
  const corpDel = read("app/routes/api/corporate-actions.$id.ts");
  ok(
    /deleteCorporateAction\(auth\.userId, id\)/.test(corpDel),
    "corporate-actions.$id: service scopes delete by auth.userId"
  );

  // ---- 6. Admin routes: ADMIN-only (403 for everyone else) ----
  const adminFiles = [
    "app/routes/api/admin/users.ts",
    "app/routes/api/admin/users.$id.ts",
    "app/routes/api/admin/stats.ts",
    "app/routes/api/admin/audit-logs.ts",
    "app/routes/api/admin/documents.ts",
  ];
  for (const f of adminFiles) {
    const src = read(f);
    ok(/verifyAuth\(request\)/.test(src), `${f}: requires auth`);
    ok(
      /auth\.role\s*!==\s*["']ADMIN["']/.test(src),
      `${f}: rejects non-ADMIN (role guard)`
    );
    ok(/403/.test(src), `${f}: non-ADMIN → 403`);
  }
  const adminUsersId = read("app/routes/api/admin/users.$id.ts");
  ok(
    /target\.role\s*!==\s*["']USER["']/.test(adminUsersId),
    "admin/users.$id: can only suspend/reactivate USER accounts (admins protected)"
  );

  // ---- 7. Global vs user-scoped tables are deliberately split ----
  const stockPrices = read("app/routes/api/stock-prices.ts");
  const exchangeRates = read("app/routes/api/exchange-rates.ts");
  ok(
    /verifyAuth\(request\)/.test(stockPrices),
    "stock-prices: user-facing read still requires auth"
  );
  ok(
    !/stockPrices\.userId/.test(stockPrices),
    "stock-prices: reference table is global by design (no userId column)"
  );
  ok(
    !/exchangeRateCache\.userId/.test(exchangeRates),
    "exchange-rates: cache table is global by design (no userId column)"
  );

  // ---- 8. Storage keys embed userId server-side ----
  const storageDriver = read("app/lib/storage/storage-driver.ts");
  const uploadRoute = read("app/routes/api/statements/upload.ts");
  ok(
    /buildObjectKey\([^)]*userId/.test(storageDriver),
    "storage-driver: object key embeds userId"
  );
  ok(
    /saveStatementPdf\(\{\s*userId: auth\.userId,\s*file\s*\}\)|saveStatementPdf\(\{[^}]*userId: auth\.userId/.test(uploadRoute),
    "upload: storage object is created under auth.userId (server-side, never client-supplied)"
  );
  ok(
    /findExistingDocumentByHash\(\s*auth\.userId,\s*contentHash\s*\)/.test(uploadRoute),
    "upload: dedup is per-user (auth.userId + contentHash)"
  );
  const previewRoute = read("app/routes/api/statements/preview.ts");
  ok(
    /findExistingDocumentByHash\(\s*auth\.userId,\s*contentHash\s*\)/.test(previewRoute),
    "preview: dedup is per-user (auth.userId + contentHash)"
  );

  const ownership = read("app/lib/resource-ownership.ts");
  ok(ownership.includes('eq(documents.userId, userId)') && ownership.includes('eq(capitalTransactions.userId, userId)'), "reference checks scope both resource tables");
  ok(ownership.includes('.for("share")'), "reference checks hold row locks through the write transaction");
  ok(pipeline.includes('assertOwnedReferences(tx, userId, { sourceDocumentId })') && ledgerService.includes('assertOwnedReferences(tx, userId, entry)'), "both import and journal writes validate references inside transactions");
  ok(!pipeline.includes('userId: row.userId') && !ledgerService.includes('userId: row.userId'), "imports never persist row-supplied userId");
  ok(ledgerService.includes('eq(journalEntries.userId, journalEntryLines.userId)') && ledgerService.includes('eq(accounts.userId, journalEntryLines.userId)'), "aggregate joins require matching owners");

  console.log(`\nPASS: ${passed}   FAIL: ${failed}`);
  if (failed > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
}

main()
  .then(() => process.exit(failed ? 1 : 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });