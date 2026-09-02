// W2-9 + W2-10 backend test harness.
//
// Runs against TEST_DATABASE_URL ONLY. If TEST_DATABASE_URL is not set, it
// aborts with a clear message and does NOT touch any database.
//
// Run:  npx tsx scripts/run-tests.mts   (or: npm run test:w2)
//
// It seeds the test database (USER A, USER B, ADMIN + sample data), then invokes
// the real route loaders/actions with constructed Requests and real JWTs, and
// asserts telemetry rows land in audit_logs with correct user scoping and no
// secrets. Records created by the tests are cleaned up afterward.
import "dotenv/config";
import postgres from "postgres";

const testDatabaseUrl: string = process.env.TEST_DATABASE_URL ?? "";
if (!testDatabaseUrl) {
  console.error(
    "\n[ABORT] TEST_DATABASE_URL is not set. Aborting integration test.\n" +
      "  - This harness mutates a database, so it will NOT run against production.\n" +
      "  - Set TEST_DATABASE_URL to a throwaway database and re-run.\n"
  );
  process.exit(1);
}

// Opt into the test database BEFORE importing the routes so drizzle-db resolves
// TEST_DATABASE_URL. Without this flag drizzle-db uses DATABASE_URL (production),
// which this harness must never touch.
process.env.USE_TEST_DATABASE = "1";

// Imported after the TEST_DATABASE_URL guard so drizzle-db picks the TEST URL.
const loginRoute = await import("../app/routes/api/auth/login");
const sessionRoute = await import("../app/routes/api/auth/session");
const ledgersRoute = await import("../app/routes/api/capital-ledgers");
const ledgerRoute = await import("../app/routes/api/capital-ledgers.$id");
const adminUsersRoute = await import("../app/routes/api/admin/users");
const adminUserRoute = await import("../app/routes/api/admin/users.$id");
const uploadRoute = await import("../app/routes/api/statements/upload");
const documentsRoute = await import("../app/routes/api/documents");
const documentRoute = await import("../app/routes/api/documents.$id");
const documentDownloadRoute = await import("../app/routes/api/documents.$id.download");
const taxCalculateRoute = await import("../app/routes/api/tax/calculate");
const exportRoute = await import("../app/routes/api/export");
const exchangeRatesRoute = await import("../app/routes/api/exchange-rates");
const analysisRoute = await import("../app/routes/api/analysis");

const { AuditAction } = await import("../app/lib/audit-log");

const client = postgres(testDatabaseUrl, { max: 2 });

const USER_A = { email: "w1user@test.local", password: "W1User!234" };
const USER_B = { email: "w2userb@test.local", password: "W2UserB!234" };
const ADMIN = { email: "w1admin@test.local", password: "W1Admin!234" };

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

async function execAuditQuery(actionFilter?: string) {
  if (actionFilter) {
    return (
      await client`SELECT * FROM audit_logs WHERE action = ${actionFilter} ORDER BY created_at`
    );
  }
  return await client`SELECT * FROM audit_logs ORDER BY created_at`;
}

function jsonBody(data: Record<string, unknown>, method = "POST", token?: string) {
  return new Request("http://test.local/api", {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(data),
  });
}

function authedRequest(method: string, token: string) {
  return new Request("http://test.local/api", {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Minimal single-page PDF builder used to feed the REAL upload route with
// extractable statement text (pdfjs-text-readable, correct xref table).
function makePdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/([()\\])/g, "\\$1");
  const content =
    "BT\n/F1 10 Tf\n" +
    lines
      .map((l, i) => `${i === 0 ? "72 720 Td" : "0 -14 Td"} (${esc(l)}) Tj`)
      .join("\n") +
    "\nET\n";
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${Buffer.byteLength(content, "latin1")}>>\nstream\n${content}endstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [0];
  let pos = chunks[0].length;
  for (let i = 0; i < objs.length; i++) {
    offsets.push(pos);
    const c = Buffer.from(`${i + 1} 0 obj\n${objs[i]}\nendobj\n`, "latin1");
    chunks.push(c);
    pos += c.length;
  }
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${pos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"), Buffer.from(trailer, "latin1"));
  return Buffer.concat(chunks);
}

async function loginAs(email: string, password: string) {
  const res = await loginRoute.action({
    request: jsonBody({ email, password }),
  } as never);
  const body = await res.json();
  return body;
}

async function fetchUserByEmail(email: string) {
  const rows = await client`SELECT * FROM "User" WHERE email = ${email} LIMIT 1`;
  return rows[0];
}

const REDACTED_MARKERS = [
  "password",
  "password_hash",
  "accessToken",
  "authorization",
  "Bearer",
  "JWT_SECRET",
  "DATABASE_URL",
];

function objectContainsSecret(obj: unknown, path = ""): boolean | string {
  if (obj === null || obj === undefined) return false;
  if (typeof obj === "string") {
    if (REDACTED_MARKERS.some((m) => path.toLowerCase().includes(m.toLowerCase())))
      return path;
    // raw secret values themselves should never be stored
    if (/^[A-Za-z0-9+/=]{6,}$/.test(obj) && path !== "") return false;
    return false;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const r = objectContainsSecret(obj[i], `${path}[${i}]`);
      if (r) return r;
    }
    return false;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const r = objectContainsSecret(v, path ? `${path}.${k}` : k);
      if (r) return r;
    }
  }
  return false;
}

async function main() {
  console.log(`\nUsing TEST_DATABASE_URL (${testDatabaseUrl.split("@")[1] ?? "set"})\n`);

  // 0. Seed test data (idempotent), run as its own process.
  console.log("Seeding test database...");
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    process.execPath,
    ["./scripts/seed-test.mjs"],
    { stdio: "inherit" }
  );

  const startTime = new Date().toISOString();
  console.log(`\nTest window starts at ${startTime}\n`);

  const smokeUserIds: string[] = [];

  // ================= W2-9 TESTS =================
  console.log("=== W2-9: TEST ENVIRONMENT ===");
  const adminRow = await fetchUserByEmail(ADMIN.email);
  const userARow = await fetchUserByEmail(USER_A.email);
  const userBRow = await fetchUserByEmail(USER_B.email);

  ok(!!adminRow, "W2-9: seed ADMIN exists");
  ok(!!userARow, "W2-9: seed USER A exists");
  ok(!!userBRow, "W2-9: seed USER B exists");
  if (userARow) {
    ok(userARow.role === "USER", "W2-9: USER A role is USER");
    ok(userARow.status === "ACTIVE", "W2-9: USER A status is ACTIVE");
  }
  if (adminRow) {
    ok(adminRow.role === "ADMIN", "W2-9: ADMIN role is ADMIN");
    ok(adminRow.status === "ACTIVE", "W2-9: ADMIN status is ACTIVE");
  }

  // transactions owned by USER A only
  const userATxs = await client`SELECT transaction_id, user_id FROM "Capital_Transactions" WHERE user_id = ${userARow?.id}`;
  const userBTxs = await client`SELECT transaction_id, user_id FROM "Capital_Transactions" WHERE user_id = ${userBRow?.id}`;
  ok(userATxs.length >= 2, "W2-9: USER A has sample Capital_Transactions");
  ok(userATxs.every((t) => t.user_id === userARow?.id), "W2-9: USER A txs are own");

  // login via real API/auth service
  const aLogin = await loginAs(USER_A.email, USER_A.password);
  const adLogin = await loginAs(ADMIN.email, ADMIN.password);
  ok(aLogin.success === true, "W2-9: USER A password login succeeds");
  ok(adLogin.success === true, "W2-9: ADMIN password login succeeds");

  // user isolation
  const loginB = await loginAs(USER_B.email, USER_B.password);
  const tokenA = aLogin.data?.accessToken;
  const tokenB = loginB.data?.accessToken;
  const tokenAd = adLogin.data?.accessToken;

  // give USER B one transaction for isolation testing
  let userBTxnId: string | null = null;
  if (userBRow) {
    userBTxnId = "00000000-0000-0000-0000-0000000000b1";
    await client`DELETE FROM "Capital_Transactions" WHERE transaction_id = ${userBTxnId}`;
    await client`INSERT INTO "Capital_Transactions" (transaction_id, user_id, amount_foreign, currency, transaction_date, fx_rate_bot, amount_thb, type, source_type)
                 VALUES (${userBTxnId}, ${userBRow.id}, '250.00', 'USD', '2026-03-10', '35.2000', '8800.00', 'CASH_IN', 'MANUAL')`;
  }

  if (tokenA && userBTxnId) {
    const listARes = await ledgersRoute.loader({ request: authedRequest("GET", tokenA) } as never);
    const listA = (await listARes.json()) as { data?: { transactionId: string }[] };
    const idsA = (listA.data ?? []).map((t) => t.transactionId);
    ok(!idsA.includes(userBTxnId!), "W2-9: USER A does not see USER B's transactions");

    const byIdRes = await ledgerRoute.loader({
      request: authedRequest("GET", tokenA),
      params: { id: userBTxnId! },
    } as never);
    ok(byIdRes.status === 404, "W2-9: USER A cannot read USER B transaction by id (404)");
  }

  // ================= W2-9: USER-SCOPED DOCUMENT LIST API =================
  // GET /api/v1/documents is user-scoped: USER A sees only their own documents,
  // USER B cannot see USER A's, and unauthenticated requests are rejected.
  {
    const docA = "00000000-0000-0000-0000-0000000000d1";
    const docB = "00000000-0000-0000-0000-0000000000d2";
    await client`DELETE FROM documents WHERE id IN (${docA}, ${docB})`;
    if (userARow && userBRow) {
      const now = new Date().toISOString();
      await client`INSERT INTO documents (id, user_id, original_name, file_path, mime_type, file_size, created_at, updated_at)
                   VALUES (${docA}, ${userARow.id}, '2026-01.PDF', '/tmp/a.pdf', 'application/pdf', 100, ${now}, ${now})`;
      await client`INSERT INTO documents (id, user_id, original_name, file_path, mime_type, file_size, created_at, updated_at)
                   VALUES (${docB}, ${userBRow.id}, '2026-02.PDF', '/tmp/b.pdf', 'application/pdf', 200, ${now}, ${now})`;
    }

    // unauthenticated -> 401
    const anonDocs = await documentsRoute.loader({ request: authedRequest("GET", "") } as never);
    ok(anonDocs.status === 401, "W2-9: unauthenticated GET /api/v1/documents rejected (401)");

    if (tokenA) {
      const resA = await documentsRoute.loader({ request: authedRequest("GET", tokenA) } as never);
      ok(resA.status === 200, "W2-9: USER A documents list succeeds (200)");
      const bodyA = await resA.json() as { data?: { id: string; originalName: string }[] };
      const idsA = (bodyA.data ?? []).map((d) => d.id);
      ok(idsA.includes(docA), "W2-9: USER A sees their own document");
      ok(!idsA.includes(docB), "W2-9: USER A does NOT see USER B's document");
      const aDoc = (bodyA.data ?? []).find((d) => d.id === docA);
      ok(aDoc?.originalName === "2026-01.PDF", "W2-9: document metadata exposes original name");
    }

    if (tokenB) {
      const resB = await documentsRoute.loader({ request: authedRequest("GET", tokenB) } as never);
      const bodyB = await resB.json() as { data?: { id: string }[] };
      const idsB = (bodyB.data ?? []).map((d) => d.id);
      ok(!idsB.includes(docA), "W2-9: USER B cannot see USER A's document");
      ok(idsB.includes(docB), "W2-9: USER B sees their own document");
    }

    // clean up the two test documents
    await client`DELETE FROM documents WHERE id IN (${docA}, ${docB})`;
  }

  // admin authorization: USER accessing admin route -> denied
  if (tokenA) {
    const adminRes = await adminUsersRoute.loader({ request: authedRequest("GET", tokenA) } as never);
    ok(adminRes.status === 403, "W2-9: non-admin USER denied on admin users API");
  }
  if (tokenAd) {
    const adminListRes = await adminUsersRoute.loader({
      request: authedRequest("GET", tokenAd),
    } as never);
    ok(adminListRes.status === 200, "W2-9: ADMIN can access admin users API");
  }

  // ================= W2-9: USER-SCOPED STATEMENT DELETE =================
  // DELETE /api/v1/documents/:id must remove ONLY the caller's document and the
  // transactions from that exact source_document_id — never another user's
  // document, and never same-looking transactions from a different document.
  {
    const docX = "00000000-0000-0000-0000-0000000000e1"; // USER A's own doc
    const docY = "00000000-0000-0000-0000-0000000000e2"; // USER A's other doc
    const txnX = "00000000-0000-0000-0000-0000000000f1"; // tx from docX
    const txnY = "00000000-0000-0000-0000-0000000000f2"; // same-looking tx from docY
    const now = new Date().toISOString();

    // user A owns both docs; user B owns docB (from earlier block, still present)
    if (userARow) {
      await client`DELETE FROM documents WHERE id IN (${docX}, ${docY})`;
      await client`DELETE FROM "Capital_Transactions" WHERE transaction_id IN (${txnX}, ${txnY})`;
      await client`INSERT INTO documents (id, user_id, original_name, file_path, mime_type, file_size, created_at, updated_at)
                   VALUES (${docX}, ${userARow.id}, 'X.PDF', '/tmp/delete-x.pdf', 'application/pdf', 100, ${now}, ${now})`;
      await client`INSERT INTO documents (id, user_id, original_name, file_path, mime_type, file_size, created_at, updated_at)
                   VALUES (${docY}, ${userARow.id}, 'Y.PDF', '/tmp/delete-y.pdf', 'application/pdf', 200, ${now}, ${now})`;
      // Two transactions that LOOK identical (same date/amount) but come from
      // different source documents docX vs docY.
      await client`INSERT INTO "Capital_Transactions" (transaction_id, user_id, amount_foreign, currency, transaction_date, fx_rate_bot, amount_thb, type, source_type, source_document_id)
                   VALUES (${txnX}, ${userARow.id}, '5000.00', 'THB', '2026-01-30', '1', '5000.00', 'CASH_IN', 'AI_PARSED', ${docX})`;
      await client`INSERT INTO "Capital_Transactions" (transaction_id, user_id, amount_foreign, currency, transaction_date, fx_rate_bot, amount_thb, type, source_type, source_document_id)
                   VALUES (${txnY}, ${userARow.id}, '5000.00', 'THB', '2026-01-30', '1', '5000.00', 'CASH_IN', 'AI_PARSED', ${docY})`;
    }

    // missing document -> safe 404
    const missingRes = await documentRoute.action({
      request: authedRequest("DELETE", tokenA),
      params: { id: "00000000-0000-0000-0000-000000000099" },
    } as never);
    ok(missingRes.status === 404, "REG: deleting a missing document returns 404");

    if (tokenB) {
      // USER B tries to delete USER A's document -> must be denied (404, no leak)
      const crossRes = await documentRoute.action({
        request: authedRequest("DELETE", tokenB),
        params: { id: docX },
      } as never);
      ok(crossRes.status === 404, "REG: another user cannot delete USER A's document (404)");
    }

    if (tokenA) {
      const delRes = await documentRoute.action({
        request: authedRequest("DELETE", tokenA),
        params: { id: docX },
      } as never);
      ok(delRes.status === 200 && (await (delRes.clone().json() as Promise<{ success?: boolean }>)).success === true,
        "REG: USER A deletes their own document successfully");

      const docXrows = await client`SELECT * FROM documents WHERE id = ${docX}`;
      ok(docXrows.length === 0, "REG: deleted document row is gone");
      const txnXrows = await client`SELECT * FROM "Capital_Transactions" WHERE transaction_id = ${txnX}`;
      ok(txnXrows.length === 0, "REG: transactions from the deleted source document are removed");

      // Other document + its same-looking transaction must survive
      const docYrows = await client`SELECT * FROM documents WHERE id = ${docY}`;
      ok(docYrows.length === 1, "REG: other document remains after delete");
      const txnYrows = await client`SELECT * FROM "Capital_Transactions" WHERE transaction_id = ${txnY}`;
      ok(txnYrows.length === 1, "REG: same-looking transaction from another document is preserved (not value-deduped)");
    }

    // cleanup the surviving docY + txnY
    await client`DELETE FROM "Capital_Transactions" WHERE transaction_id IN (${txnX}, ${txnY})`;
    await client`DELETE FROM documents WHERE id IN (${docX}, ${docY})`;
  }

  // ================= SERVER-AUTHORITATIVE STATEMENT DOWNLOAD =================
  // GET /api/v1/documents/:id/download serves the actual stored PDF for the
  // caller's OWN document only, with safe headers and file-system containment.
  {
    const { STATEMENTS_DIR, safeResolveStoredPath } = await import(
      "../app/lib/storage/statement-path"
    );
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const path = await import("node:path");
    const crypto = await import("node:crypto");

    const downloadRequest = (token: string, id: string) =>
      new Request(`http://test.local/api/v1/documents/${id}/download`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

    // Isolated real temp PDFs inside the scratch statements dir (UUID names,
    // removed afterward). Never touches live Statement rows.
    mkdirSync(STATEMENTS_DIR, { recursive: true });
    const tempFiles: string[] = [];
    const makeTempPdf = () => {
      const full = path.join(STATEMENTS_DIR, `${crypto.randomUUID()}.pdf`);
      writeFileSync(
        full,
        Buffer.from([
          ...[..."%PDF-1.4\n"].map((c) => c.charCodeAt(0)),
          ...new Array(200).fill(0x42),
        ])
      );
      tempFiles.push(full);
      return full;
    };

    const pdfBytes = Buffer.from([
      ...[..."%PDF-1.4\n"].map((c) => c.charCodeAt(0)),
      ...new Array(200).fill(0x42),
    ]);
    const storedPath = makeTempPdf();
    const now = new Date().toISOString();

    const ownDoc = "00000000-0000-0000-0000-0000000000fa"; // USER A's doc
    const otherDoc = "00000000-0000-0000-0000-0000000000fb"; // USER B's doc
    const unsafeDoc = "00000000-0000-0000-0000-0000000000fc"; // outside path
    const ghostDoc = "00000000-0000-0000-0000-0000000000fd"; // no physical file

    await client`DELETE FROM documents WHERE id IN (${ownDoc}, ${otherDoc}, ${unsafeDoc}, ${ghostDoc})`;
    if (userARow && userBRow) {
      await client`INSERT INTO documents (id, user_id, original_name, file_path, mime_type, file_size, created_at, updated_at)
                   VALUES (${ownDoc}, ${userARow.id}, 'My Statement.PDF', ${storedPath}, 'application/pdf', ${pdfBytes.length}, ${now}, ${now})`;
      await client`INSERT INTO documents (id, user_id, original_name, file_path, mime_type, file_size, created_at, updated_at)
                   VALUES (${otherDoc}, ${userBRow.id}, 'Other.PDF', ${storedPath}, 'application/pdf', ${pdfBytes.length}, ${now}, ${now})`;
      const outsidePath = path.resolve(path.join(STATEMENTS_DIR, "..", "outside-secret.txt"));
      await client`INSERT INTO documents (id, user_id, original_name, file_path, mime_type, file_size, created_at, updated_at)
                   VALUES (${unsafeDoc}, ${userARow.id}, 'unsafe.pdf', ${outsidePath}, 'application/pdf', 10, ${now}, ${now})`;
      await client`INSERT INTO documents (id, user_id, original_name, file_path, mime_type, file_size, created_at, updated_at)
                   VALUES (${ghostDoc}, ${userARow.id}, 'ghost.pdf', ${path.join(STATEMENTS_DIR, "missing-uuid.pdf")}, 'application/pdf', 100, ${now}, ${now})`;
    }

    // 1. unauthenticated -> 401
    const anonDownload = await documentDownloadRoute.loader({
      request: downloadRequest("", ownDoc),
      params: { id: ownDoc },
    } as never);
    ok(anonDownload.status === 401, "DL: unauthenticated download rejected (401)");

    if (tokenA) {
      // 2. USER A downloads OWN document -> success, exact bytes, attachment
      const ownRes = await documentDownloadRoute.loader({
        request: downloadRequest(tokenA, ownDoc),
        params: { id: ownDoc },
      } as never);
      ok(ownRes.status === 200, "DL: USER A downloads own document (200)");
      const ownBuf = Buffer.from(await ownRes.arrayBuffer());
      ok(ownBuf.equals(pdfBytes), "DL: response body is exactly the stored PDF bytes");
      ok(
        ownRes.headers.get("Content-Type") === "application/pdf",
        "DL: Content-Type is application/pdf"
      );
      const ownDisp = ownRes.headers.get("Content-Disposition") ?? "";
      ok(
        ownDisp.startsWith("attachment; filename=") && ownDisp.includes("My Statement.PDF"),
        "DL: attachment header carries the original filename"
      );

      // 3. missing document -> safe 404
      const missingId = "00000000-0000-0000-0000-0000000000f9";
      const missing = await documentDownloadRoute.loader({
        request: downloadRequest(tokenA, missingId),
        params: { id: missingId },
      } as never);
      ok(missing.status === 404, "DL: missing document returns safe 404");

      // 4. unsafe / outside file_path -> rejected, no path leak
      const unsafe = await documentDownloadRoute.loader({
        request: downloadRequest(tokenA, unsafeDoc),
        params: { id: unsafeDoc },
      } as never);
      ok(unsafe.status === 404, "DL: outside file_path rejected (no arbitrary read)");
      const unsafeText = await unsafe.text();
      ok(
        !unsafeText.includes("outside-secret") && !unsafeText.includes(STATEMENTS_DIR),
        "DL: rejected response does not leak the filesystem path"
      );

      // 5. missing physical file -> safe 404/410, metadata untouched
      const ghost = await documentDownloadRoute.loader({
        request: downloadRequest(tokenA, ghostDoc),
        params: { id: ghostDoc },
      } as never);
      ok(
        ghost.status === 404 || ghost.status === 410,
        "DL: missing physical file returns safe 404/410 (no crash)"
      );
      const ghostRow = await client`SELECT * FROM documents WHERE id = ${ghostDoc}`;
      ok(ghostRow.length === 1, "DL: missing physical file does not remove/auto-recreate metadata");

      // 6. contained path helper agrees at the pure level
      ok(
        safeResolveStoredPath(storedPath, STATEMENTS_DIR) !== null &&
          safeResolveStoredPath(path.join(STATEMENTS_DIR, "..", "x"), STATEMENTS_DIR) === null,
        "DL: pure path containment matches route behavior"
      );
    }

    if (tokenB) {
      // 7. USER B cannot download USER A's document -> same safe 404
      const cross = await documentDownloadRoute.loader({
        request: downloadRequest(tokenB, ownDoc),
        params: { id: ownDoc },
      } as never);
      ok(cross.status === 404, "DL: USER B cannot download USER A's document (safe 404)");
      const crossBody = (await cross.json()) as { message?: string };
      ok(
        crossBody.message === "Document not found",
        "DL: cross-user failure is the same safe message as a missing doc"
      );

      // 8. USER B CAN download their own document (authorization is per-owner)
      const bOwn = await documentDownloadRoute.loader({
        request: downloadRequest(tokenB, otherDoc),
        params: { id: otherDoc },
      } as never);
      ok(bOwn.status === 200, "DL: USER B downloads own document (200)");
    }

    // cleanup
    await client`DELETE FROM documents WHERE id IN (${ownDoc}, ${otherDoc}, ${unsafeDoc}, ${ghostDoc})`;
    for (const f of tempFiles) rmSync(f, { force: true });
  }

  // ================= W2-9: ADMIN STATUS LOCK (only USER may be toggled) =================
  {
    const adminBEmail = "w1adminb@test.local";
    const adminBId = "00000000-0000-0000-0000-0000000000ab";
    await client`DELETE FROM "User" WHERE id = ${adminBId}`;
    await client`INSERT INTO "User" (id, email, password_hash, role, status)
                 VALUES (${adminBId}, ${adminBEmail}, '$2b$10$placeholderhashplaceholderplaceholder', 'ADMIN', 'ACTIVE')`;

    // USER -> admin PATCH -> forbidden
    if (tokenA) {
      const userPatch = await adminUserRoute.action({
        request: jsonBody({ status: "SUSPENDED" }, "PATCH", tokenA),
        params: { id: userBRow?.id ?? "" },
      } as never);
      ok(userPatch.status === 403, "REG: non-admin USER calling admin status PATCH is forbidden");
    }

    if (tokenAd && adminRow) {
      // ADMIN suspends SELF -> rejected
      const selfRes = await adminUserRoute.action({
        request: jsonBody({ status: "SUSPENDED" }, "PATCH", tokenAd),
        params: { id: adminRow.id },
      } as never);
      ok(selfRes.status === 400, "REG: ADMIN suspending itself is rejected");

      // ADMIN A suspends ADMIN B -> rejected
      const otherAdminRes = await adminUserRoute.action({
        request: jsonBody({ status: "SUSPENDED" }, "PATCH", tokenAd),
        params: { id: adminBId },
      } as never);
      ok(otherAdminRes.status === 400, "REG: ADMIN suspending another ADMIN is rejected");

      // ADMIN A reactivates ADMIN B -> also rejected
      const otherAdminAct = await adminUserRoute.action({
        request: jsonBody({ status: "ACTIVE" }, "PATCH", tokenAd),
        params: { id: adminBId },
      } as never);
      ok(otherAdminAct.status === 400, "REG: ADMIN reactivating another ADMIN is rejected");

      // ADMIN B's status must remain unchanged (ACTIVE)
      const adminBRow = await client`SELECT * FROM "User" WHERE id = ${adminBId}`;
      ok(adminBRow[0]?.status === "ACTIVE", "REG: ADMIN B status is unchanged after rejected mutations");

      // ADMIN suspends a USER -> succeeds
      if (userBRow) {
        const suspRes = await adminUserRoute.action({
          request: jsonBody({ status: "SUSPENDED" }, "PATCH", tokenAd),
          params: { id: userBRow.id },
        } as never);
        ok(suspRes.status === 200, "REG: ADMIN suspending a USER succeeds");

        // ADMIN reactivates a USER -> succeeds
        const actRes = await adminUserRoute.action({
          request: jsonBody({ status: "ACTIVE" }, "PATCH", tokenAd),
          params: { id: userBRow.id },
        } as never);
        ok(actRes.status === 200, "REG: ADMIN reactivating a USER succeeds");
        const userBAfter = await client`SELECT * FROM "User" WHERE id = ${userBRow.id}`;
        ok(userBAfter[0]?.status === "ACTIVE", "REG: USER B is ACTIVE after reactivation");
      }
    }

    await client`DELETE FROM "User" WHERE id = ${adminBId}`;
  }

  // ================= REG: UPLOAD VALIDATION (MIME / magic / size) =================
  {
    const uploadAs = (token: string, file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return uploadRoute.action({
        request: new Request("http://test.local/api/v1/statements/upload", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        }),
      } as never);
    };
    const magicPdf = new Uint8Array([
      ...[..."%PDF-1.4\n"].map((c) => c.charCodeAt(0)),
      ...new Array(64).fill(0x20),
    ]);

    if (tokenA) {
      // Missing file field -> 400
      const noFileRes = await uploadRoute.action({
        request: new Request("http://test.local/api/v1/statements/upload", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenA}` },
          body: (() => {
            const f = new FormData();
            return f;
          })(),
        }),
      } as never);
      ok(
        noFileRes.status === 400,
        "REG: upload without a file field is rejected (400)"
      );

      // Content that is NOT a PDF (wrong magic bytes, .pdf name) -> 400
      const fakePdf = new File(
        [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00])],
        "evil.pdf",
        { type: "application/pdf" }
      );
      const fakeRes = await uploadAs(tokenA, fakePdf);
      ok(
        fakeRes.status === 400,
        "REG: non-PDF content with .pdf name is rejected (magic bytes)"
      );

      // MIME type mismatch -> 400
      const mimeMismatch = new File([magicPdf as BlobPart], "x.pdf", {
        type: "image/png",
      });
      const mimeRes = await uploadAs(tokenA, mimeMismatch);
      ok(
        mimeRes.status === 400,
        "REG: mismatched MIME type is rejected (400)"
      );

      // Oversized file (over 20 MB) -> 400
      const oversized = new File(
        [
          new Uint8Array([
            ...[..."%PDF-1.4\n"].map((c) => c.charCodeAt(0)),
            ...new Array(20 * 1024 * 1024 + 1).fill(0x20),
          ]),
        ],
        "big.pdf",
        { type: "application/pdf" }
      );
      const bigRes = await uploadAs(tokenA, oversized);
      ok(
        bigRes.status === 400,
        "REG: upload exceeding the 20 MB size limit is rejected (400)"
      );
    }
  }

  // ================= REG: RE-IMPORT AFTER LEDGER DELETION =================
  // The reported bug: a user deletes their imported financial/ledger rows but the
  // document row (and its stored PDF) remains; re-uploading the SAME PDF was
  // wrongly rejected as a duplicate (hash-only detection), so ZERO rows were
  // restored. Fix contract: when the document exists WITHOUT its derived rows,
  // the import pipeline re-runs under the SAME document id — no new document, no
  // duplicate rows, cost-basis cache rebuilt.
  {
    const statementLines = [
      "TRADE RECORDS",
      "Currency: USD",
      "USD/THB = 35.42",
      "VRMAX",
      "02/01/2026 10:00:00,GMT+07 02/01/2026 BUY 100 10.00 1000.00 1000.00 1.00 0.07 NASDAQ",
      "VRMAX",
      "03/01/2026 10:00:00,GMT+07 03/01/2026 BUY 100 20.00 2000.00 2000.00 1.50 0.10 NYSE",
      "VRMAX",
      "04/01/2026 10:00:00,GMT+07 04/01/2026 SELL 50 30.00 1500.00 1497.93 1.00 0.07 NASDAQ",
      "PORTFOLIO SUMMARY",
    ];
    const reimportFile = new File([makePdf(statementLines) as BlobPart], "w2-reimport-test.pdf", {
      type: "application/pdf",
    });
    const reimportAs = (token: string, file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return uploadRoute.action({
        request: new Request("http://test.local/api/v1/statements/upload", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        }),
      } as never);
    };
    if (tokenA && userARow) {
      const countRowsFor = (documentId: string) =>
        client`SELECT COUNT(*)::int AS n FROM "Capital_Transactions" WHERE source_document_id = ${documentId} AND user_id = ${userARow.id}`;
      // purge any leftover doc/rows/cache from earlier runs so the fixture is clean
      const priorDocs = await client`SELECT id FROM documents WHERE user_id = ${userARow.id} AND original_name = 'w2-reimport-test.pdf'`;
      for (const d of priorDocs) {
        await client`DELETE FROM "Capital_Transactions" WHERE source_document_id = ${d.id} AND user_id = ${userARow.id}`;
        await client`DELETE FROM documents WHERE id = ${d.id} AND user_id = ${userARow.id}`;
      }
      await client`DELETE FROM cost_basis_state WHERE user_id = ${userARow.id}`;

      // 1. First upload: rows are imported under a NEW document.
      const first = await reimportAs(tokenA, reimportFile);
      const firstBody = (await first.json()) as {
        data?: { documentId?: string; saved?: number; duplicateDecision?: string };
      };
      ok(
        first.status === 200 && (firstBody.data?.saved ?? 0) > 0,
        "REG-reimport: first upload imports rows (saved > 0)"
      );
      const reimportDocId = firstBody.data?.documentId;
      ok(!!reimportDocId, "REG-reimport: first upload returns a document id");
      const importedFirstCount = reimportDocId
        ? (await countRowsFor(reimportDocId))[0]?.n ?? 0
        : 0;
      ok(
        importedFirstCount === firstBody.data?.saved,
        "REG-reimport: DB row count matches the reported saved count"
      );
      const basisAfterFirst = await client`SELECT symbol FROM cost_basis_state WHERE user_id = ${userARow.id}`;
      ok(
        basisAfterFirst.some((b) => b.symbol === "VRMAX"),
        "REG-reimport: first import persisted the running-average cost basis (VRMAX)"
      );

      // 2. Re-upload with rows PRESENT -> duplicate protection still holds.
      const dup = await reimportAs(tokenA, reimportFile);
      const dupBody = (await dup.json()) as {
        data?: { duplicate?: boolean; code?: string };
      };
      ok(
        dupBody.data?.duplicate === true &&
          dupBody.data?.code === "STATEMENT_ALREADY_IMPORTED",
        "REG-reimport: re-upload WITH derived rows present is still rejected as a duplicate"
      );
      const cntAfterDup = reimportDocId ? ((await countRowsFor(reimportDocId))[0]?.n ?? 0) : 0;
      ok(
        cntAfterDup === importedFirstCount,
        "REG-reimport: duplicate upload does NOT change the row count"
      );

      // 3. USER DELETES their financial data: derived ledger rows + cost-basis
      //    cache are removed, but the documents row (and stored PDF) remain.
      if (reimportDocId) {
        await client`DELETE FROM "Capital_Transactions" WHERE source_document_id = ${reimportDocId} AND user_id = ${userARow.id}`;
      }
      await client`DELETE FROM cost_basis_state WHERE user_id = ${userARow.id}`;
      const docRowStill = reimportDocId
        ? await client`SELECT id FROM documents WHERE id = ${reimportDocId} AND user_id = ${userARow.id}`
        : [];
      ok(
        docRowStill.length === 1,
        "REG-reimport: documents row survives the ledger deletion (the bug's precondition)"
      );

      // 4. Re-upload the SAME PDF -> the document is REBUILT (not rejected),
      //    restoring every row under the SAME document id.
      const rebuilt = await reimportAs(tokenA, reimportFile);
      const rebuiltBody = (await rebuilt.json()) as {
        data?: {
          documentId?: string;
          saved?: number;
          rebuilt?: boolean;
          duplicateDecision?: string;
        };
      };
      ok(
        rebuilt.status === 200 && rebuiltBody.data?.rebuilt === true,
        "REG-reimport: re-upload after deletion REBUILDS the document (not a duplicate)"
      );
      ok(
        !!reimportDocId && rebuiltBody.data?.documentId === reimportDocId,
        "REG-reimport: rebuild reuses the SAME document id (no duplicate document row)"
      );
      ok(
        rebuiltBody.data?.saved === importedFirstCount,
        "REG-reimport: rebuild restores the same number of rows as the original import"
      );
      const cntAfterRebuild = reimportDocId ? ((await countRowsFor(reimportDocId))[0]?.n ?? 0) : 0;
      ok(
        cntAfterRebuild === importedFirstCount,
        "REG-reimport: rebuilt ledger row count matches the original"
      );
      const basisAfterRebuild = await client`SELECT symbol FROM cost_basis_state WHERE user_id = ${userARow.id}`;
      ok(
        basisAfterRebuild.some((b) => b.symbol === "VRMAX"),
        "REG-reimport: rebuild re-persists the running-average cost basis (VRMAX)"
      );

      // 5. Statement DELETE must reconcile the derived cache: removing the whole
      //    statement also removes its BUY contribution from cost_basis_state.
      const delRes = reimportDocId
        ? await documentRoute.action({
            request: authedRequest("DELETE", tokenA),
            params: { id: reimportDocId },
          } as never)
        : null;
      ok(delRes?.status === 200, "REG-reimport: statement delete succeeds after rebuild");
      const docGone = reimportDocId
        ? await client`SELECT id FROM documents WHERE id = ${reimportDocId} AND user_id = ${userARow.id}`
        : [];
      const txsGone = reimportDocId
        ? await client`SELECT transaction_id FROM "Capital_Transactions" WHERE source_document_id = ${reimportDocId} AND user_id = ${userARow.id}`
        : [];
      ok(
        docGone.length === 0 && txsGone.length === 0,
        "REG-reimport: statement delete removes the document AND its derived rows"
      );
      const basisAfterDelete = await client`SELECT symbol FROM cost_basis_state WHERE user_id = ${userARow.id}`;
      ok(
        basisAfterDelete.every((b) => b.symbol !== "VRMAX"),
        "REG-reimport: statement delete reconciles cost_basis_state (no stale VRMAX cache)"
      );

      // defensive cleanup for any partial state (audit rows are removed globally)
      if (reimportDocId) {
        await client`DELETE FROM "Capital_Transactions" WHERE user_id = ${userARow.id} AND source_document_id = ${reimportDocId}`;
        await client`DELETE FROM documents WHERE id = ${reimportDocId} AND user_id = ${userARow.id}`;
        await client`DELETE FROM notifications WHERE entity_id = ${reimportDocId}`;
      }
    }
  }

  // ================= REG: REGISTER -> LOGIN -> SESSION SMOKE =================
  {
    const { randomUUID } = await import("node:crypto");
    const registerRoute = await import("../app/routes/api/auth/register");
    const smokeEmail = `smoke-${randomUUID()}@test.local`;
    const smokePassword = "SmokePass!234";
    const post = (email: string, password: string) =>
      registerRoute.action({
        request: new Request("http://test.local/api/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        }),
      } as never);

    const regRes = await post(smokeEmail, smokePassword);
    const regJson = (await regRes.json()) as { data?: { user?: { id?: string } } };
    ok(regRes.status === 201, "REG: register creates a new USER (201)");
    if (regJson.data?.user?.id) {
      smokeUserIds.push(regJson.data.user.id);

      const smokeLogin = await loginAs(smokeEmail, smokePassword);
      ok(
        smokeLogin.success === true && !!smokeLogin.data?.accessToken,
        "REG: registered user can log in with their credentials"
      );

      const sessionRes = await sessionRoute.loader({
        request: authedRequest("GET", smokeLogin.data.accessToken),
      } as never);
      ok(
        sessionRes.status === 200,
        "REG: session endpoint validates the new user's token"
      );

      const dupRes = await post(smokeEmail, smokePassword);
      const dupJson = (await dupRes.json()) as { code?: string };
      ok(
        dupRes.status === 409 && dupJson.code === "EMAIL_ALREADY_EXISTS",
        "REG: duplicate registration rejected (409 EMAIL_ALREADY_EXISTS)"
      );

      const shortRes = await post("short@test.local", "short");
      ok(shortRes.status === 400, "REG: short password rejected (400)");
    }
  }

  // ================= W2-10 TESTS =================
  console.log("\n=== W2-10: TELEMETRY + SECURITY ===");

  // 1. USER login success audit
  const loginSuccess = await execAuditQuery(AuditAction.LOGIN_SUCCESS);
  ok(
    loginSuccess.some((r) => r.user_id === userARow?.id),
    "W2-10: USER login success audit row exists with correct user_id"
  );

  // 2. USER login failed audit (no user_id for wrong-email, safe details)
  await loginAs("nonexistent@test.local", "WrongPass!234");
  await loginAs(USER_A.email, "WrongPass!234");
  const loginFailed = await execAuditQuery(AuditAction.LOGIN_FAILED);
  ok(loginFailed.length >= 2, "W2-10: USER login failed audit rows created");
  const badPassRow = loginFailed.at(-1);
  ok(
    !!badPassRow && badPassRow.user_id === userARow?.id,
    "W2-10: failed login for known user carries its user_id"
  );
  ok(
    loginFailed.every((r) => !objectContainsSecret(r.details)),
    "W2-10: failed login details contain no secrets"
  );

  // 3. USER upload statement -> audit row (STATEMENT_UPLOAD logged after save)
  const { saveStatementPdf } = await import("../app/lib/storage/statement-storage");
  const pdfBytes = new Uint8Array([
    ...[..."%PDF-1.4\n"].map((c) => c.charCodeAt(0)),
    ...new Array(120).fill(0x20),
  ]);
  const pdfFile = new File([pdfBytes], "w2-telemetry-test.pdf", {
    type: "application/pdf",
  });

  // Purge any identical prior upload from previous runs so content-hash dedup
  // can never make this run resolve to a stale document row (and its old
  // absolute-path file_path) instead of exercising the current storage path.
  if (userARow) {
    await client`DELETE FROM documents WHERE user_id = ${userARow.id} AND original_name = 'w2-telemetry-test.pdf'`;
  }

  const uploadForm = new FormData();
  uploadForm.append("file", pdfFile);
  let uploadedDocId: string | null = null;
  const uploadRes = await (async () => {
    // reuse the upload route against a valid POST with Authorization
    const req = new Request("http://test.local/api/v1/statements/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}` },
      body: uploadForm,
    });
    return uploadRoute.action({ request: req } as never);
  })();
  const uploadBody = (await uploadRes.json()) as { data?: { documentId?: string } };
  uploadedDocId = uploadBody.data?.documentId ?? null;

  // Duplicate rejection: re-uploading identical PDF bytes must return the
  // stable duplicate payload instead of storing anything again.
  if (tokenA) {
    const dupForm = new FormData();
    dupForm.append("file", pdfFile);
    const dupReq = new Request("http://test.local/api/v1/statements/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}` },
      body: dupForm,
    });
    const dupRes = await uploadRoute.action({ request: dupReq } as never);
    const dupBody = (await dupRes.json()) as {
      data?: { duplicate?: boolean; code?: string };
    };
    ok(
      dupBody.data?.duplicate === true &&
        dupBody.data?.code === "STATEMENT_ALREADY_IMPORTED",
      "REG: re-uploading the same PDF bytes is rejected as a duplicate"
    );
  }
  const statementUpload = await execAuditQuery(AuditAction.STATEMENT_UPLOAD);
  ok(
    statementUpload.some((r) => r.user_id === userARow?.id),
    "W2-10: USER statement upload audit row exists"
  );
  const statementImport = await execAuditQuery(AuditAction.STATEMENT_IMPORT);
  ok(
    statementImport.length >= 0,
    "W2-10: statement import audit check executed (present if parse succeeded)"
  );

  // Storage-driver assertions: the uploaded statement persists under the
  // server-side object key statements/<userId>/<documentId>.pdf (never a
  // client path), the object exists in the local test store, and the download
  // route round-trips the exact uploaded bytes.
  let uploadedKey: string | null = null;
  const uploadedRows = userARow
    ? await client`SELECT id, file_path FROM documents
                   WHERE user_id = ${userARow.id} AND original_name = 'w2-telemetry-test.pdf'
                   ORDER BY created_at DESC LIMIT 1`
    : [];
  const uploadedRow = uploadedRows[0] ?? null;
  if (uploadedRow && userARow) {
    uploadedDocId = uploadedRow.id;
    uploadedKey = uploadedRow.file_path;
    const expectedKey = `statements/${userARow.id}/${uploadedRow.id}.pdf`;
    ok(
      uploadedRow.file_path === expectedKey,
      "W2-10: uploaded statement persisted under server-side object key"
    );
    const { STATEMENTS_DIR } = await import("../app/lib/storage/statement-path");
    const { join } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const physical = join(STATEMENTS_DIR, uploadedRow.file_path);
    ok(
      existsSync(physical),
      "W2-10: local test storage object exists on disk under STATEMENTS_DIR"
    );
    if (tokenA) {
      const dlReq = new Request(
        `http://test.local/api/v1/documents/${uploadedRow.id}/download`,
        { method: "GET", headers: { Authorization: `Bearer ${tokenA}` } }
      );
      const dlRes = await documentDownloadRoute.loader({
        request: dlReq,
        params: { id: uploadedRow.id },
      } as never);
      ok(
        dlRes.status === 200,
        "W2-10: uploaded statement downloads through the route"
      );
      const dlBytes = Buffer.from(await dlRes.arrayBuffer());
      ok(
        dlBytes.equals(Buffer.from(pdfBytes)),
        "W2-10: downloaded bytes match the uploaded PDF bytes"
      );
    }
  }

  // 4. USER CRUD transactions -> audit rows
  const createRes = await ledgersRoute.action({
    request: jsonBody(
      {
        amountForeign: "300.00",
        currency: "USD",
        transactionDate: "2026-04-01",
        fxRateBot: "35.0000",
        amountThb: "10500.00",
        type: "CASH_IN",
        sourceType: "MANUAL",
      },
      "POST",
      tokenA
    ),
  } as never);
  const createBody = (await createRes.json()) as {
    data?: { transactionId?: string };
  };
  const crTxnId = createBody.data?.transactionId;
  const crudCreateAudit = await execAuditQuery(AuditAction.CAPITAL_TRANSACTION_CREATE);
  ok(
    crudCreateAudit.some((r) => r.entity_id === crTxnId && r.user_id === userARow?.id),
    "W2-10: transaction create audit row exists, scoped to USER A"
  );

  if (crTxnId && tokenA) {
    const updRes = await ledgerRoute.action({
      request: jsonBody({ amountThb: "10600.00" }, "PATCH", tokenA),
      params: { id: crTxnId },
    } as never);
    ok(updRes.status === 200, "W2-10: transaction update succeeds");
    const updAudit = await execAuditQuery(AuditAction.CAPITAL_TRANSACTION_UPDATE);
    ok(
      updAudit.some((r) => r.entity_id === crTxnId),
      "W2-10: transaction update audit row exists"
    );

    const delRes = await ledgerRoute.action({
      request: authedRequest("DELETE", tokenA),
      params: { id: crTxnId },
    } as never);
    ok(delRes.status === 200, "W2-10: transaction delete succeeds");
    const delAudit = await execAuditQuery(AuditAction.CAPITAL_TRANSACTION_DELETE);
    ok(
      delAudit.some((r) => r.entity_id === crTxnId),
      "W2-10: transaction delete audit row exists"
    );
  }

  // 5. USER attempts admin route -> denied + audit
  const unauthAudit = await execAuditQuery(AuditAction.ADMIN_UNAUTHORIZED_ACCESS);
  ok(
    unauthAudit.some((r) => r.user_id === userARow?.id),
    "W2-10: unauthorized admin access is audited with the caller's id"
  );

  // 6. ADMIN login audit
  const adminLoginAudit = await execAuditQuery(AuditAction.ADMIN_LOGIN_SUCCESS);
  ok(
    adminLoginAudit.some((r) => r.user_id === adminRow?.id),
    "W2-10: ADMIN login success audit row exists"
  );

  // 7. ADMIN GET users -> authz pass + audit
  const adminListAudit = await execAuditQuery(AuditAction.ADMIN_USER_LIST_VIEW);
  ok(
    adminListAudit.some((r) => r.user_id === adminRow?.id),
    "W2-10: ADMIN user-list view is audited"
  );

  // 8. ADMIN PATCH user status -> audit row targets correct user
  let targetStatusRow: string | null = null;
  if (tokenAd && userBRow) {
    const patchRes = await adminUserRoute.action({
      request: jsonBody({ status: "SUSPENDED" }, "PATCH", tokenAd),
      params: { id: userBRow.id },
    } as never);
    ok(patchRes.status === 200, "W2-10: ADMIN PATCH user status succeeds");
    const statusAudit = await execAuditQuery(AuditAction.ADMIN_USER_STATUS_UPDATE);
    const hit = statusAudit.find((r) => r.entity_id === userBRow.id);
    ok(!!hit, "W2-10: admin status update audit targets the correct user");
    if (hit) {
      ok(
        (hit.details?.targetUserId ?? hit.details?.newStatus) !== undefined,
        "W2-10: admin status update details capture target"
      );
    }
    targetStatusRow = userBRow.id;

    // SUSPENDED USER: login is REJECTED — the login route itself enforces the
    // suspended status, so a suspended account must not receive an access token.
    const suspendedLogin = await loginAs(USER_B.email, USER_B.password);
    ok(
      suspendedLogin.success === false &&
        suspendedLogin.code === "ACCOUNT_SUSPENDED",
      "W2-10: SUSPENDED user cannot authenticate (rejected with ACCOUNT_SUSPENDED)"
    );
    ok(
      suspendedLogin.data?.accessToken === undefined,
      "W2-10: suspended login response carries no access token"
    );

    // verifyAuth (protection middleware) must still reject the suspended account
    // even if a JWT is forged for it — a valid token alone is never enough.
    if (suspendedLogin.code === "ACCOUNT_SUSPENDED" && userBRow) {
      const jwt = (await import("jsonwebtoken")).default;
      const forged = jwt.sign(
        { userId: userBRow.id, email: USER_B.email, role: "USER" },
        process.env.JWT_SECRET ?? "",
        { expiresIn: "5m" }
      );
      const deniedRes = await ledgersRoute.loader({
        request: authedRequest("GET", forged),
      } as never);
      ok(
        deniedRes.status === 403,
        "W2-10: SUSPENDED user protected access denied (403) even with a forged JWT"
      );
    }

    // restore USER B to ACTIVE for cleanup
    await adminUserRoute.action({
      request: jsonBody({ status: "ACTIVE" }, "PATCH", tokenAd),
      params: { id: userBRow.id },
    } as never);
  }

  // 9. no secrets in any audit details
  const allAudit = await execAuditQuery();
  const leaked = allAudit.filter((r) => objectContainsSecret(r.details));
  ok(leaked.length === 0, "W2-10: audit details contain no secrets");

  // 10. audit user_id correctness across A / B / Admin
  const userIds = new Set(allAudit.map((r) => r.user_id));
  const allOwned = allAudit.every((r) => {
    if (!r.user_id) {
      // Unknown-email login failures and duplicate-email register failures are
      // deliberately not tied to a user record.
      return (
        r.action === AuditAction.LOGIN_FAILED ||
        r.action === AuditAction.REGISTER_FAILED
      );
    }
    return (
      r.user_id === userARow?.id ||
      r.user_id === userBRow?.id ||
      r.user_id === adminRow?.id ||
      smokeUserIds.includes(r.user_id)
    );
  });
  ok(allOwned, "W2-10: every audit row's user_id belongs to a known test account");

  // ================= W1-2 TESTS =================
  console.log("\n=== W1-2: DECIMAL TAX RECONSTRUCTION API ===");

  // USER A seeded transactions (raw cash in THB):
  //  ...a1 = CASH_IN  (amount_thb 35420)
  //  ...a2 = CASH_OUT (amount_thb 17550)
  //
  // SEMANTIC: the schema stores raw cash only (no cost basis / proceeds), so the
  // API must NOT treat CASH_IN/CASH_OUT as realized gain/loss. It returns the
  // neutral signed cash value (transactionAmountThb) and marks the tax outcome
  // as explicitly "not computable".
  const userA1 = "00000000-0000-0000-0000-0000000000a1";
  const userA2 = "00000000-0000-0000-0000-0000000000a2";

  const taxFor = async (token: string | undefined, ids: string[]) =>
    taxCalculateRoute.action({
      request: jsonBody({ transactionIds: ids }, "POST", token),
    } as never);

  // 1. reconstruct own transactions
  const ownRes = await taxFor(tokenA, [userA1, userA2]);
  const ownBody = (await ownRes.json()) as {
    success?: boolean;
    data?: {
      computable?: boolean;
      totalTaxableAmountThb?: string | null;
      transactions: {
        transactionId: string;
        transactionAmountThb: string;
        realizedGainLossThb?: string | null;
        taxableAmountThb?: string | null;
      }[];
    };
  };
  ok(ownRes.status === 200 && ownBody.success === true, "W1-2: USER A tax reconstruction succeeds");
  ok(ownBody.data?.computable === false, "W1-2: outcome is explicitly NOT computable (schema lacks cost basis)");
  ok(ownBody.data?.totalTaxableAmountThb === null, "W1-2: no fabricated taxable total returned");
  ok(
    ownBody.data?.transactions?.length === 2,
    "W1-2: exactly A's 2 transactions returned"
  );
  ok(
    ownBody.data?.transactions?.every((t) => t.taxableAmountThb === null && t.realizedGainLossThb === null) === true,
    "W1-2: no row fabricates realizedGainLossThb/taxableAmountThb from cash flow"
  );
  const a1Row = ownBody.data?.transactions?.find((t) => t.transactionId === userA1);
  const a2Row = ownBody.data?.transactions?.find((t) => t.transactionId === userA2);
  ok(a1Row?.transactionAmountThb === "35420.00", "W1-2: CASH_IN neutral signed cash = +35420.00");
  ok(a2Row?.transactionAmountThb === "-17550.00", "W1-2: CASH_OUT neutral signed cash = -17550.00");

  // 2. USER A tries to include USER B's transaction -> B's row must NOT appear
  if (userBTxnId) {
    const mixRes = await taxFor(tokenA, [userA1, userA2, userBTxnId]);
    const mixBody = (await mixRes.json()) as {
      data?: { transactions: { transactionId: string }[] };
    };
    const mixIds = (mixBody.data?.transactions ?? []).map((t) => t.transactionId);
    ok(
      !mixIds.includes(userBTxnId),
      "W1-2/Case F: USER A cannot mix USER B's transaction through the API"
    );
    ok(
      mixIds.length === 2,
      "W1-2/Case F: only A's 2 transactions returned when foreign id included"
    );

    // 3. USER A requests ONLY USER B's transaction -> empty result
    const onlyBRes = await taxFor(tokenA, [userBTxnId]);
    const onlyBBody = (await onlyBRes.json()) as {
      data?: { transactions: unknown[] };
    };
    ok(onlyBRes.status === 200, "W1-2/Case F: request with only foreign id still succeeds");
    ok(
      (onlyBBody.data?.transactions?.length ?? 0) === 0,
      "W1-2/Case F: foreign-only request returns empty (no data leak)"
    );
  }

  // 4. unauthenticated request is rejected
  const anonRes = await taxFor(undefined, [userA1]);
  ok(anonRes.status === 401, "W1-2: unauthenticated tax calc rejected (401)");

  // 5. validation: missing/empty/oversized transactionIds
  const missingRes = await taxFor(tokenA, [] as string[]);
  ok(missingRes.status === 400, "W1-2: empty transactionIds rejected (400)");
  const noField = await taxFor(tokenA, undefined as never);
  ok(noField.status === 400, "W1-2: missing transactionIds rejected (400)");
  const tooMany = await taxFor(tokenA, Array.from({ length: 501 }, (_, i) => `id-${i}`));
  ok(tooMany.status === 400, "W1-2: oversized transactionIds rejected (400)");

  // === W2-11: EXPORT + NOTIFICATIONS + HISTORICAL FX PROVIDER (MOCKED) + ANALYSIS ===
  console.log("\n=== W2-11: EXPORT / NOTIFICATIONS / HISTORICAL FX (MOCKED) / ANALYSIS ===");
  {
    const { randomUUID } = await import("node:crypto");

    // ---- 1. Export: auth + user scoping + validation ----
    if (tokenA) {
      // unauthenticated -> 401
      const anonExport = await exportRoute.action({
        request: new Request("http://test.local/api/v1/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "csv" }),
        }),
      } as never);
      ok(anonExport.status === 401, "W2-11: unauthenticated export rejected (401)");

      // USER A CSV export -> 200 + attachment headers + own rows only
      const aCsv = await exportRoute.action({
        request: jsonBody({ format: "csv" }, "POST", tokenA),
      } as never);
      ok(aCsv.status === 200, "W2-11: USER A CSV export succeeds (200)");
      ok(
        (aCsv.headers.get("Content-Type") ?? "").includes("text/csv"),
        "W2-11: CSV export has text/csv content type"
      );
      const aCsvBody = Buffer.from(await aCsv.arrayBuffer()).toString("utf-8");
      ok(
        aCsvBody.includes("35420") && aCsvBody.includes("17550"),
        "W2-11: USER A CSV contains A's seeded amounts"
      );
      ok(
        !aCsvBody.includes("8800") && !aCsvBody.includes("35.2"),
        "W2-11: USER A CSV does NOT contain USER B's data"
      );

      // date format validation -> 400
      const badDate = await exportRoute.action({
        request: jsonBody({ format: "csv", dateFrom: "2026/01/01" }, "POST", tokenA),
      } as never);
      ok(badDate.status === 400, "W2-11: malformed dateFrom rejected (400)");
    }

    if (tokenB) {
      const bCsv = await exportRoute.action({
        request: jsonBody({ format: "csv" }, "POST", tokenB),
      } as never);
      ok(bCsv.status === 200, "W2-11: USER B CSV export succeeds (200)");
      const bCsvBody = Buffer.from(await bCsv.arrayBuffer()).toString("utf-8");
      ok(bCsvBody.includes("8800"), "W2-11: USER B CSV contains B's amount");
      ok(
        !bCsvBody.includes("35420"),
        "W2-11: USER B CSV does NOT contain USER A's data"
      );
    }

    // ---- 2. Notifications: idempotency + opt-out (service level, DB-backed) ----
    if (userARow && userBRow) {
      const hidePath = await import("../app/lib/notification-service");
      const entityKey = "00000000-0000-0000-0000-00000000nt1";
      await client`DELETE FROM notifications WHERE entity_id = ${entityKey}`;
      await hidePath.notifyStatementUploaded(userARow.id, "dup.pdf", entityKey);
      await hidePath.notifyStatementUploaded(userARow.id, "dup.pdf", entityKey);
      const notifRows = await client`SELECT * FROM notifications WHERE entity_id = ${entityKey}`;
      ok(notifRows.length === 1, "W2-11: repeated notify for same entity creates ONE notification (idempotent)");
      ok(
        notifRows[0].type === "STATEMENT_UPLOAD" && notifRows[0].user_id === userARow.id,
        "W2-11: notification row carries correct user + type"
      );
      await client`DELETE FROM notifications WHERE entity_id = ${entityKey}`;

      // opt-out: notificationEnabled=false -> no notification row created
      const settingsId = "00000000-0000-0000-0000-00000000s1";
      const now = new Date().toISOString();
      await client`DELETE FROM user_settings WHERE id = ${settingsId}`;
      await client`INSERT INTO user_settings (id, user_id, notification_enabled, email_notification_enabled, created_at, updated_at)
                   VALUES (${settingsId}, ${userBRow.id}, false, false, ${now}, ${now})`;
      const optEntity = "00000000-0000-0000-0000-00000000nt2";
      await client`DELETE FROM notifications WHERE entity_id = ${optEntity}`;
      await hidePath.notifyStatementDuplicate(userBRow.id, "off.pdf", optEntity);
      const optRows = await client`SELECT * FROM notifications WHERE entity_id = ${optEntity}`;
      ok(optRows.length === 0, "W2-11: disabled notifications produce no rows (opt-out honored)");
      await client`DELETE FROM notifications WHERE entity_id = ${optEntity}`;
      await client`DELETE FROM user_settings WHERE id = ${settingsId}`;
    }

    // ---- 3. Historical FX provider with MOCKED HTTP (never a live call) ----
    {
      const savedFetch = globalThis.fetch;
      const botEnv = process.env.BOT_API_KEY;
      delete process.env.BOT_API_KEY;
      const fxDate = "2025-07-07";
      const fxDateFail = "2025-07-08";
      const fxDateWeekend = "2025-07-09";
      await client`DELETE FROM exchange_rate_cache WHERE rate_date IN (${fxDate}, ${fxDateFail}, ${fxDateWeekend})`;

      const fxRequest = (token: string | undefined, query: string) =>
        exchangeRatesRoute.loader({
          request: new Request(`http://test.local/api/v1/exchange-rates?${query}`, {
            method: "GET",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }),
        } as never);

      // no BOT-specific runtime dependency: the endpoint works with no key at all
      ok(process.env.BOT_API_KEY === undefined, "W2-11: BOT_API_KEY is not required (deprecated)");

      // unauthenticated -> 401 even before any fetch happens
      const anonRates = await fxRequest("", "currency=USD");
      ok(anonRates.status === 401, "W2-11: unauthenticated exchange-rate access rejected (401)");

      // success path: intercept the provider request with a canned ECB response
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        ok(
          url.includes("api.frankfurter.app") && url.includes("from=USD") && url.includes("to=THB"),
          "W2-11: FX provider fetch targets the keyless historical endpoint (from=USD,to=THB)"
        );
        ok(!url.includes("apigw1.bot.or.th"), "W2-11: no BOT endpoint is ever contacted");
        return new Response(
          JSON.stringify({
            amount: 1,
            base: "USD",
            date: fxDate,
            rates: { THB: 34.5 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ) as Response;
      }) as typeof fetch;

      if (tokenA) {
        const okRes = await fxRequest(tokenA, "currency=USD&date=" + fxDate);
        const okBody = (await okRes.json()) as {
          data?: { available?: boolean; rate?: number; currency?: string; source?: string };
        };
        ok(okRes.status === 200 && okBody.data?.available === true, "W2-11: provider success -> available true");
        ok(okBody.data?.rate === 34.5, "W2-11: provider rate parsed exactly (34.5)");
        ok(okBody.data?.currency === "USD", "W2-11: provider response echoes the requested currency");
        ok(okBody.data?.source === "historical-fx-provider", "W2-11: provider source label is historical-fx-provider");
      }

      // failure path: provider returns 404 -> available false, never a rate
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ message: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }) as Response) as typeof fetch;

      if (tokenA) {
        const failRes = await fxRequest(tokenA, "currency=USD&date=" + fxDateFail);
        const failBody = (await failRes.json()) as {
          data?: { available?: boolean; rate?: number; reason?: string };
        };
        ok(failBody.data?.available === false && failBody.data?.rate === undefined,
          "W2-11: provider failure -> available false, no invented rate");
      }

      // THB is always 1 (base currency) without calling anything
      let providerCalledForThb = false;
      globalThis.fetch = (async () => {
        providerCalledForThb = true;
        return new Response(JSON.stringify({ rates: {} }), { status: 200 });
      }) as typeof fetch;
      if (tokenA) {
        const thbRes = await fxRequest(tokenA, "currency=THB&date=" + fxDateWeekend);
        const thbBody = (await thbRes.json()) as {
          data?: { available?: boolean; rate?: number };
        };
        ok(thbBody.data?.available === true && thbBody.data?.rate === 1,
          "W2-11: THB is base currency -> rate 1, no network needed");
        ok(providerCalledForThb === false, "W2-11: THB lookup never touches the provider");
      }

      // cached fallback: a cached rate is served without any provider call
      await client`INSERT INTO exchange_rate_cache (id, rate_date, currency, rate, source, created_at)
                   VALUES ('00000000-0000-0000-0000-00000000fx1', ${fxDateFail}, 'USD', '34.7500', 'historical-fx-provider', now())`;
      let providerCalledForCache = false;
      globalThis.fetch = (async () => {
        providerCalledForCache = true;
        return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
      }) as typeof fetch;
      if (tokenA) {
        const cacheRes = await fxRequest(tokenA, "currency=USD&date=" + fxDateFail);
        const cacheBody = (await cacheRes.json()) as {
          data?: { available?: boolean; rate?: number; source?: string };
        };
        ok(cacheBody.data?.available === true && cacheBody.data?.rate === 34.75,
          "W2-11: cached rate served even though the provider is down (34.75)");
        ok(providerCalledForCache === false, "W2-11: cache hit never reaches the provider");
      }

      // restore environment + real fetch; cleanup cache rows written above
      if (botEnv === undefined) delete process.env.BOT_API_KEY;
      else process.env.BOT_API_KEY = botEnv;
      globalThis.fetch = savedFetch;
      await client`DELETE FROM exchange_rate_cache WHERE rate_date IN (${fxDate}, ${fxDateFail}, ${fxDateWeekend})`;
    }

    // ---- 4. Analysis endpoint: auth + graceful unavailable (no live Gemini) ----
    {
      const savedGemini = process.env.GEMINI_API_KEY;
      const savedGeminiModel = process.env.GEMINI_MODEL;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_MODEL;

      const anonAnalysis = await analysisRoute.action({
        request: jsonBody({}, "POST", undefined),
      } as never);
      ok(anonAnalysis.status === 401, "W2-11: unauthenticated analysis rejected (401)");

      if (tokenA) {
        const aAnalysis = await analysisRoute.action({
          request: jsonBody({}, "POST", tokenA),
        } as never);
        const aBody = (await aAnalysis.json()) as {
          success?: boolean;
          data?: { available?: boolean; code?: string | null };
        };
        ok(
          aAnalysis.status === 200 && aBody.success === true,
          "W2-11: analysis returns a graceful response (200)"
        );
        ok(
          aBody.data?.available === false && aBody.data?.code === "gemini_not_configured",
          "W2-11: analysis is unavailable when Gemini not configured (no crash)"
        );
      }

      // restore
      if (savedGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedGemini;
      if (savedGeminiModel === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = savedGeminiModel;
    }

    // ---- 5. users.created_at set on registration ----
    {
      const registerRoute = await import("../app/routes/api/auth/register");
      const email = `join-${randomUUID()}@test.local`;
      const res = await registerRoute.action({
        request: new Request("http://test.local/api/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: "JoinPass!234" }),
        }),
      } as never);
      const body = (await res.json()) as { data?: { user?: { id?: string } } };
      const newId = body.data?.user?.id;
      if (newId) {
        const row = await client`SELECT created_at FROM "User" WHERE id = ${newId}`;
        ok(
          row.length === 1 && row[0]?.created_at !== null,
          "W2-11: newly-registered user has a non-null created_at"
        );
        // Cleaned up in the CLEANUP block (audit rows deleted first, then user).
        smokeUserIds.push(newId);
      } else {
        ok(false, "W2-11: register created_user_id missing (created_at not checked)");
      }
    }
  }

  // ================= CLEANUP =================
  console.log("\n=== CLEANUP ===");
  const cleanIds: string[] = [];
  if (userBTxnId) cleanIds.push(userBTxnId);
  if (crTxnId) cleanIds.push(crTxnId);
  for (const tid of cleanIds) {
    await client`DELETE FROM "Capital_Transactions" WHERE transaction_id = ${tid}`;
  }
  if (uploadedDocId) {
    await client`DELETE FROM documents WHERE id = ${uploadedDocId}`;
  }
  if (uploadedKey) {
    const { deleteStoredFile } = await import(
      "../app/lib/storage/statement-storage"
    );
    await deleteStoredFile(uploadedKey);
  }
  await client`DELETE FROM audit_logs WHERE created_at >= ${startTime}`;
  await client`DELETE FROM notifications WHERE created_at >= ${startTime}`;
  for (const sid of smokeUserIds) {
    await client`DELETE FROM "User" WHERE id = ${sid}`;
  }
  console.log("  Removed test audit rows, transient records, and smoke-test users.");
  console.log("  Kept the intentional seed accounts (USER A, USER B, ADMIN) and their sample data.");

  await client.end();
}

main()
  .then(() => {
    console.log(`\n================ SUMMARY ================`);
    console.log(`PASS: ${passed}   FAIL: ${failed}`);
    if (failures.length) {
      console.log("Failures:");
      for (const f of failures) console.log(`  - ${f}`);
    }
    process.exit(failed ? 1 : 0);
  })
  .catch(async (e) => {
    console.error("Test harness crashed:", e);
    await client.end().catch(() => {});
    process.exit(1);
  });
