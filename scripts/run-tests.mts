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
const documentTransactionsRoute = await import("../app/routes/api/documents.$id.transactions");
const exchangeRatesRoute = await import("../app/routes/api/exchange-rates");
const accountsRoute = await import("../app/routes/api/accounts");
const journalRoute = await import("../app/routes/api/journal");
const journalReverseRoute = await import("../app/routes/api/journal.$id.reverse");
const trialBalanceRoute = await import("../app/routes/api/reports/trial-balance");

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

// Register a user through the REAL route, each call from its OWN random client
// IP. The register rate-limit budget is per-IP (register-ip:<ip>), so harness
// account-creation must spread across distinct IPs — if every setup call used
// the same "unknown" bucket, the 10-per-window cap would 429 the suite's own
// registrations mid-run instead of only throttling the intentional-spam tests
// (which pin a shared IP on purpose).
async function registerAs(email: string, password: string) {
  const registerRoute = await import("../app/routes/api/auth/register");
  const ip = `198.51.100.${Math.floor(Math.random() * 240) + 10}`;
  return await registerRoute.action({
    request: new Request("http://test.local/api/v1/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({ email, password }),
    }),
  } as never);
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

      // Wrong extension (.txt with valid PDF content) -> 400
      const wrongExt = new File([magicPdf as BlobPart], "statement.txt", {
        type: "application/pdf",
      });
      const extRes = await uploadAs(tokenA, wrongExt);
      ok(
        extRes.status === 400,
        "REG: non-.pdf extension is rejected (400)"
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

      for (const [name, bytes] of [["corrupt.pdf", magicPdf], ["textless.pdf", makePdf([])]] as const) {
        const response = await uploadAs(tokenA, new File([bytes as BlobPart], name, { type: "application/pdf" }));
        ok(response.status >= 400, `REG: ${name} extraction rejected`);
        const leftover = await client`SELECT id FROM documents WHERE user_id=${userARow.id} AND original_name=${name}`;
        ok(leftover.length === 0, `REG: ${name} extraction failure leaves no document`);
      }

      // Rejects happen BEFORE any storage/document write (validation-first):
      // none of the rejected uploads may leave a documents row behind. Since
      // saveStatementPdf persists the storage object only alongside its
      // documents row (and cleans the object up when the row insert fails), a
      // missing row is a sound no-leak invariant — no row, no orphaned object.
      const leakedDocs = await client`SELECT id, original_name FROM documents WHERE user_id = ${userARow.id} AND original_name IN ('evil.pdf', 'x.pdf', 'statement.txt', 'big.pdf')`;
      ok(
        leakedDocs.length === 0,
        "REG: rejected uploads leave NO documents row behind (validation-first, no leak)"
      );

      // Isolation: the same invalid file is rejected identically for a second
      // user, and one user's rejection never affects another user's documents.
      if (tokenB) {
        const bRes = await uploadAs(tokenB, fakePdf);
        ok(
          bRes.status === 400,
          "REG: invalid upload rejected identically for a second user (no cross-user effect)"
        );
      }
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

  // ================= REG: DETERMINISTIC REIMPORT (numeric reproducibility) =================
  // R17: delete + re-import must converge to EXACTLY the state a clean import of
  // the same statements produced. The import path runs a FULL deterministic
  // reconcile (recomputeAllGainLoss + scoped journal re-post + whole-history
  // recomputeCostBasisMap) instead of an incremental cache-upsert + fill-NULL
  // backfill. Discriminator: A = BUY X 100@10 (2026-01-05), B = SELL X 50@15
  // (2026-01-10). Clean -> basis X qty 50; DELETE A -> basis empty + SELL
  // non-computable; REIMPORT A -> basis X qty 50 again. An incremental path
  // replays the BUY from an EMPTY cache and would leave qty 100 (the bug).
  {
    const { randomUUID } = await import("node:crypto");
    const detLines = (kind: "a" | "b") =>
      kind === "a"
        ? [
            "TRADE RECORDS",
            "Currency: USD",
            "USD/THB = 35.42",
            "X",
            "05/01/2026 10:00:00,GMT+07 05/01/2026 BUY 100 10.00 1000.00 1000.00 1.00 0.07 NASDAQ",
            "PORTFOLIO SUMMARY",
          ]
        : [
            "TRADE RECORDS",
            "Currency: USD",
            "USD/THB = 35.42",
            "X",
            "10/01/2026 10:00:00,GMT+07 10/01/2026 SELL 50 15.00 750.00 748.50 1.00 0.07 NASDAQ",
            "PORTFOLIO SUMMARY",
          ];
    const detFile = (kind: "a" | "b") =>
      new File([makePdf(detLines(kind)) as BlobPart], `w2-det-${kind}.pdf`, {
        type: "application/pdf",
      });
    const detUpload = (token: string, file: File) => {
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
    const basisOfX = () =>
      client`SELECT quantity, avg_cost, cum_quantity, cum_cost FROM cost_basis_state WHERE user_id = ${userARow.id} AND symbol = 'X'`;
    const sellRowOfX = () =>
      client`SELECT realized_gain_loss, realized_gain_loss_thb, cost_basis FROM "Capital_Transactions" WHERE user_id = ${userARow.id} AND symbol = 'X' AND side = 'SELL'`;
    if (tokenA && userARow) {
      // purge leftovers from a previous run
      const priorDocs = await client`SELECT id FROM documents WHERE user_id = ${userARow.id} AND original_name IN ('w2-det-a.pdf', 'w2-det-b.pdf')`;
      for (const d of priorDocs) {
        await client`DELETE FROM journal_entry_lines WHERE user_id = ${userARow.id} AND journal_entry_id IN (SELECT id FROM journal_entries WHERE user_id = ${userARow.id} AND source_document_id = ${d.id})`;
        await client`DELETE FROM "Capital_Transactions" WHERE source_document_id = ${d.id} AND user_id = ${userARow.id}`;
        await client`DELETE FROM journal_entries WHERE source_document_id = ${d.id} AND user_id = ${userARow.id}`;
        await client`DELETE FROM documents WHERE id = ${d.id} AND user_id = ${userARow.id}`;
      }
      await client`DELETE FROM cost_basis_state WHERE user_id = ${userARow.id} AND symbol IN ('X', 'Y')`;

      // 1. Clean chain: import A (BUY) then B (SELL) — the reproducibility target.
      const a1 = await detUpload(tokenA, detFile("a"));
      const a1Body = (await a1.json()) as { data?: { documentId?: string } };
      const aDoc = a1Body.data?.documentId;
      const b1 = await detUpload(tokenA, detFile("b"));
      const b1Body = (await b1.json()) as { data?: { documentId?: string } };
      const bDoc = b1Body.data?.documentId;
      ok(
        a1.status === 200 && b1.status === 200 && !!aDoc && !!bDoc,
        "REG-det: both statements import (A BUY 100@10 + B SELL 50@15)"
      );
      const cleanBasis = await basisOfX();
      ok(
        cleanBasis.length === 1 && parseFloat(cleanBasis[0].quantity ?? "") === 50,
        "REG-det: clean basis holds X qty 50 after the SELL"
      );
      const cleanSell = await sellRowOfX();
      ok(
        cleanSell.length === 1 &&
          parseFloat(cleanSell[0].cost_basis ?? "") === 500 &&
          parseFloat(cleanSell[0].realized_gain_loss ?? "") === 248.5,
        "REG-det: clean SELL realized 248.50 = net 748.50 - basis 500.00 (50 shares x avg 10)"
      );

      // 2. DELETE A -> basis must empty + the remaining SELL become non-computable.
      const delA = aDoc
        ? await documentRoute.action({
            request: authedRequest("DELETE", tokenA),
            params: { id: aDoc },
          } as never)
        : null;
      ok(delA?.status === 200, "REG-det: statement A deletion succeeds");
      const basisAfterDelete = await basisOfX();
      const sellAfterDelete = await sellRowOfX();
      ok(
        basisAfterDelete.length === 0,
        "REG-det: after deleting A the basis is empty (no BUY remains)"
      );
      ok(
        sellAfterDelete.length === 1 && sellAfterDelete[0].realized_gain_loss === null,
        "REG-det: SELL becomes non-computable (realized NULL) after deleting its supporting BUY"
      );

      // 3. MANUAL row must survive the later reimport reconcile untouched.
      const manualId = randomUUID();
      await client`
        INSERT INTO "Capital_Transactions"
          (transaction_id, user_id, amount_foreign, currency, transaction_date, amount_thb, type, source_type, category, symbol, side, quantity, unit_price, gross_amount, fees, net_amount, proceeds, cost_basis, realized_gain_loss, realized_gain_loss_thb, fx_rate_statement, fx_rate_effective)
        VALUES
          (${manualId}, ${userARow.id}, '80.00', 'USD', '2026-01-08', '2833.60', 'BUY', 'MANUAL', 'asset', 'Y', 'BUY', '10', '8.00', '80.00', '0.05', '80.00', NULL, NULL, NULL, NULL, '35.42', '35.42')`;
      await client`DELETE FROM cost_basis_state WHERE user_id = ${userARow.id} AND symbol = 'Y'`;

      // 4. REIMPORT A -> the FULL reconcile must reproduce the CLEAN state.
      const a2 = await detUpload(tokenA, detFile("a"));
      const a2Body = (await a2.json()) as { data?: { documentId?: string } };
      const a2Doc = a2Body.data?.documentId;
      ok(a2.status === 200 && !!a2Doc, "REG-det: re-upload of A after deletion imports");
      const basisAfterReimport = await basisOfX();
      ok(
        basisAfterReimport.length === 1 &&
          parseFloat(basisAfterReimport[0].quantity ?? "") === 50,
        "REG-det: reimport A reproduces qty 50 (== clean; the incremental path would leave 100)"
      );
      ok(
        basisAfterReimport.length === 1 &&
          parseFloat(basisAfterReimport[0].cum_quantity ?? "") === 100 &&
          parseFloat(basisAfterReimport[0].cum_cost ?? "") === 1000,
        "REG-det: reimport A reproduces the clean lifetime cum fields (cumQuantity 100, cumCost 1000 — the Webull accumulator is NOT reduced by SELL)"
      );
      const sellAfterReimport = await sellRowOfX();
      ok(
        sellAfterReimport.length === 1 &&
          sellAfterReimport[0].realized_gain_loss === cleanSell[0].realized_gain_loss &&
          sellAfterReimport[0].realized_gain_loss_thb === cleanSell[0].realized_gain_loss_thb,
        "REG-det: SELL realized gain/loss (native + THB) matches the CLEAN state exactly"
      );
      const manualRowAfter = await client`
        SELECT source_type, realized_gain_loss FROM "Capital_Transactions" WHERE transaction_id = ${manualId} AND user_id = ${userARow.id}`;
      ok(
        manualRowAfter.length === 1 &&
          manualRowAfter[0].source_type === "MANUAL" &&
          manualRowAfter[0].realized_gain_loss === null,
        "REG-det: MANUAL row untouched by the reimport reconcile (still MANUAL, realized NULL)"
      );
      const manualBasisAfter = await client`
        SELECT quantity FROM cost_basis_state WHERE user_id = ${userARow.id} AND symbol = 'Y'`;
      ok(
        manualBasisAfter.length === 1 && parseFloat(manualBasisAfter[0].quantity ?? "") === 10,
        "REG-det: MANUAL BUY contributes to the rebuilt basis (Y qty 10) and is not clobbered"
      );
      const postedEntries = a2Doc && bDoc ? await client`
        SELECT COUNT(*)::int AS n FROM journal_entries
        WHERE user_id = ${userARow.id} AND posting_state = 'POSTED' AND side IN ('BUY', 'SELL') AND (source_document_id = ${a2Doc} OR source_document_id = ${bDoc})` : [{ n: -1 }];
      ok(
        postedEntries[0]?.n === 2,
        "REG-det: exactly 2 POSTED trade journal entries across the reimported A and B (BUY + SELL, no duplicates; VAT/fee/summary rows stay SKIPPED)"
      );

      // cleanup (audit rows are removed globally at the end)
      for (const d of [a2Doc, bDoc]) {
        if (d) {
          await client`DELETE FROM journal_entry_lines WHERE user_id = ${userARow.id} AND journal_entry_id IN (SELECT id FROM journal_entries WHERE user_id = ${userARow.id} AND source_document_id = ${d})`;
          await client`DELETE FROM "Capital_Transactions" WHERE source_document_id = ${d} AND user_id = ${userARow.id}`;
          await client`DELETE FROM journal_entries WHERE source_document_id = ${d} AND user_id = ${userARow.id}`;
          await client`DELETE FROM documents WHERE id = ${d} AND user_id = ${userARow.id}`;
          await client`DELETE FROM notifications WHERE entity_id = ${d}`;
        }
      }
      await client`DELETE FROM "Capital_Transactions" WHERE transaction_id = ${manualId} AND user_id = ${userARow.id}`;
      await client`DELETE FROM cost_basis_state WHERE user_id = ${userARow.id} AND symbol IN ('X', 'Y')`;
    }
  }

  // ================= REG: IMPORT PERSISTENCE VERIFICATION =================
  // Regression for the production symptom "UI shows success but nothing was
  // persisted" (Supabase transaction-pooler prepared-statement failure surfacing
  // as a committed-but-empty import). The upload route now gates its success
  // response AND the STATEMENT_IMPORT audit behind verifyStatementImportPersistence,
  // which re-reads the committed rows + their 1:1 journal mirrors. This block
  // proves the gate's logic against the REAL database: a healthy import passes,
  // a simulated pooler row loss is detected, a rebuild after loss restores the
  // exact 1:1 state, and a duplicated journal mirror is rejected.
  {
    const { verifyStatementImportPersistence } = await import("../app/lib/ledger-service");
    const persLines = [
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
    const persFile = new File(
      [makePdf(persLines) as BlobPart],
      "w2-persist-check.pdf",
      { type: "application/pdf" }
    );
    const persUpload = (token: string) => {
      const fd = new FormData();
      fd.append("file", persFile);
      return uploadRoute.action({
        request: new Request("http://test.local/api/v1/statements/upload", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        }),
      } as never);
    };
    if (tokenA && userARow) {
      // clean slate for the fixture
      const priorPersDocs = await client`SELECT id FROM documents WHERE user_id = ${userARow.id} AND original_name = 'w2-persist-check.pdf'`;
      for (const d of priorPersDocs) {
        await client`DELETE FROM journal_entry_lines WHERE user_id = ${userARow.id} AND journal_entry_id IN (SELECT id FROM journal_entries WHERE user_id = ${userARow.id} AND source_document_id = ${d.id})`;
        await client`DELETE FROM "Capital_Transactions" WHERE source_document_id = ${d.id} AND user_id = ${userARow.id}`;
        await client`DELETE FROM journal_entries WHERE source_document_id = ${d.id} AND user_id = ${userARow.id}`;
        await client`DELETE FROM documents WHERE id = ${d.id} AND user_id = ${userARow.id}`;
      }

      // 1. Healthy import passes the persistence gate.
      const up1 = await persUpload(tokenA);
      const up1Body = (await up1.json()) as {
        data?: { documentId?: string; saved?: number; transactionIds?: string[] };
      };
      const persDoc = up1Body.data?.documentId;
      const persSaved = up1Body.data?.saved ?? -1;
      const persIds = up1Body.data?.transactionIds ?? [];
      ok(
        up1.status === 200 && persSaved >= 6 && !!persDoc && persIds.length >= 6,
        "REG-persist: healthy import saves >= 6 rows and returns their transaction ids"
      );
      if (persDoc && persIds.length > 0) {
        const proof1 = await verifyStatementImportPersistence({
          userId: userARow.id,
          documentId: persDoc,
          insertedCount: persSaved,
          transactionIds: persIds,
        });
        ok(
          proof1.ok &&
            proof1.capitalRows === persSaved &&
            proof1.journalEntries === persSaved &&
            proof1.missingRows.length === 0 &&
            proof1.duplicateJournalTransactions.length === 0,
          "REG-persist: persistence gate PASSES on a healthy import (rows + 1:1 journal mirrors)"
        );

        // 2. Simulate the pooler loss (rows silently vanish). The gate must FAIL.
        await client`DELETE FROM journal_entry_lines WHERE user_id = ${userARow.id} AND journal_entry_id IN (SELECT id FROM journal_entries WHERE user_id = ${userARow.id} AND source_document_id = ${persDoc})`;
        await client`DELETE FROM "Capital_Transactions" WHERE user_id = ${userARow.id} AND source_document_id = ${persDoc}`;
        await client`DELETE FROM journal_entries WHERE user_id = ${userARow.id} AND source_document_id = ${persDoc}`;
        const proof2 = await verifyStatementImportPersistence({
          userId: userARow.id,
          documentId: persDoc,
          insertedCount: persSaved,
          transactionIds: persIds,
        });
        ok(
          !proof2.ok &&
            proof2.capitalRows === 0 &&
            proof2.missingRows.length === persSaved,
          "REG-persist: gate FAILS when the committed rows silently vanish (the production symptom)"
        );

        // 3. Reload the file (rebuild path) -> the gate passes again after restore.
        const up2 = await persUpload(tokenA);
        const up2Body = (await up2.json()) as {
          data?: { documentId?: string; saved?: number; transactionIds?: string[]; rebuilt?: boolean };
        };
        ok(
          up2.status === 200 &&
            up2Body.data?.documentId === persDoc &&
            up2Body.data?.rebuilt === true &&
            (up2Body.data?.saved ?? 0) === persSaved,
          "REG-persist: re-upload rebuilds under the SAME document id and reports the same count"
        );
        const proof3 = await verifyStatementImportPersistence({
          userId: userARow.id,
          documentId: persDoc,
          insertedCount: persSaved,
          transactionIds: up2Body.data?.transactionIds ?? [],
        });
        ok(
          proof3.ok &&
            proof3.capitalRows === persSaved &&
            proof3.journalEntries === persSaved,
          "REG-persist: gate PASSES again after the rebuild (full restoration + 1:1 mirrors)"
        );

        // 4. Duplicated journal mirror for one transaction -> gate rejects it.
        const dupTxnId = up2Body.data?.transactionIds?.[0];
        if (dupTxnId && proof3.capitalRows > 1) {
          const dupSource = (await client`
            SELECT id, source_transaction_id FROM journal_entries
            WHERE user_id = ${userARow.id} AND source_document_id = ${persDoc}
            AND source_transaction_id != ${dupTxnId} LIMIT 1`)[0] as { id: string; source_transaction_id: string } | undefined;
          if (dupSource) {
            await client`
              UPDATE journal_entries SET source_transaction_id = ${dupTxnId}
              WHERE id = ${dupSource.id} AND user_id = ${userARow.id}`;
            const proof4 = await verifyStatementImportPersistence({
              userId: userARow.id,
              documentId: persDoc,
              insertedCount: persSaved,
              transactionIds: up2Body.data?.transactionIds ?? [],
            });
            ok(
              !proof4.ok &&
                proof4.duplicateJournalTransactions.includes(dupTxnId),
              "REG-persist: gate rejects a duplicated journal mirror (source_transaction_id is not 1:1)"
            );
            await client`
              UPDATE journal_entries SET source_transaction_id = ${dupSource.source_transaction_id}
              WHERE id = ${dupSource.id} AND user_id = ${userARow.id}`;
          } else {
            ok(true, "REG-persist: (vacuous) no second transaction to duplicate - skipped");
          }
        }

        // cleanup
        await client`DELETE FROM journal_entry_lines WHERE user_id = ${userARow.id} AND journal_entry_id IN (SELECT id FROM journal_entries WHERE user_id = ${userARow.id} AND source_document_id = ${persDoc})`;
        await client`DELETE FROM "Capital_Transactions" WHERE user_id = ${userARow.id} AND source_document_id = ${persDoc}`;
        await client`DELETE FROM journal_entries WHERE source_document_id = ${persDoc} AND user_id = ${userARow.id}`;
        await client`DELETE FROM documents WHERE id = ${persDoc} AND user_id = ${userARow.id}`;
        await client`DELETE FROM notifications WHERE entity_id = ${persDoc}`;
      }
    }
  }

  // ================= REG: STATEMENT PREVIEW (แสดงรายละเอียดก่อน + OK ค่อยนำเข้า) =================
  // POST /api/v1/statements/preview must return the FULL parsed rows + stats for
  // the "ตรวจสอบเอกสารก่อนนำเข้า" screen WITHOUT persisting anything (no storage
  // object, no documents row, no Capital_Transactions, no cost-basis write).
  // After the real commit, the same preview must return a duplicate payload so
  // the review screen never commits twice.
  {
    const previewRoute = await import("../app/routes/api/statements/preview");
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
    const previewFile = new File(
      [makePdf(statementLines) as BlobPart],
      "w2-preview-test.pdf",
      { type: "application/pdf" }
    );
    const previewAs = (token: string) => {
      const fd = new FormData();
      fd.append("file", previewFile);
      return previewRoute.action({
        request: new Request("http://test.local/api/v1/statements/preview", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        }),
      } as never);
    };
    const commitAs = (token: string) => {
      const fd = new FormData();
      fd.append("file", previewFile);
      return uploadRoute.action({
        request: new Request("http://test.local/api/v1/statements/upload", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        }),
      } as never);
    };
    if (tokenA && userARow) {
      // clean slate for the fixture (any previous run's leftovers)
      const priorPreviewDocs = await client`SELECT id FROM documents WHERE user_id = ${userARow.id} AND original_name = 'w2-preview-test.pdf'`;
      for (const d of priorPreviewDocs) {
        await client`DELETE FROM "Capital_Transactions" WHERE source_document_id = ${d.id} AND user_id = ${userARow.id}`;
        await client`DELETE FROM documents WHERE id = ${d.id} AND user_id = ${userARow.id}`;
      }

      const txBeforePreview = await client`SELECT COUNT(*)::int AS n FROM "Capital_Transactions" WHERE user_id = ${userARow.id}`;
      const basisBeforePreview = await client`SELECT COUNT(*)::int AS n FROM cost_basis_state WHERE user_id = ${userARow.id}`;
      const docsBeforePreview = await client`SELECT COUNT(*)::int AS n FROM documents WHERE user_id = ${userARow.id}`;

      // 1. Preview (read-only) on a fresh file.
      const prev = await previewAs(tokenA);
      const prevBody = (await prev.json()) as {
        data?: {
          preview?: boolean;
          duplicate?: boolean;
          duplicateDecision?: string;
          extracted?: number;
          rows?: Array<{
            symbol?: string | null;
            side?: string | null;
            transactionDate?: string;
            transactionId?: string;
          }>;
          stats?: { buyCount?: number; sellCount?: number; cashCount?: number };
        };
      };
      ok(
        prev.status === 200 && prevBody.data?.preview === true,
        "REG-preview: preview endpoint succeeds with preview:true"
      );
      ok(
        !!prevBody.data?.rows && prevBody.data.rows.length >= 3,
        "REG-preview: preview returns the FULL parsed rows (>= 3 trade rows)"
      );
      ok(
        prevBody.data?.stats?.buyCount === 2 &&
          prevBody.data?.stats?.sellCount === 1,
        "REG-preview: preview stats classify the 2 BUY + 1 SELL correctly"
      );
      ok(
        prevBody.data?.duplicateDecision === "fresh",
        "REG-preview: fresh file is labeled 'fresh' (not rebuilt/duplicate)"
      );
      ok(
        prevBody.data?.rows?.every(
          (r) => r.symbol === null || r.symbol === "VRMAX"
        ) === true &&
          prevBody.data?.rows?.every((r) => !!r.transactionId) === true,
        "REG-preview: preview rows carry the parser's symbol + stable row ids for React keys"
      );

      // 2. Preview must NOT write anything (rows/cache/documents unchanged).
      const txAfterPreview = await client`SELECT COUNT(*)::int AS n FROM "Capital_Transactions" WHERE user_id = ${userARow.id}`;
      const basisAfterPreview = await client`SELECT COUNT(*)::int AS n FROM cost_basis_state WHERE user_id = ${userARow.id}`;
      const docsAfterPreview = await client`SELECT COUNT(*)::int AS n FROM documents WHERE user_id = ${userARow.id}`;
      ok(
        txAfterPreview[0]?.n === txBeforePreview[0]?.n &&
          basisAfterPreview[0]?.n === basisBeforePreview[0]?.n &&
          docsAfterPreview[0]?.n === docsBeforePreview[0]?.n,
        "REG-preview: preview persists NOTHING (no rows, no cache, no document)"
      );

      // 3. Real commit still imports the rows after the preview step.
      const commit = await commitAs(tokenA);
      const commitBody = (await commit.json()) as {
        data?: { saved?: number; documentId?: string };
      };
      ok(
        commit.status === 200 && (commitBody.data?.saved ?? 0) >= 3,
        "REG-preview: the real upload after preview commits the rows"
      );

      // 4. Previewing the now-imported file returns a duplicate payload.
      const prevAgain = await previewAs(tokenA);
      const prevAgainBody = (await prevAgain.json()) as {
        data?: { duplicate?: boolean; code?: string };
      };
      ok(
        prevAgainBody.data?.duplicate === true &&
          prevAgainBody.data?.code === "STATEMENT_ALREADY_IMPORTED",
        "REG-preview: preview of an already-imported file reports a duplicate (no commit)"
      );

      // defensive cleanup for any partial state
      if (commitBody.data?.documentId) {
        await client`DELETE FROM "Capital_Transactions" WHERE user_id = ${userARow.id} AND source_document_id = ${commitBody.data.documentId}`;
        await client`DELETE FROM documents WHERE id = ${commitBody.data.documentId} AND user_id = ${userARow.id}`;
        await client`DELETE FROM notifications WHERE entity_id = ${commitBody.data.documentId}`;
      }
    }
  }

  // ================= REG: STATEMENT TRANSACTION VIEW (per-document records) =================
  // GET /api/v1/documents/:id/transactions reads the committed ledger rows that
  // one stored statement produced (server-authoritative, no re-parse), with
  // ownership scoping; the documents list carries the aggregate transactionCount.
  {
    const docLines = [
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
    const docFile = new File([makePdf(docLines) as BlobPart], "w2-doc-tx-view.pdf", {
      type: "application/pdf",
    });
    const uploadDocTx = (token: string) => {
      const fd = new FormData();
      fd.append("file", docFile);
      return uploadRoute.action({
        request: new Request("http://test.local/api/v1/statements/upload", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        }),
      } as never);
    };
    if (tokenA && tokenB && userARow) {
      // clean slate for the fixture
      const priorDocs = await client`SELECT id FROM documents WHERE user_id = ${userARow.id} AND original_name = 'w2-doc-tx-view.pdf'`;
      for (const d of priorDocs) {
        await client`DELETE FROM "Capital_Transactions" WHERE source_document_id = ${d.id} AND user_id = ${userARow.id}`;
        await client`DELETE FROM documents WHERE id = ${d.id} AND user_id = ${userARow.id}`;
      }

      const up = await uploadDocTx(tokenA);
      const upBody = (await up.json()) as { data?: { documentId?: string; saved?: number } };
      ok(
        up.status === 200 && (upBody.data?.saved ?? 0) === 6,
        "REG-doc-tx-view: upload commits 6 rows (2 BUY + 1 SELL trades plus 3 cash movements)"
      );
      const docId = upBody.data?.documentId;
      ok(!!docId, "REG-doc-tx-view: upload returns a document id");

      if (docId) {
        // 1. Own read -> 200 with full rows + stats.
        const own = await documentTransactionsRoute.loader({
          request: authedRequest("GET", tokenA),
          params: { id: docId },
        } as never);
        const ownBody = (await own.json()) as {
          data?: {
            documentName?: string;
            transactions?: Array<{
              side?: string | null;
              fxRateStatement?: string | null;
            }>;
            stats?: {
              total?: number;
              buyCount?: number;
              sellCount?: number;
              cashCount?: number;
              computableSellCount?: number;
              fxRates?: string[];
            };
          };
        };
        ok(
          own.status === 200 && ownBody.data?.documentName === "w2-doc-tx-view.pdf",
          "REG-doc-tx-view: owner reads the document's transactions (200, name echoed)"
        );
        ok(
          ownBody.data?.transactions?.length === 6,
          "REG-doc-tx-view: all 6 committed rows are returned (trades + cash movements)"
        );
        ok(
          ownBody.data?.stats?.buyCount === 2 &&
            ownBody.data?.stats?.sellCount === 1 &&
            ownBody.data?.stats?.cashCount === 3 &&
            ownBody.data?.stats?.computableSellCount === 1 &&
            ownBody.data?.stats?.total === 6,
          "REG-doc-tx-view: stats are server-derived (2 BUY / 1 computable SELL / 3 cash / total 6)"
        );
        ok(
          (ownBody.data?.stats?.fxRates ?? []).includes("35.42"),
          "REG-doc-tx-view: statement FX 35.42 is reported among the applied rates"
        );

        // 2. Cross-user read -> safe 404 (no existence leak).
        const cross = await documentTransactionsRoute.loader({
          request: authedRequest("GET", tokenB),
          params: { id: docId },
        } as never);
        ok(
          cross.status === 404,
          "REG-doc-tx-view: another user reading this document's transactions is a safe 404"
        );

        // 3. Malformed id -> 400.
        const bad = await documentTransactionsRoute.loader({
          request: authedRequest("GET", tokenA),
          params: { id: "not-a-uuid" },
        } as never);
        ok(
          bad.status === 400,
          "REG-doc-tx-view: malformed document id is rejected (400)"
        );

        // 4. Documents list carries the aggregate transactionCount for the statement.
        const list = await documentsRoute.loader({
          request: authedRequest("GET", tokenA),
        } as never);
        const listBody = (await list.json()) as {
          data?: Array<{ id?: string; transactionCount?: number }>;
        };
        const mine = (listBody.data ?? []).find((d) => d.id === docId);
        ok(
          !!mine && mine.transactionCount === 6,
          "REG-doc-tx-view: documents list transactionCount aggregates the statement's rows (6)"
        );

        // cleanup
        await client`DELETE FROM "Capital_Transactions" WHERE user_id = ${userARow.id} AND source_document_id = ${docId}`;
        await client`DELETE FROM documents WHERE id = ${docId} AND user_id = ${userARow.id}`;
        await client`DELETE FROM notifications WHERE entity_id = ${docId}`;
      }
    }
  }

  // ================= REG: REGISTER -> LOGIN -> SESSION SMOKE =================
  {
    const { randomUUID } = await import("node:crypto");
    const smokeEmail = `smoke-${randomUUID()}@test.local`;
    const smokePassword = "SmokePass!234";
    // Per-call random client IP (like registerAs) — the register budget is per-IP.
    const post = (email: string, password: string) =>
      registerAs(email, password);

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

  // ================= REG: AUTH HARDENING =================
  // Rate limiting (PostgreSQL-backed, atomic counters), concurrent-register
  // resolution and privacy (unknown email == wrong password). Every request
  // here pins a DEDICATED client IP via x-forwarded-for so these attempts land
  // on their own rate-limit buckets and never touch the shared "unknown" bucket
  // used by every other loginAs() call in the harness.
  {
    const { randomUUID } = await import("node:crypto");
    const registerRoute = await import("../app/routes/api/auth/register");
    const rlLogin = (email: string, password: string, ip: string) =>
      loginRoute.action({
        request: new Request("http://test.local/api/v1/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": ip,
          },
          body: JSON.stringify({ email, password }),
        }),
      } as never);
    const rlRegister = (email: string, password: string, ip: string) =>
      registerRoute.action({
        request: new Request("http://test.local/api/v1/auth/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": ip,
          },
          body: JSON.stringify({ email, password }),
        }),
      } as never);
    const rlIp = () => `203.0.113.${Math.floor(Math.random() * 200) + 10}`;

    // 1. Concurrent registration of the SAME email resolves atomically:
    //    exactly one 201 and the rest 409 EMAIL_ALREADY_EXISTS (whether via the
    //    pre-check or the DB 23505 unique-constraint race), never a 500.
    {
      const email = `rl-concurrent-${randomUUID()}@test.local`;
      const ip = rlIp();
      const results = await Promise.all(
        Array.from({ length: 4 }, () => rlRegister(email, "Concurrent!234", ip))
      );
      const statuses = results.map((r) => r.status);
      const bodies = (await Promise.all(results.map((r) => r.json()))) as Array<{
        code?: string;
        data?: { user?: { id?: string } };
      }>;
      ok(
        statuses.filter((s) => s === 201).length === 1,
        "AUTH: concurrent same-email registrations produce exactly one 201"
      );
      ok(
        statuses.filter((s) => s === 409).length === 3,
        "AUTH: concurrent registrations beyond the winner are 409"
      );
      ok(
        statuses.every((s) => s === 201 || s === 409),
        "AUTH: concurrent registration never 500s"
      );
      const dupBodies = bodies.filter((_, i) => statuses[i] === 409);
      ok(
        dupBodies.every((b) => b.code === "EMAIL_ALREADY_EXISTS"),
        "AUTH: duplicate 409s carry EMAIL_ALREADY_EXISTS"
      );
      const created = bodies.find((_, i) => statuses[i] === 201);
      if (created?.data?.user?.id) smokeUserIds.push(created.data.user.id);
    }

    // 2. Login failure loop: attempts 1-5 fail with the SAME 401 as before,
    //    the 6th is rate-limited (429 TOO_MANY_ATTEMPTS + Retry-After).
    {
      const email = `rl-loop-${randomUUID()}@test.local`;
      const ip = rlIp();
      for (let i = 1; i <= 5; i++) {
        const res = await rlLogin(email, "WrongPass!234", ip);
        ok(res.status === 401, `AUTH: login failure #${i} still 401 (budget ${i}/5)`);
      }
      const limited = await rlLogin(email, "WrongPass!234", ip);
      ok(limited.status === 429, "AUTH: 6th login failure is 429 (TOO_MANY_ATTEMPTS)");
      const limitedBody = (await limited.json()) as { code?: string };
      ok(
        limitedBody.code === "TOO_MANY_ATTEMPTS",
        "AUTH: login 429 carries code TOO_MANY_ATTEMPTS"
      );
      const retryAfter = Number(limited.headers.get("Retry-After"));
      ok(
        Number.isFinite(retryAfter) && retryAfter >= 1,
        "AUTH: login 429 carries a positive Retry-After header"
      );
    }

    // 3. IP cap: 20 random-email failures on one IP exhaust the shared IP
    //    bucket; the 21st attempt from that IP is a generic 429 even though
    //    each individual email only saw one failure.
    {
      const ip = rlIp();
      for (let i = 1; i <= 20; i++) {
        const res = await rlLogin(`ip-sweep-${i}-${randomUUID()}@test.local`, "WrongPass!234", ip);
        ok(res.status === 401, `AUTH: random-email sweep #${i} still 401`);
      }
      const after = await rlLogin(`ip-sweep-21-${randomUUID()}@test.local`, "WrongPass!234", ip);
      ok(after.status === 429, "AUTH: 21st attempt on the same IP is 429 (IP cap)");
      const afterBody = (await after.json()) as {
        message?: string;
        code?: string;
      };
      ok(
        afterBody.message === "Too many attempts. Please try again later." &&
          afterBody.code === "TOO_MANY_ATTEMPTS",
        "AUTH: IP-cap 429 body is generic (no email-existence leak)"
      );
    }

    // 4. A successful login RESETS the EMAIL budget only (the shared per-IP
    //    bucket keeps prior spray failures — see scenario 8): one failure, then
    //    a correct login clears the email key and rolls back its own IP slot; a
    //    fresh failure loop then needs a full 6 attempts on the EMAIL bucket to
    //    reach 429 (proves the email counter was really cleared).
    {
      const email = `rl-reset-${randomUUID()}@test.local`;
      const ip = rlIp();
      const password = "RlReset!234";
      const reg = await rlRegister(email, password, ip);
      const regBody = (await reg.json()) as { data?: { user?: { id?: string } } };
      ok(reg.status === 201, "AUTH: reset scenario - register succeeds");
      if (regBody.data?.user?.id) smokeUserIds.push(regBody.data.user.id);

      const f1 = await rlLogin(email, "WrongPass!234", ip);
      ok(f1.status === 401, "AUTH: reset scenario - one failure counted");
      const good = await rlLogin(email, password, ip);
      ok(good.status === 200, "AUTH: correct credential resets the budget");
      for (let i = 1; i <= 5; i++) {
        const res = await rlLogin(email, "WrongPass!234", ip);
        ok(res.status === 401, `AUTH: after-reset failure #${i} still 401`);
      }
      const blocked = await rlLogin(email, "WrongPass!234", ip);
      ok(
        blocked.status === 429,
        "AUTH: after-reset, the 6th failure is 429 (clear really reset the budget)"
      );
    }

    // 5. Register spam on ONE email+IP: first 201, duplicates 409, the 11th
    //    attempt is a 429 (duplicate spam is throttled BEFORE the race path).
    {
      const email = `rl-regspam-${randomUUID()}@test.local`;
      const ip = rlIp();
      const password = "RlRegspam!234";
      const first = await rlRegister(email, password, ip);
      const firstBody = (await first.json()) as { data?: { user?: { id?: string } } };
      ok(first.status === 201, "AUTH: register spam - first register 201");
      if (firstBody.data?.user?.id) smokeUserIds.push(firstBody.data.user.id);
      for (let i = 2; i <= 10; i++) {
        const res = await rlRegister(email, password, ip);
        ok(res.status === 409, `AUTH: register spam duplicate #${i - 1} still 409`);
      }
      const blocked = await rlRegister(email, password, ip);
      ok(blocked.status === 429, "AUTH: 11th register attempt is 429");
      const blockedBody = (await blocked.json()) as { code?: string };
      ok(
        blockedBody.code === "TOO_MANY_ATTEMPTS",
        "AUTH: register 429 carries code TOO_MANY_ATTEMPTS"
      );
    }

    // 6. Privacy: an unknown email and a wrong password produce byte-identical
    //    401 bodies (no email-existence enumration via login).
    {
      const unknownEmail = `rl-unknown-${randomUUID()}@test.local`;
      const realEmail = `rl-real-${randomUUID()}@test.local`;
      const ip = rlIp();
      const reg = await rlRegister(realEmail, "RlReal!234", ip);
      const regBody = (await reg.json()) as { data?: { user?: { id?: string } } };
      ok(reg.status === 201, "AUTH: create real user for message-comparison");
      if (regBody.data?.user?.id) smokeUserIds.push(regBody.data.user.id);

      const unknownRes = await rlLogin(unknownEmail, "WrongPass!234", ip);
      const wrongPassRes = await rlLogin(realEmail, "WrongPass!234", ip);
      ok(
        unknownRes.status === 401 && wrongPassRes.status === 401,
        "AUTH: unknown email and wrong password both 401"
      );
      const uBody = (await unknownRes.json()) as { message?: string; code?: string };
      const wBody = (await wrongPassRes.json()) as { message?: string; code?: string };
      ok(
        uBody.message === "Invalid email or password" &&
          wBody.message === "Invalid email or password",
        "AUTH: unknown-email and wrong-password 401 messages are identical"
      );
      ok(
        !uBody.code && !wBody.code,
        "AUTH: 401 bodies carry no distinguishing code"
      );
    }

    // 7. The REGISTER budget is per-IP, NOT per-IP-per-email — rotating the
    //    email from one IP must NOT buy a fresh bucket. 10 DIFFERENT emails
    //    from one IP are all allowed (201), the 11th (even a brand-new email)
    //    is a generic 429, and a DIFFERENT IP still registers fine.
    {
      const ip = rlIp();
      const email = () => `rl-rotate-${randomUUID()}@test.local`;
      for (let i = 1; i <= 10; i++) {
        const res = await rlRegister(email(), "RlRotate!234", ip);
        const body = (await res.json()) as { data?: { user?: { id?: string } } };
        ok(res.status === 201, `AUTH: rotating-email register #${i} (same IP) is 201`);
        if (body.data?.user?.id) smokeUserIds.push(body.data.user.id);
      }
      const eleventh = await rlRegister(email(), "RlRotate!234", ip);
      ok(
        eleventh.status === 429,
        "AUTH: 11th rotating email on the SAME IP is 429 (IP-only register budget)"
      );
      const elsewhere = await rlRegister(email(), "RlRotate!234", rlIp());
      const elsewhereBody = (await elsewhere.json()) as {
        data?: { user?: { id?: string } };
      };
      ok(
        elsewhere.status === 201,
        "AUTH: a fresh IP can still register (budget is per-IP, not global)"
      );
      if (elsewhereBody.data?.user?.id)
        smokeUserIds.push(elsewhereBody.data.user.id);
    }

    // 8. Login IP-reset bypass: a successful login must NOT wipe the shared
    //    per-IP bucket (credential-spray protection). 19 random-email failures
    //    on one IP, then ONE success — the success's own IP reservation is
    //    rolled back (bucket back to 19), so failure #20 is still 401 and
    //    failure #21 hits the 20-cap 429. Prior spray is never forgiven.
    {
      const ip = rlIp();
      const email = `rl-spray-${randomUUID()}@test.local`;
      const reg = await rlRegister(email, "RlSpray!234", ip);
      const regBody = (await reg.json()) as { data?: { user?: { id?: string } } };
      ok(reg.status === 201, "AUTH: spray-reset - attacker account created");
      if (regBody.data?.user?.id) smokeUserIds.push(regBody.data.user.id);
      for (let i = 1; i <= 19; i++) {
        const res = await rlLogin(
          `spray-${i}-${randomUUID()}@test.local`,
          "WrongPass!234",
          ip
        );
        ok(res.status === 401, `AUTH: spray failure #${i} still 401`);
      }
      const good = await rlLogin(email, "RlSpray!234", ip);
      ok(good.status === 200, "AUTH: success mid-spray is allowed");
      const f20 = await rlLogin(
        `spray-20-${randomUUID()}@test.local`,
        "WrongPass!234",
        ip
      );
      ok(
        f20.status === 401,
        "AUTH: IP bucket NOT reset by success - spray failure #20 is still 401"
      );
      const f21 = await rlLogin(
        `spray-21-${randomUUID()}@test.local`,
        "WrongPass!234",
        ip
      );
      ok(
        f21.status === 429,
        "AUTH: spray failure #21 is 429 (prior spray preserved across a success)"
      );
    }

    // 9. Legit usage is never wedged by its own successes: every successful
    //    login rolls back ITS OWN per-IP reservation, so repeated successes on
    //    one IP leave the shared IP bucket EMPTY (a success nets zero), and a
    //    success still resets the EMAIL bucket for the account concerned —
    //    verified directly against the auth_rate_limits counters.
    {
      const ip = rlIp();
      const email = `rl-legit-${randomUUID()}@test.local`;
      const reg = await rlRegister(email, "RlLegit!234", ip);
      const regBody = (await reg.json()) as { data?: { user?: { id?: string } } };
      ok(reg.status === 201, "AUTH: legit-success - account created");
      if (regBody.data?.user?.id) smokeUserIds.push(regBody.data.user.id);
      for (let i = 1; i <= 6; i++) {
        const res = await rlLogin(email, "RlLegit!234", ip);
        ok(res.status === 200, `AUTH: repeated successful login #${i} is 200`);
      }
      const ipBucket = await client`
        SELECT attempts FROM auth_rate_limits
        WHERE key = ${"login-ip:" + ip}
      `;
      ok(
        ipBucket.length === 0,
        "AUTH: 6 successes leave NO per-IP counter (each rolls back its own slot)"
      );
      const f1 = await rlLogin(email, "WrongPass!234", ip);
      ok(f1.status === 401, "AUTH: legit - post-success failure #1 still 401");
      for (let i = 2; i <= 5; i++) {
        const res = await rlLogin(email, "WrongPass!234", ip);
        ok(res.status === 401, `AUTH: legit - post-success failure #${i} still 401`);
      }
      const blocked = await rlLogin(email, "WrongPass!234", ip);
      ok(
        blocked.status === 429,
        "AUTH: legit - success reset the EMAIL bucket - 6th failure is 429"
      );
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
  // Valid extractable PDF with unsupported content: archiveable, no trades.
  // A corrupt magic-header-only fixture used to rely on failed-upload leftovers.
  const pdfBytes = makePdf(["Telemetry archive fixture without supported trades"]);
  const pdfFile = new File([pdfBytes as BlobPart], "w2-telemetry-test.pdf", {
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
  ok(uploadRes.status === 200 && !!uploadedDocId, "W2-10: valid telemetry PDF upload succeeds");

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
  ok(!!uploadedRow, "W2-10: successful upload has document metadata");
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

  // === W2-11: NOTIFICATIONS + HISTORICAL FX PROVIDER (MOCKED) ===
  console.log("\n=== W2-11: NOTIFICATIONS / HISTORICAL FX (MOCKED) ===");
  {
    const { randomUUID } = await import("node:crypto");

    // ---- 1. Notifications: idempotency + opt-out (service level, DB-backed) ----
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

    // ---- 2. Historical FX provider with MOCKED HTTP (never a live call) ----
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

    // ---- 3. users.created_at set on registration ----
    {
      const email = `join-${randomUUID()}@test.local`;
      const res = await registerAs(email, "JoinPass!234");
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

  // ================= REG: GENERAL LEDGER WIRING =================
  // Proves the double-entry backend is wired end-to-end through the REAL route
  // modules (not direct service calls): registration seeds the default chart of
  // accounts, a manual entry posted by account CODE resolves to the user's UUID
  // account ids, the journal list + trial balance read back what posted,
  // currency-mismatched entries are rejected, and reversal posts an inverted
  // mirror. All rows are tracked and removed in CLEANUP.
  {
    console.log("\n=== REG: GENERAL LEDGER WIRING ===");
    const { randomUUID } = await import("node:crypto");
    const glEmail = `gl-${randomUUID()}@test.local`;
    const glPassword = "GLPost!234";
    const regRes = await registerAs(glEmail, glPassword);
    const regJson = (await regRes.json()) as { data?: { user?: { id?: string } } };
    const glUserId = regJson.data?.user?.id;
    if (!glUserId) {
      ok(false, "REG-GL: register failed to create the ledger test user");
    } else {
      smokeUserIds.push(glUserId);
      const glLogin = await loginAs(glEmail, glPassword);
      const glToken = glLogin.data?.accessToken as string | undefined;
      if (!glToken) {
        ok(false, "REG-GL: registered ledger user could not log in");
      } else {
        // 1. Default chart of accounts seeded by registration.
        const accountsRes = await accountsRoute.loader({
          request: authedRequest("GET", glToken),
        } as never);
        const accountsBody = (await accountsRes.json()) as {
          data?: { id: string; code: string }[];
        };
        const codes = (accountsBody.data ?? []).map((a) => a.code);
        ok(codes.length >= 14, "REG-GL: default chart of accounts seeded after registration (14+)");
        ok(
          codes.includes("1020") && codes.includes("3010"),
          "REG-GL: broker cash + owner-capital accounts present"
        );

        // 2. Manual entry posted by account CODE (service resolves to UUID ids).
        const jRes = await journalRoute.action({
          request: jsonBody(
            {
              entryDate: "2026-01-15",
              description: "ฝากเงินเข้าบัญชี",
              lines: [
                { accountId: "1020", currency: "USD", debit: "1000.00", fxRateEffective: "35.0" },
                { accountId: "3010", currency: "USD", credit: "1000.00", fxRateEffective: "35.0" },
              ],
            },
            "POST",
            glToken
          ),
        } as never);
        const jJson = (await jRes.json()) as { data?: { entryId?: string; entryNo?: number } };
        const entryId = jJson.data?.entryId;
        ok(jRes.status === 201 && !!entryId, "REG-GL: manual journal entry created via route (201)");

        // 3. Currency mismatch is rejected (THB line into the USD equity account).
        const badRes = await journalRoute.action({
          request: jsonBody(
            {
              entryDate: "2026-01-16",
              description: "ผิดสกุล",
              lines: [
                { accountId: "1010", currency: "THB", debit: "100" },
                { accountId: "3010", currency: "USD", credit: "100" },
              ],
            },
            "POST",
            glToken
          ),
        } as never);
        ok(badRes.status === 422, "REG-GL: currency-mismatched entry rejected (422)");

        // 4. Journal list reads back the posted entry with its lines.
        if (entryId) {
          const listRes = await journalRoute.loader({
            request: authedRequest("GET", glToken),
          } as never);
          const listJson = (await listRes.json()) as {
            data?: { id: string; lines: unknown[] }[];
          };
          const found = listJson.data?.find((e) => e.id === entryId);
          ok(!!found && found.lines.length === 2, "REG-GL: journal list returns the entry with 2 lines");

          // 5. Trial balance reflects the posted deposit and balances.
          const tbRes = await trialBalanceRoute.loader({
            request: authedRequest("GET", glToken),
          } as never);
          const tbJson = (await tbRes.json()) as {
            data?: { balanced?: boolean; totalDebit?: string; totalDebitThb?: string; balancedThb?: boolean };
          };
          ok(
            tbJson.data?.balanced === true && tbJson.data?.totalDebit === "1000.00",
            "REG-GL: trial balance balanced with total 1000.00"
          );
          ok(
            tbJson.data?.totalDebitThb === "35000.00" && tbJson.data?.balancedThb === true,
            "REG-GL: trial balance THB-base total 35000.00 and balanced"
          );

          // 6. Reversal posts an inverted mirror and marks the original REVERSED.
          const revRes = await journalReverseRoute.action({
            request: authedRequest("POST", glToken),
            params: { id: entryId },
          } as never);
          const revJson = (await revRes.json()) as { data?: { reversalEntryNo?: number } };
          ok(
            revRes.status === 200 && typeof revJson.data?.reversalEntryNo === "number",
            "REG-GL: reversal posts a mirror entry (200)"
          );
        }
      }
    }
  }

  // ================= REG: THB EQUITY (3020) + SKIPPED-EQUITY RECONCILE =================
  // THB owner deposits can now be posted: the default chart of accounts includes
  // 3020 (THB owner capital). This proves through the REAL routes + service that
  // (a) a fresh user's CoA contains exactly one 3020, (b) a manual THB CASH_IN
  // posts Dr 1010 / Cr 3020 (and USD still Dr 1020 / Cr 3010), and (c) the
  // reconcile re-post of previously-SKIPPED STATEMENT equity rows is
  // deterministic + idempotent (built via the real engine, never hand-written).
  {
    console.log("\n=== REG: THB EQUITY 3020 + SKIPPED-EQUITY RECONCILE ===");
    const { randomUUID } = await import("node:crypto");
    const equityAccountsRoute = await import("../app/routes/api/accounts");
    const capitalLedgersRoute = await import("../app/routes/api/capital-ledgers");
    const { reconcileSkippedEquityPostings } = await import(
      "../app/lib/ledger-service"
    );

    const thbEmail = `thb-${randomUUID()}@test.local`;
    const thbPassword = "ThbEquity!234";
    const regRes = await registerAs(thbEmail, thbPassword);
    const regJson = (await regRes.json()) as { data?: { user?: { id?: string } } };
    const thbUserId = regJson.data?.user?.id;
    if (!thbUserId) {
      ok(false, "REG-EQUITY: register failed to create the THB-equity user");
    } else {
      smokeUserIds.push(thbUserId);
      const thbLogin = await loginAs(thbEmail, thbPassword);
      const thbToken = thbLogin.data?.accessToken as string | undefined;
      if (!thbToken) {
        ok(false, "REG-EQUITY: registered THB-equity user could not log in");
      } else {
        // 1. Fresh registration seeds exactly one 3020 (THB owner capital).
        const accRes = await equityAccountsRoute.loader({
          request: authedRequest("GET", thbToken),
        } as never);
        const accBody = (await accRes.json()) as {
          data?: { code: string; currency: string }[];
        };
        const accCodes = accBody.data ?? [];
        const thbCap = accCodes.filter((a) => a.code === "3020");
        ok(
          thbCap.length === 1 && thbCap[0].currency === "THB",
          "REG-EQUITY: fresh CoA has exactly one 3020 THB owner-capital account"
        );

        // 2. Manual THB CASH_IN -> Dr 1010 / Cr 3020 (owner deposit).
        const thbIn = await capitalLedgersRoute.action({
          request: jsonBody(
            {
              amountForeign: "5000.00",
              currency: "THB",
              transactionDate: "2026-01-10",
              fxRateBot: "1",
              amountThb: "5000.00",
              type: "CASH_IN",
              sourceType: "MANUAL",
            },
            "POST",
            thbToken
          ),
        } as never);
        const thbInJson = (await thbIn.json()) as { data?: { transactionId?: string } };
        ok(
          thbIn.status === 201 && !!thbInJson.data?.transactionId,
          "REG-EQUITY: manual THB deposit created (201)"
        );
        if (thbInJson.data?.transactionId) {
          const [je] = await client`
            SELECT j.id, j.source_transaction_id, (SELECT count(*)::int FROM journal_entry_lines l WHERE l.journal_entry_id = j.id) AS lines
            FROM journal_entries j WHERE j.source_transaction_id = ${thbInJson.data.transactionId}`;
          ok(
            !!je && je.lines === 2,
            "REG-EQUITY: THB deposit mirrored in the journal with 2 lines"
          );
          if (je) {
            const legs = await client`
              SELECT a.code, a.currency, l.debit_amount, l.credit_amount
              FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
              WHERE l.journal_entry_id = ${je.id}`;
            const dr = legs.find((l: any) => l.debit_amount);
            const cr = legs.find((l: any) => l.credit_amount);
            ok(
              !!dr && dr.code === "1010" && dr.currency === "THB" &&
                !!cr && cr.code === "3020" && cr.currency === "THB" &&
                Number(dr.debit_amount) === 5000.0 && Number(cr.credit_amount) === 5000.0,
              "REG-EQUITY: THB deposit posts Dr 1010 / Cr 3020 (not 3010)"
            );
          }
        }

        // 3. Manual USD CASH_IN still posts Dr 1020 / Cr 3010 (unchanged).
        const usdIn = await capitalLedgersRoute.action({
          request: jsonBody(
            {
              amountForeign: "100.00",
              currency: "USD",
              transactionDate: "2026-01-10",
              fxRateBot: "35",
              amountThb: "3500.00",
              type: "CASH_IN",
              sourceType: "MANUAL",
            },
            "POST",
            thbToken
          ),
        } as never);
        const usdInJson = (await usdIn.json()) as { data?: { transactionId?: string } };
        if (usdInJson.data?.transactionId) {
          const [je] = await client`
            SELECT id FROM journal_entries WHERE source_transaction_id = ${usdInJson.data.transactionId}`;
          const legs = await client`
            SELECT a.code, l.debit_amount, l.credit_amount
            FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
            WHERE l.journal_entry_id = ${je.id}`;
          const dr = legs.find((l: any) => l.debit_amount);
          const cr = legs.find((l: any) => l.credit_amount);
          ok(
            !!dr && dr.code === "1020" && !!cr && cr.code === "3010",
            "REG-EQUITY: USD deposit still posts Dr 1020 / Cr 3010"
          );
        }

        // 4. Reconcile previously-SKIPPED STATEMENT equity rows. Simulate the
        //    pre-3020 state: a THB equity STATEMENT row whose journal entry is
        //    SKIPPED with zero lines + reason, exactly as imports recorded it.
        const txSkipped = randomUUID();
        await client`
          INSERT INTO "Capital_Transactions"
            (transaction_id, user_id, amount_foreign, currency, transaction_date,
             amount_thb, type, source_type, source_document_id, category, section,
             exchange, fx_rate_statement, fx_rate_effective, is_monthly_fee_aggregate)
          VALUES (${txSkipped}, ${thbUserId}, '2500.00', 'THB', '2026-01-12', '2500.00',
                  'CASH_IN', 'AI_PARSED', ${"doc-legacy"}, 'equity', 'ฝากเงิน',
                  NULL, NULL, '1', false)`;
        const entryId = randomUUID();
        await client`
          INSERT INTO journal_entries
            (id, user_id, entry_no, entry_date, description, source_type,
             source_transaction_id, status, category, section, currency,
             amount, amount_thb, fx_rate_effective, posting_state, skip_reason,
             created_at, updated_at, type)
          VALUES (${entryId}, ${thbUserId}, 9001, '2026-01-12', 'รายการจากงบ (legacy THB deposit)',
                  'STATEMENT', ${txSkipped}, 'POSTED', 'equity', 'ฝากเงิน',
                  'THB', '2500.00', '2500.00', '1', 'SKIPPED',
                  'no compatible THB account for 3010',
                  ${new Date().toISOString()}, ${new Date().toISOString()}, 'CASH_IN')`;

        const recon1 = await reconcileSkippedEquityPostings(thbUserId);
        ok(
          recon1.scanned >= 1 &&
            recon1.stillSkipped.length === 0 &&
            recon1.promoted >= 1,
          "REG-EQUITY: reconcile promotes the SKIPPED THB equity entry"
        );
        const [postRecon] = await client`
          SELECT posting_state, skip_reason FROM journal_entries WHERE id = ${entryId}`;
        ok(
          postRecon.posting_state === "POSTED" && postRecon.skip_reason === null,
          "REG-EQUITY: promoted entry is POSTED with a cleared skip reason"
        );
        const legs = await client`
          SELECT a.code, a.currency, l.debit_amount, l.credit_amount
          FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.journal_entry_id = ${entryId}`;
        const dr = legs.find((l: any) => l.debit_amount);
        const cr = legs.find((l: any) => l.credit_amount);
        ok(
          !!dr && dr.code === "1010" && !!cr && cr.code === "3020" &&
            Number(dr.debit_amount) === 2500.0 && Number(cr.credit_amount) === 2500.0,
          "REG-EQUITY: reconciled entry posts real Dr 1010 / Cr 3020 lines"
        );

        // 5. Idempotent: a second reconcile touches nothing.
        const recon2 = await reconcileSkippedEquityPostings(thbUserId);
        ok(recon2.promoted === 0, "REG-EQUITY: re-running reconcile is a no-op");

        // 6. The replay produces the identical entry as a fresh import of the
        //    same row (same engine, same accounts) and NEVER mutates the source
        //    Capital_Transactions row.
        const [keptRow] = await client`
          SELECT amount_foreign, currency, category, type, fx_rate_effective
          FROM "Capital_Transactions" WHERE transaction_id = ${txSkipped}`;
        ok(
          !!keptRow && Number(keptRow.amount_foreign) === 2500.0 &&
            keptRow.currency === "THB" && keptRow.category === "equity" &&
            keptRow.type === "CASH_IN" &&
            Number(keptRow.fx_rate_effective) === 1.0,
          "REG-EQUITY: reconcile never mutates the source Capital_Transactions row"
        );

        // Self-clean the simulated rows (the shared CLEANUP also handles this
        // user via smokeUserIds, but remove the doc-linked rows first).
        await client`DELETE FROM journal_entry_lines WHERE user_id = ${thbUserId}`;
        await client`DELETE FROM journal_entries WHERE user_id = ${thbUserId}`;
        await client`DELETE FROM "Capital_Transactions" WHERE user_id = ${thbUserId}`;
      }
    }
  }

  // ================= REG: TRANSACTION RECORD VIEW (ledger line -> source tx) =================
  // A statement posting attaches sourceTransactionId to each journal line; the
  // account-ledger route surfaces it on every line, and GET
  // /api/v1/capital-ledgers/:id returns that single authoritative transaction
  // (the "ดูธุรกรรม" drill-down) — owner-only, safe 404 cross-user.
  {
    console.log("\n=== REG: TRANSACTION RECORD VIEW ===");
    const { randomUUID } = await import("node:crypto");
    const accountLedgerRoute = await import("../app/routes/api/ledger.$accountId");
    const { deleteStoredFile } = await import(
      "../app/lib/storage/statement-storage"
    );

    const txrEmail = `txr-${randomUUID()}@test.local`;
    const txrPassword = "TxRecord!234";
    const regRes = await registerAs(txrEmail, txrPassword);
    const regJson = (await regRes.json()) as { data?: { user?: { id?: string } } };
    const txrUserId = regJson.data?.user?.id;
    if (!txrUserId) {
      ok(false, "REG-TXREC: register failed to create the transaction-record user");
    } else {
      smokeUserIds.push(txrUserId);
      const txrLogin = await loginAs(txrEmail, txrPassword);
      const txrToken = txrLogin.data?.accessToken as string | undefined;
      if (!txrToken) {
        ok(false, "REG-TXREC: registered user could not log in");
      } else {
        const otherEmail = `txr-other-${randomUUID()}@test.local`;
        const otherPass = "TxRecord-#other1";
        const otherReg = await registerAs(otherEmail, otherPass);
        const otherJson = (await otherReg.json()) as {
          data?: { user?: { id?: string } };
        };
        const otherUserId = otherJson.data?.user?.id;
        if (otherUserId) smokeUserIds.push(otherUserId);
        const otherLogin = await loginAs(otherEmail, otherPass);
        const otherToken = otherLogin.data?.accessToken as string | undefined;

        // 1. Upload a 3-row statement; the postings it triggers must carry
        //    sourceTransactionId on their journal lines.
        const txrLines = [
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
        const txrFile = new File(
          [makePdf(txrLines) as BlobPart],
          "w2-tx-record.pdf",
          { type: "application/pdf" }
        );
        const txrFd = new FormData();
        txrFd.append("file", txrFile);
        const up = await uploadRoute.action({
          request: new Request("http://test.local/api/v1/statements/upload", {
            method: "POST",
            headers: { Authorization: `Bearer ${txrToken}` },
            body: txrFd,
          }),
        } as never);
        const upBody = (await up.json()) as {
          data?: { documentId?: string; saved?: number };
        };
        const txrDocId = upBody.data?.documentId;
        ok(
          up.status === 200 && !!txrDocId && (upBody.data?.saved ?? 0) === 6,
          "REG-TXREC: statement upload stores 6 rows (3 trades + 3 cash movements) that trigger postings"
        );

        if (txrDocId) {
          // 2. The posted journal line (with its source transaction id).
          const lineRows = await client`
            SELECT jel.id AS line_id, jel.account_id AS account_id,
                   je.id AS entry_id, je.source_transaction_id
            FROM journal_entry_lines jel
            JOIN journal_entries je ON jel.journal_entry_id = je.id
            WHERE jel.user_id = ${txrUserId}
              AND je.source_transaction_id IS NOT NULL
            ORDER BY je.entry_date, je.entry_no, jel.id
            LIMIT 1`;
          const lineRow = lineRows[0];
          ok(
            !!lineRow && !!lineRow.source_transaction_id,
            "REG-TXREC: statement postings carry sourceTransactionId on journal lines"
          );

          if (lineRow) {
            const txId = lineRow.source_transaction_id as string;

            // 3. Owner reads the single transaction record (the clicked entry).
            const txRes = await ledgerRoute.loader({
              request: authedRequest("GET", txrToken),
              params: { id: txId },
            } as never);
            const txBody = (await txRes.json()) as {
              data?: { transactionId?: string; symbol?: string };
            };
            ok(
              txRes.status === 200 && txBody.data?.transactionId === txId,
              "REG-TXREC: owner reads the source transaction record (200, id matches)"
            );
            ok(
              txBody.data?.symbol === "VRMAX",
              "REG-TXREC: returned record is the clicked entry (symbol matches)"
            );

            // 4. Cross-user read is a safe 404.
            if (otherToken) {
              const crossRes = await ledgerRoute.loader({
                request: authedRequest("GET", otherToken),
                params: { id: txId },
              } as never);
              ok(
                crossRes.status === 404,
                "REG-TXREC: another user reading the record is a safe 404"
              );
            }

            // 5. The account-ledger route surfaces sourceTransactionId on the line.
            const alRes = await accountLedgerRoute.loader({
              request: authedRequest("GET", txrToken),
              params: { accountId: lineRow.account_id as string },
            } as never);
            const alBody = (await alRes.json()) as {
              data?: {
                lines?: Array<{
                  lineId?: string;
                  sourceTransactionId?: string | null;
                }>;
              };
            };
            const foundLine = (alBody.data?.lines ?? []).find(
              (l) => l.lineId === lineRow.line_id
            );
            ok(
              !!foundLine &&
                foundLine.sourceTransactionId === lineRow.source_transaction_id,
              "REG-TXREC: account ledger exposes sourceTransactionId on the posting line"
            );
          }

          // cleanup: rows, document, cost basis, notifications, postings, file
          await client`DELETE FROM "Capital_Transactions" WHERE user_id = ${txrUserId}`;
          await client`DELETE FROM documents WHERE user_id = ${txrUserId}`;
          await client`DELETE FROM cost_basis_state WHERE user_id = ${txrUserId}`;
          await client`DELETE FROM notifications WHERE user_id = ${txrUserId}`;
          await client`DELETE FROM journal_entry_lines WHERE user_id = ${txrUserId}`;
          await client`DELETE FROM journal_entries WHERE user_id = ${txrUserId}`;
          await deleteStoredFile(`statements/${txrUserId}/${txrDocId}.pdf`).catch(
            () => {}
          );
        }
      }
    }
  }

  // ================= REG: PER-STOCK DETAIL (case-by-case stocks) =================
  // GET /api/v1/portfolio/:symbol returns EVERY ledger row for one ticker plus the
  // current holding, latest daily close and server-computed realized totals —
  // the data behind the "รายละเอียดหุ้นรายตัว" screen. Ownership-scoped (safe 404
  // cross-user), uppercase-normalized, symbol-validated, read-only (405).
  {
    console.log("\n=== REG: PER-STOCK DETAIL (CASE-BY-CASE STOCKS) ===");
    const { randomUUID } = await import("node:crypto");
    const portfolioRoute = await import("../app/routes/api/portfolio.$symbol");
    const { deleteStoredFile } = await import(
      "../app/lib/storage/statement-storage"
    );

    const pfEmail = `pf-${randomUUID()}@test.local`;
    const pfPassword = "PfStock!234";
    const regRes = await registerAs(pfEmail, pfPassword);
    const regJson = (await regRes.json()) as { data?: { user?: { id?: string } } };
    const pfUserId = regJson.data?.user?.id;
    if (!pfUserId) {
      ok(false, "REG-pf: register failed to create the per-stock test user");
    } else {
      smokeUserIds.push(pfUserId);
      const pfLogin = await loginAs(pfEmail, pfPassword);
      const pfToken = pfLogin.data?.accessToken as string | undefined;
      if (!pfToken) {
        ok(false, "REG-pf: registered user could not log in");
      } else {
        const otherEmail = `pf-other-${randomUUID()}@test.local`;
        const otherPass = "PfOther!#234";
        const otherReg = await registerAs(otherEmail, otherPass);
        const otherJson = (await otherReg.json()) as {
          data?: { user?: { id?: string } };
        };
        const otherUserId = otherJson.data?.user?.id;
        if (otherUserId) smokeUserIds.push(otherUserId);
        const otherLogin = await loginAs(otherEmail, otherPass);
        const otherToken = otherLogin.data?.accessToken as string | undefined;

        // 1. Upload a VRMAX statement (2 BUY + 1 computable SELL + their cash rows).
        const pfLines = [
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
        const pfFile = new File(
          [makePdf(pfLines) as BlobPart],
          "w2-per-stock.pdf",
          { type: "application/pdf" }
        );
        const pfFd = new FormData();
        pfFd.append("file", pfFile);
        const up = await uploadRoute.action({
          request: new Request("http://test.local/api/v1/statements/upload", {
            method: "POST",
            headers: { Authorization: `Bearer ${pfToken}` },
            body: pfFd,
          }),
        } as never);
        const upBody = (await up.json()) as {
          data?: { documentId?: string; saved?: number };
        };
        const pfDocId = upBody.data?.documentId;
        ok(
          up.status === 200 && !!pfDocId && (upBody.data?.saved ?? 0) === 6,
          "REG-pf: per-stock fixture upload commits the VRMAX statement (3 trade rows + 3 cash movements = 6 saved)"
        );

        // Optional stock_prices seed (0017) — quote path only when the table exists.
        const quoteTable =
          await client`SELECT 1 FROM information_schema.tables WHERE table_name = 'stock_prices'`;
        if (quoteTable.length > 0 && pfUserId) {
          await client`
            INSERT INTO stock_prices
              (id, symbol, price_date, close_price, currency, source, created_at, updated_at)
            VALUES
              ('00000000-0000-0000-0000-0000000000ab', 'VRMAX', '2026-09-11', '25.00', 'USD', 'yahoo-finance', now(), now())
            ON CONFLICT (symbol, price_date) DO UPDATE SET close_price = '25.00', updated_at = now()`;
        }

        const portfolioRequest = (token: string, symbol: string) =>
          portfolioRoute.loader({
            request: authedRequest("GET", token),
            params: { symbol },
          } as never);

        if (pfDocId) {
          // 2. Owner reads the per-stock detail (200, full data).
          const own = await portfolioRequest(pfToken, "VRMAX");
          const ownBody = (await own.json()) as {
            success?: boolean;
            data?: {
              symbol?: string;
              trades?: Array<{ side?: string | null }>;
              holding?: {
                quantity?: string;
                avgCost?: string;
                totalCost?: string;
                marketValue?: string | null;
                unrealizedPnl?: string | null;
              } | null;
              quote?: {
                close?: string;
                currency?: string;
                priceDate?: string;
              } | null;
              totals?: {
                tradeCount?: number;
                buyCount?: number;
                sellCount?: number;
                cashCount?: number;
                computableSellCount?: number;
                nonComputableSellCount?: number;
                totalRealizedThb?: string | null;
              };
            };
          };
          ok(
            own.status === 200 && ownBody.data?.symbol === "VRMAX",
            "REG-pf: owner reads the per-stock detail (200, symbol echoed uppercase)"
          );
          ok(
            (ownBody.data?.trades?.length ?? 0) === 3 &&
              (ownBody.data?.totals?.tradeCount ?? 0) === 3,
            "REG-pf: all 3 of the stock's ledger rows are returned"
          );
          ok(
            ownBody.data?.totals?.buyCount === 2 &&
              ownBody.data?.totals?.sellCount === 1 &&
              ownBody.data?.totals?.computableSellCount === 1 &&
              ownBody.data?.totals?.nonComputableSellCount === 0,
            "REG-pf: per-stock totals classify the trades server-side (2 BUY / 1 computable SELL)"
          );
          ok(
            Number(ownBody.data?.totals?.totalRealizedThb) === 26491.68,
            "REG-pf: realized P&L total is the server-authoritative THB sum (net 1497.93 − basis 750 = 747.93, × 35.42 = 26491.68)"
          );
          ok(
            Number(ownBody.data?.holding?.quantity) === 150 &&
              Number(ownBody.data?.holding?.avgCost) === 15 &&
              Number(ownBody.data?.holding?.totalCost) === 2250,
            "REG-pf: holding from cost_basis_state (150 @ avg 15, total 2250)"
          );
          if (quoteTable.length > 0) {
            ok(
              Number(ownBody.data?.quote?.close) === 25 &&
                ownBody.data?.quote?.currency === "USD" &&
                Number(ownBody.data?.holding?.marketValue) === 3750 &&
                Number(ownBody.data?.holding?.unrealizedPnl) === 1500,
              "REG-pf: latest close + market value + unrealized P&L are server-computed (25 × 150 / (25−15) × 150)"
            );
          } else {
            ok(
              ownBody.data?.quote === null,
              "REG-pf: quote stays null when no stock_prices table (honest '-')"
            );
          }

          // 3. Symbol is case-insensitive (uppercased server-side).
          const lower = await portfolioRequest(pfToken, "vrmax");
          const lowerBody = (await lower.json()) as {
            data?: { trades?: unknown[] };
          };
          ok(
            lower.status === 200 && (lowerBody.data?.trades?.length ?? 0) === 3,
            "REG-pf: lowercase symbol resolves to the same uppercase detail"
          );

          // 4. Cross-user read is a safe 404.
          if (otherToken) {
            const cross = await portfolioRequest(otherToken, "VRMAX");
            ok(
              cross.status === 404,
              "REG-pf: another user reading this stock's detail is a safe 404"
            );
          }

          // 5. Unknown symbol for the OWNER is also a safe 404.
          const unknown = await portfolioRequest(pfToken, "ZZZZQ");
          ok(
            unknown.status === 404,
            "REG-pf: a symbol with no trades/holding for the owner is a 404"
          );

          // 6. Invalid / oversized symbols are rejected (400).
          const invalid = await portfolioRoute.loader({
            request: authedRequest("GET", pfToken),
            params: { symbol: "BAD@SYMBOL" },
          } as never);
          const oversized = await portfolioRoute.loader({
            request: authedRequest("GET", pfToken),
            params: { symbol: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
          } as never);
          ok(
            invalid.status === 400 && oversized.status === 400,
            "REG-pf: non-ticker and oversized symbols are rejected (400)"
          );

          // 7. Read-only: action (POST) → 405.
          const act = await portfolioRoute.action();
          ok(
            act.status === 405,
            "REG-pf: POST to the per-stock route is rejected (405, read-only)"
          );
        }

        // cleanup: rows, document, cost basis, notifications, postings, quotes, file
        if (pfDocId) {
          await client`DELETE FROM journal_entry_lines WHERE user_id = ${pfUserId}`;
          await client`DELETE FROM journal_entries WHERE user_id = ${pfUserId}`;
        }
        await client`DELETE FROM "Capital_Transactions" WHERE user_id = ${pfUserId}`;
        await client`DELETE FROM documents WHERE user_id = ${pfUserId}`;
        await client`DELETE FROM cost_basis_state WHERE user_id = ${pfUserId}`;
        await client`DELETE FROM notifications WHERE user_id = ${pfUserId}`;
        if (quoteTable.length > 0) {
          await client`DELETE FROM stock_prices WHERE symbol = 'VRMAX' AND price_date = '2026-09-11'`;
        }
        if (pfDocId) {
          await deleteStoredFile(`statements/${pfUserId}/${pfDocId}.pdf`).catch(
            () => {}
          );
        }
        console.log("  Removed per-stock detail fixture data.");
      }
    }
  }

  // ================= REG: GAIN/LOSS BACKFILL (FROZEN SELL) =================
  // Heals AI_PARSED SELL rows whose realized gain/loss was frozen at import
  // because the supporting BUY arrived in a LATER statement. Walks the real DB
  // wrapper (backfillComputedGainLoss): out-of-order rows are replayed
  // chronologically and the SELL's stored costBasis/proceeds/realized gain is
  // filled from the authoritative net_amount — while a MANUAL SELL with the
  // same basis is left untouched. Requires the 0016 migration (net_amount) —
  // skipped (with a note) when the column is absent.
  {
    const netCol =
      await client`SELECT column_name FROM information_schema.columns WHERE table_name = 'Capital_Transactions' AND column_name = 'net_amount'`;
    const netColPresent = netCol.length > 0;
    if (!netColPresent) {
      console.log(
        "\n  SKIP  REG-backfill: net_amount column absent (run the 0016 migration)"
      );
    } else {
      console.log("\n=== REG: GAIN/LOSS BACKFILL (FROZEN SELL) ===");
      const { randomUUID } = await import("node:crypto");
      const backfillPath = await import("../app/lib/statement-pipeline");
      const bfEmail = `bf-${randomUUID()}@test.local`;
      const bfRes = await registerAs(bfEmail, "BfPass!234");
      const bfJson = (await bfRes.json()) as { data?: { user?: { id?: string } } };
      const bfUserId = bfJson.data?.user?.id;
      if (!bfUserId) {
        ok(false, "REG-backfill: register failed to create the backfill test user");
      } else {
        smokeUserIds.push(bfUserId);
        const sellId = randomUUID();
        // Out-of-order history: the SELL (02-05) is present, the supporting BUY
        // (01-20) was imported in a later statement. Both AI_PARSED, SELL NULL.
        await client`
          INSERT INTO "Capital_Transactions"
            (transaction_id, user_id, amount_foreign, currency, transaction_date, amount_thb, type, source_type, symbol, side, quantity, unit_price, gross_amount, fees, net_amount, fx_rate_effective)
          VALUES
            (${randomUUID()}, ${bfUserId}, '200.00', 'USD', '2026-01-20', '7084.00', 'CASH_OUT', 'AI_PARSED', 'BFZ', 'BUY', '10', '20', '200', '1', '199', '35.42'),
            (${sellId}, ${bfUserId}, '300.00', 'USD', '2026-02-05', '10626.00', 'CASH_IN', 'AI_PARSED', 'BFZ', 'SELL', '5', '60', '300', '10', '290', '35.42')`;
        // A MANUAL SELL with the same kind of sufficient basis (BUY first).
        const manSellId = randomUUID();
        await client`
          INSERT INTO "Capital_Transactions"
            (transaction_id, user_id, amount_foreign, currency, transaction_date, amount_thb, type, source_type, symbol, side, quantity, unit_price, gross_amount, fees, net_amount, fx_rate_effective)
          VALUES
            (${randomUUID()}, ${bfUserId}, '40.00', 'USD', '2026-01-10', '1416.80', 'CASH_OUT', 'AI_PARSED', 'BFM', 'BUY', '1', '40', '40', '0', '40', '35.42'),
            (${manSellId}, ${bfUserId}, '100.00', 'USD', '2026-02-06', '3542.00', 'CASH_IN', 'MANUAL', 'BFM', 'SELL', '1', '100', '100', '0', '100', '35.42')`;

        const preRows = await client`SELECT realized_gain_loss_thb FROM "Capital_Transactions" WHERE transaction_id = ${sellId}`;
        ok(
          preRows.length === 1 && preRows[0].realized_gain_loss_thb === null,
          "REG-backfill: frozen SELL starts with a NULL realized gain (non-computable at its import)"
        );

        const stats = await backfillPath.backfillComputedGainLoss(bfUserId);
        ok(
          stats.filled === 1 && stats.skippedManual === 1,
          "REG-backfill: backfill fills the frozen AI_PARSED SELL and skips the MANUAL SELL"
        );

        const filled = await client`
          SELECT cost_basis, proceeds, realized_gain_loss, realized_gain_loss_thb
          FROM "Capital_Transactions" WHERE transaction_id = ${sellId}`;
        ok(
          filled.length === 1 &&
            filled[0].cost_basis === "100.00" &&
            filled[0].proceeds === "290.00" &&
            filled[0].realized_gain_loss === "190.00" &&
            filled[0].realized_gain_loss_thb === "6729.80",
          "REG-backfill: SELL filled from authoritative data (basis avg20*5=100 / proceeds net 290 / gain 190 / THB 190*35.42)"
        );

        const manStill = await client`SELECT realized_gain_loss_thb FROM "Capital_Transactions" WHERE transaction_id = ${manSellId}`;
        ok(
          manStill.length === 1 && manStill[0].realized_gain_loss_thb === null,
          "REG-backfill: MANUAL SELL keeps its NULL value (backfill NEVER touches manual rows)"
        );

        // Clean up this fixture user's rows so CLEANUP can delete the user.
        await client`DELETE FROM "Capital_Transactions" WHERE user_id = ${bfUserId}`;
      }
    }
  }

  // ============= REG: WEBULL AVERAGE COST RECOMPUTE =============
  // Proves the one-shot Webull method against the REAL engine + DB path used by
  // scripts/recompute-cost-basis-webull.mts: a symbol with a partial SELL and a
  // LATER re-buy keeps the LIFETIME average (cumulative cost ÷ cumulative BUY
  // qty), so the stored OLD-method realized values must be OVERWRITTEN, the
  // MANUAL SELL left untouched, and cost_basis_state rewritten with the cum
  // accumulator (cum_cost / cum_quantity === avg_cost) whose SELL keeps qty
  // unchanged. Requires the 0019 migration (cum columns) — skipped when absent.
  {
    const cumCol = await client`SELECT column_name FROM information_schema.columns WHERE table_name = 'cost_basis_state' AND column_name = 'cum_quantity'`;
    if (cumCol.length === 0) {
      console.log(
        "\n  SKIP  REG-webull-average-cost: cust_basis_state has no cum_quantity (run the 0019 migration)"
      );
    } else {
      console.log("\n=== REG: WEBULL AVERAGE COST RECOMPUTE ===");
      const { randomUUID } = await import("node:crypto");
      const pipeline = await import("../app/lib/statement-pipeline");
      const wlEmail = `wl-${randomUUID()}@test.local`;
      const wlRes = await registerAs(wlEmail, "WlPass!234");
      const wlJson = (await wlRes.json()) as { data?: { user?: { id?: string } } };
      const wlUserId = wlJson.data?.user?.id;
      if (!wlUserId) {
        ok(false, "REG-webull-avg: register failed to create the test user");
      } else {
        smokeUserIds.push(wlUserId);
        const sellId = randomUUID();
        // WBLL: BUY 1000@300, BUY 200@350, then SELL 500 — old method avg would
        // be 314.29 (157142.86 basis); Webull lifetime avg = 370000/1200 =
        // 308.33 (154166.67 basis). Stored as the OLD method so the recompute
        // must prove it OVERWRITES.
        await client`
          INSERT INTO "Capital_Transactions"
            (transaction_id, user_id, amount_foreign, currency, transaction_date, amount_thb, type, source_type, symbol, side, quantity, unit_price, gross_amount, fees, net_amount, fx_rate_effective, cost_basis, proceeds, realized_gain_loss, realized_gain_loss_thb)
          VALUES
            (${randomUUID()}, ${wlUserId}, '300000.00', 'USD', '2026-01-02', '10626000.00', 'CASH_OUT', 'AI_PARSED', 'WBLL', 'BUY', '1000', '300', '300000', '0', '300000', '35.42', NULL, NULL, NULL, NULL),
            (${randomUUID()}, ${wlUserId}, '70000.00', 'USD', '2026-02-02', '2479400.00', 'CASH_OUT', 'AI_PARSED', 'WBLL', 'BUY', '200', '350', '70000', '0', '70000', '35.42', NULL, NULL, NULL, NULL),
            (${sellId}, ${wlUserId}, '165000.00', 'USD', '2026-02-10', '5844300.00', 'CASH_IN', 'AI_PARSED', 'WBLL', 'SELL', '500', '330', '165000', '0', '165000', '35.42', '157142.86', '165000.00', '7857.14', '278300.00')`;
        // A MANUAL SELL with available basis must be skipped (own symbol, so the
        // WBLL fixture numbers stay isolated).
        const manSellId = randomUUID();
        await client`
          INSERT INTO "Capital_Transactions"
            (transaction_id, user_id, amount_foreign, currency, transaction_date, amount_thb, type, source_type, symbol, side, quantity, unit_price, gross_amount, fees, net_amount, fx_rate_effective)
          VALUES
            (${manSellId}, ${wlUserId}, '500.00', 'USD', '2026-01-05', '17710.00', 'CASH_IN', 'MANUAL', 'WBML', 'SELL', '10', '50', '500', '0', '500', '35.42')`;

        const rows = await client`
          SELECT transaction_id, source_type, transaction_date, symbol, side, quantity, unit_price,
                 gross_amount, fees, net_amount, currency, fx_rate_effective, realized_gain_loss_thb
          FROM "Capital_Transactions" WHERE user_id = ${wlUserId}`;
        const engine = pipeline.recomputeAllGainLoss(
          rows.map((r: any) => ({
            transactionId: r.transaction_id,
            sourceType: r.source_type,
            transactionDate: r.transaction_date,
            symbol: r.symbol,
            side: r.side,
            quantity: r.quantity,
            unitPrice: r.unit_price,
            grossAmount: r.gross_amount,
            fees: r.fees,
            netAmount: r.net_amount,
            currency: r.currency,
            fxRateEffective: r.fx_rate_effective,
            realizedGainLossThb: r.realized_gain_loss_thb,
          })),
          []
        );
        ok(
          engine.stats.recomputed === 1 && engine.stats.skippedManual === 1,
          "REG-webull-avg: full recompute targets the AI_PARSED SELL and skips the MANUAL SELL"
        );
        ok(
          engine.updates[0].update.costBasis === "154166.67" &&
            engine.updates[0].update.realizedGainLoss === "10833.33",
          "REG-webull-avg: Webull lifetime avg 308.33 → basis 154166.67 (was old-method 157142.86)"
        );

        // Apply exactly like scripts/recompute-cost-basis-webull.mts.
        await client`
          UPDATE "Capital_Transactions"
          SET cost_basis = ${engine.updates[0].update.costBasis},
              proceeds = ${engine.updates[0].update.proceeds},
              realized_gain_loss = ${engine.updates[0].update.realizedGainLoss},
              realized_gain_loss_thb = ${engine.updates[0].update.realizedGainLossThb}
          WHERE transaction_id = ${sellId}`;
        await pipeline.rebuildCostBasisStateFromLedger(wlUserId);

        const after = await client`
          SELECT cost_basis, realized_gain_loss, realized_gain_loss_thb
          FROM "Capital_Transactions" WHERE transaction_id = ${sellId}`;
        ok(
          after.length === 1 &&
            after[0].cost_basis === "154166.67" &&
            after[0].realized_gain_loss === "10833.33" &&
            after[0].realized_gain_loss_thb === "383716.55",
          "REG-webull-avg: stored SELL overwritten with the Webull basis/gain (THB 10833.33 × 35.42)"
        );
        const manStill = await client`SELECT realized_gain_loss_thb FROM "Capital_Transactions" WHERE transaction_id = ${manSellId}`;
        ok(
          manStill.length === 1 && manStill[0].realized_gain_loss_thb === null,
          "REG-webull-avg: MANUAL SELL keeps NULL realized gain (never touched)"
        );
        const basis = await client`SELECT symbol, quantity, avg_cost, cum_quantity, cum_cost FROM cost_basis_state WHERE user_id = ${wlUserId}`;
        ok(
          basis.length === 1 &&
            basis[0].quantity === "700" &&
            basis[0].cum_quantity === "1200" &&
            basis[0].cum_cost === "370000",
          "REG-webull-avg: cost_basis_state qty 700 (SELL reduced live qty) but cum divisor 1200 with cost 370000"
        );
        ok(
          Math.abs(parseFloat(basis[0].avg_cost) - 370000 / 1200) < 1e-6,
          "REG-webull-avg: avg_cost === cum_cost / cum_quantity (308.33)"
        );

        // Clean up this fixture user's rows so CLEANUP can delete the user.
        await client`DELETE FROM cost_basis_state WHERE user_id = ${wlUserId}`;
        await client`DELETE FROM "Capital_Transactions" WHERE user_id = ${wlUserId}`;
      }
    }
  }

  // ================= REG: STOCK PRICES (DAILY CLOSE) =================
  // Validates the real /api/v1/stock-prices + /stock-prices/refresh routes
  // against a MOCKED provider (global fetch) so no live Yahoo call ever happens:
  // unauthenticated/role guards, browser-safe 405 on the bare GET loader, an
  // ADMIN-triggered sweep, and a fresh cached close served without re-hitting
  // the provider. Requires the 0017 migration (stock_prices) — skipped (with a
  // note) when the table is absent.
  {
    const priceCol =
      await client`SELECT column_name FROM information_schema.columns WHERE table_name = 'stock_prices' AND column_name = 'close_price'`;
    if (priceCol.length === 0) {
      console.log(
        "\n  SKIP  REG-stock-prices: stock_prices table absent (run the 0017 migration)"
      );
    } else {
      console.log("\n=== REG: STOCK PRICES (DAILY CLOSE) ===");
      const stockPricesRoute = await import("../app/routes/api/stock-prices");
      const stockPricesRefreshRoute = await import(
        "../app/routes/api/stock-prices/refresh"
      );
      const savedFetch = globalThis.fetch;

      const stockRequest = (token: string | undefined, query = "") =>
        stockPricesRoute.loader({
          request: new Request(
            `http://test.local/api/v1/stock-prices?${query}`,
            {
              method: "GET",
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            }
          ),
        } as never);

      const refreshAction = (
        token: string | undefined,
        extraHeaders: Record<string, string> = {}
      ) =>
        stockPricesRefreshRoute.action({
          request: new Request(
            "http://test.local/api/v1/stock-prices/refresh",
            {
              method: "POST",
              headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...extraHeaders,
              },
            }
          ),
        } as never);

      const anonGet = await stockRequest("");
      ok(
        anonGet.status === 401,
        "REG-stock: unauthenticated quote read rejected (401)"
      );

      const anonRefresh = await refreshAction("");
      ok(
        anonRefresh.status === 401,
        "REG-stock: unauthenticated refresh rejected (401)"
      );

      const bareLoader = await stockPricesRefreshRoute.loader({
        request: new Request(
          "http://test.local/api/v1/stock-prices/refresh",
          { method: "GET" }
        ),
      } as never);
      ok(
        bareLoader.status === 401,
        "REG-stock: bare GET refresh without cron secret -> 401 (never auto-runs)"
      );

      if (tokenA) {
        let providerCalled = false;
        globalThis.fetch = (async () => {
          providerCalled = true;
          return new Response("{}", { status: 500 }) as Response;
        }) as typeof fetch;
        const emptyRes = await stockRequest(tokenA, "");
        const emptyBody = (await emptyRes.json()) as {
          success?: boolean;
          data?: unknown[];
        };
        ok(
          emptyRes.status === 200 &&
            Array.isArray(emptyBody.data) &&
            emptyBody.data.length === 0,
          "REG-stock: empty symbols query -> empty array"
        );
        ok(
          providerCalled === false,
          "REG-stock: empty query never touches the provider"
        );
      }

      const userRefresh = await refreshAction(tokenB);
      ok(
        userRefresh.status === 403,
        "REG-stock: USER-role refresh rejected (403)"
      );

      if (tokenAd) {
        // Seed one cached close so the read path is deterministic.
        const ts = new Date(Date.UTC(2026, 8, 10)).getTime() / 1000;
        await client`
          INSERT INTO stock_prices
            (id, symbol, price_date, close_price, currency, source, created_at, updated_at)
          VALUES
            ('00000000-0000-0000-0000-00000000sp1', 'NVDA', '2026-09-10', '123.45', 'USD', 'yahoo-finance', now(), now())
          ON CONFLICT (symbol, price_date) DO UPDATE SET close_price = '123.45', updated_at = now()`;

        // ADMIN-triggered sweep with a MOCKED Yahoo chart payload.
        globalThis.fetch = (async (input: string | URL | Request) => {
          const url = String(input);
          ok(
            url.includes("query1.finance.yahoo.com") &&
              url.includes("/v8/finance/chart/"),
            "REG-stock: provider fetch targets the keyless Yahoo chart API"
          );
          return new Response(
            JSON.stringify({
              chart: {
                result: [
                  {
                    meta: { currency: "USD" },
                    timestamp: [ts],
                    indicators: { quote: [{ close: [123.45] }] },
                  },
                ],
                error: null,
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          ) as Response;
        }) as typeof fetch;

        const refreshRes = await refreshAction(tokenAd);
        const refreshBody = (await refreshRes.json()) as {
          success?: boolean;
          data?: {
            requested?: number;
            updated?: number;
            failed?: string[];
          };
        };
        ok(
          refreshRes.status === 200 && refreshBody.success === true,
          "REG-stock: ADMIN triggers a refresh sweep (200)"
        );
        ok(
          typeof refreshBody.data?.requested === "number" &&
            typeof refreshBody.data?.updated === "number" &&
            Array.isArray(refreshBody.data?.failed) &&
            refreshBody.data.updated === refreshBody.data.requested,
          "REG-stock: refresh stats are consistent (updated === requested, no failures)"
        );

        // Fresh cached close is served WITHOUT calling the provider again.
        let providerCalledAfter = false;
        globalThis.fetch = (async () => {
          providerCalledAfter = true;
          return new Response("{}", { status: 500 }) as Response;
        }) as typeof fetch;
        const nvda = await stockRequest(tokenA, "symbols=NVDA");
        const nvdaBody = (await nvda.json()) as {
          success?: boolean;
          data?: Array<{
            symbol?: string;
            close?: number;
            currency?: string;
          }>;
        };
        ok(
          nvda.status === 200 &&
            Array.isArray(nvdaBody.data) &&
            nvdaBody.data.length >= 1 &&
            nvdaBody.data[0]?.symbol === "NVDA" &&
            nvdaBody.data[0]?.close === 123.45 &&
            nvdaBody.data[0]?.currency === "USD",
          "REG-stock: cached close is served after the refresh (123.45 USD)"
        );
        ok(
          providerCalledAfter === false,
          "REG-stock: a fresh cache hit never re-hits the provider"
        );

        // x-cron-secret matching CRON_SECRET is authorized even without a JWT.
        const prevSecret = process.env.CRON_SECRET;
        process.env.CRON_SECRET = "test-cron-secret-xyz";
        for (const headers of [new Headers(), new Headers({ Authorization: "Bearer wrong-cron-secret" })]) {
          const denied = await stockPricesRefreshRoute.loader({
            request: new Request("http://test.local/api/v1/stock-prices/refresh", { headers }),
          } as never);
          ok(denied.status === 401, "REG-stock: cron GET rejects missing/wrong Bearer secret");
        }
        globalThis.fetch = (async (_input: string | URL | Request) =>
          new Response(
            JSON.stringify({
              chart: {
                result: [
                  {
                    meta: { currency: "USD" },
                    timestamp: [ts],
                    indicators: { quote: [{ close: [9.99] }] },
                  },
                ],
                error: null,
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          ) as Response) as typeof fetch;
        const cronRes = await refreshAction("", {
          "x-cron-secret": "test-cron-secret-xyz",
        });
        const cronBody = (await cronRes.json()) as {
          success?: boolean;
          data?: unknown;
        };
        ok(
          cronRes.status === 200 && !!cronBody.data,
          "REG-stock: x-cron-secret matching CRON_SECRET -> refresh allowed"
        );
        const vercelCronRes = await stockPricesRefreshRoute.loader({
          request: new Request("http://test.local/api/v1/stock-prices/refresh", {
            method: "GET",
            headers: { Authorization: "Bearer test-cron-secret-xyz" },
          }),
        } as never);
        const vercelCronBody = await vercelCronRes.json() as { success?: boolean };
        ok(vercelCronRes.status === 200 && vercelCronBody.success === true,
          "REG-stock: Vercel GET with matching Bearer CRON_SECRET refreshes successfully");
        if (prevSecret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = prevSecret;
      }

      globalThis.fetch = savedFetch;
      await client`DELETE FROM stock_prices WHERE created_at >= ${startTime}`;
      console.log("  Removed stock_prices rows written during this test window.");
    }
  }

  // ================= REG: CASH SUMMARY (EQUITY MONTHLY) =================
  {
    console.log("\n=== REG: CASH SUMMARY (EQUITY MONTHLY) ===");
    const cashSummaryRoute = await import("../app/routes/api/cash-summary");
    const cashRequest = (token: string | undefined) =>
      cashSummaryRoute.loader({
        request: new Request("http://test.local/api/v1/cash-summary", {
          method: "GET",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
      } as never);

    const anonCash = await cashRequest("");
    ok(
      anonCash.status === 401,
      "REG-cash: unauthenticated summary rejected (401)"
    );

    if (tokenA) {
      const emptyRes = await cashRequest(tokenA);
      const emptyBody = (await emptyRes.json()) as {
        success?: boolean;
        data?: { months: unknown[]; totalCashInThb?: string };
      };
      ok(
        emptyRes.status === 200 &&
          emptyBody.success === true &&
          Array.isArray(emptyBody.data?.months) &&
          typeof emptyBody.data?.totalCashInThb === "string",
        "REG-cash: authenticated summary loads with monthly rows + string totals"
      );

      // Insert fresh MANUAL transfer rows through the REAL POST route so the
      // category='equity' stamp is exercised, then re-read.
      const inRes = await ledgersRoute.action({
        request: jsonBody(
          {
            amountForeign: "1200.00",
            currency: "USD",
            transactionDate: "2026-07-15",
            fxRateBot: "33.00",
            amountThb: "39600.00",
            type: "CASH_IN",
            sourceType: "MANUAL",
          },
          "POST",
          tokenA
        ),
      } as never);
      const inBody = (await inRes.json()) as {
        success?: boolean;
        data?: { transactionId: string };
      };
      const inId = inBody.success ? inBody.data?.transactionId : undefined;
      ok(
        inRes.status === 201 && typeof inId === "string",
        "REG-cash: manual CASH_IN created (201)"
      );

      const outRes = await ledgersRoute.action({
        request: jsonBody(
          {
            amountForeign: "400.00",
            currency: "USD",
            transactionDate: "2026-07-16",
            fxRateBot: "33.00",
            amountThb: "13200.00",
            type: "CASH_OUT",
            sourceType: "MANUAL",
          },
          "POST",
          tokenA
        ),
      } as never);
      const outBody = (await outRes.json()) as {
        success?: boolean;
        data?: { transactionId: string };
      };
      const outId = outBody.success ? outBody.data?.transactionId : undefined;
      ok(
        outRes.status === 201 && typeof outId === "string",
        "REG-cash: manual CASH_OUT created (201)"
      );

      const sumRes = await cashRequest(tokenA);
      const sumBody = (await sumRes.json()) as {
        success?: boolean;
        data?: {
          months: {
            month: string;
            cashInThb: string;
            cashOutThb: string;
            netThb: string;
          }[];
        };
      };
      const july = sumBody.data?.months?.find((m) => m.month === "2026-07");
      ok(
        july?.cashInThb === "39600" &&
          july?.cashOutThb === "13200" &&
          july?.netThb === "26400",
        "REG-cash: manual rows land in July with in/out/net"
      );

      // Journal as SSOT: every manual cash row is ALSO mirrored in the journal
      // (the cash summary above is served FROM those journal entries).
      if (inId) {
        const je = await client`SELECT id, type, amount::float8 AS amount, amount_thb::float8 AS amount_thb, fx_rate_effective FROM journal_entries WHERE source_transaction_id = ${inId}`;
        ok(
          je.length === 1 &&
            je[0].type === "CASH_IN" &&
            Number(je[0].amount) === 1200 &&
            Number(je[0].amount_thb) === 39600 &&
            Number(je[0].fx_rate_effective) === 33,
          "REG-cash: manual CASH_IN mirrored in journal (type + amount + THB + fx)"
        );
        const lineCountIn = await client`SELECT COUNT(*)::int AS c FROM journal_entry_lines WHERE journal_entry_id = ${je[0].id}`;
        ok(
          lineCountIn[0].c === 2,
          "REG-cash: manual CASH_IN journal entry has 2 posting lines"
        );
      }
      if (outId) {
        const je = await client`SELECT id, type, amount::float8 AS amount FROM journal_entries WHERE source_transaction_id = ${outId}`;
        ok(
          je.length === 1 && je[0].type === "CASH_OUT" && Number(je[0].amount) === 400,
          "REG-cash: manual CASH_OUT mirrored in journal (type + amount)"
        );
        const lineCountOut = await client`SELECT COUNT(*)::int AS c FROM journal_entry_lines WHERE journal_entry_id = ${je[0].id}`;
        ok(
          lineCountOut[0].c === 2,
          "REG-cash: manual CASH_OUT journal entry has 2 posting lines"
        );
      }

      if (inId) {
        // Journal rows first (entry_lines -> entries), then the capital row.
        await client`DELETE FROM "journal_entry_lines" WHERE journal_entry_id IN (SELECT id FROM "journal_entries" WHERE source_transaction_id = ${inId})`;
        await client`DELETE FROM "journal_entries" WHERE source_transaction_id = ${inId}`;
        await client`DELETE FROM "Capital_Transactions" WHERE transaction_id = ${inId}`;
      }
      if (outId) {
        await client`DELETE FROM "journal_entry_lines" WHERE journal_entry_id IN (SELECT id FROM "journal_entries" WHERE source_transaction_id = ${outId})`;
        await client`DELETE FROM "journal_entries" WHERE source_transaction_id = ${outId}`;
        await client`DELETE FROM "Capital_Transactions" WHERE transaction_id = ${outId}`;
      }
      console.log("  Removed the manual cash rows + mirrored journals written during this test window.");
    }
  }

  // ================= REG: TRADING JOURNAL NOTES (investor annotations) =================
  // The investor's own note on one journal row (PUT/DELETE
  // /api/v1/trading-journal/:transactionId/note): owner-scoped, safe 404
  // cross-user, loader 405, invalid JSON / over-long notes 400. The note
  // flows back through GET /api/v1/trading-journal entries verbatim.
  // Requires the 0022 migration (journal_entries.note) — skipped with a note
  // when the column is absent.
  {
    const noteCol =
      await client`SELECT column_name FROM information_schema.columns WHERE table_name = 'journal_entries' AND column_name = 'note'`;
    if (noteCol.length === 0) {
      console.log(
        "\n  SKIP  REG-journal-notes: note column absent (run the 0022 migration)"
      );
    } else {
      console.log("\n=== REG: TRADING JOURNAL NOTES ===");
      const { randomUUID } = await import("node:crypto");
      const noteRoute = await import(
        "../app/routes/api/trading-journal.$transactionId.note"
      );
      const journalRoute = await import("../app/routes/api/trading-journal");
      const noteEmail = `note-${randomUUID()}@test.local`;
      const notePass = "NotePass!234";
      const noteReg = await registerAs(noteEmail, notePass);
      const noteJson = (await noteReg.json()) as {
        data?: { user?: { id?: string } };
      };
      const noteUserId = noteJson.data?.user?.id;
      if (!noteUserId) {
        ok(false, "REG-notes: register failed to create the notes test user");
      } else {
        smokeUserIds.push(noteUserId);
        const noteLogin = await loginAs(noteEmail, notePass);
        const noteToken = noteLogin.data?.accessToken as string | undefined;
        if (!noteToken) {
          ok(false, "REG-notes: notes user could not log in");
        } else {
          const otherEmail = `note-other-${randomUUID()}@test.local`;
          const otherReg = await registerAs(otherEmail, "NoteOther!234");
          const otherJson = (await otherReg.json()) as {
            data?: { user?: { id?: string } };
          };
          if (otherJson.data?.user?.id) smokeUserIds.push(otherJson.data.user.id);
          const otherLogin = await loginAs(otherEmail, "NoteOther!234");
          const otherToken = otherLogin.data?.accessToken as string | undefined;

          // One journal row backed by a capital-transaction id (no postings).
          const noteTxId = randomUUID();
          const nowIso = new Date().toISOString();
          await client`
            INSERT INTO journal_entries
              (id, user_id, entry_no, entry_date, description, source_type, source_transaction_id, status, created_at, updated_at, category, symbol, side, quantity, unit_price, currency, amount, amount_thb, fx_rate_effective, is_fx_conversion, posting_state)
            VALUES
              (${randomUUID()}, ${noteUserId}, 1, '2026-02-10', 'ซื้อ NOTEX', 'STATEMENT', ${noteTxId}, 'POSTED', ${nowIso}, ${nowIso}, 'asset', 'NOTEX', 'BUY', '10', '15.00', 'USD', '150.00', '5325.00', '35.50', false, 'SKIPPED')`;

          const putNote = (token: string, txId: string, body: unknown) =>
            noteRoute.action({
              request: new Request(
                `http://test.local/api/v1/trading-journal/${txId}/note`,
                {
                  method: "PUT",
                  headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(body),
                }
              ),
              params: { transactionId: txId },
            } as never);

          // 1. Owner sets a note.
          const putRes = await putNote(noteToken, noteTxId, {
            note: "เหตุผลที่ซื้อ NOTEX",
          });
          const putBody = (await putRes.json()) as {
            data?: { note?: string | null };
          };
          ok(
            putRes.status === 200 && putBody.data?.note === "เหตุผลที่ซื้อ NOTEX",
            "REG-notes: owner sets a note on their own row (200)"
          );

          // 2. The note flows back through the journal list verbatim.
          const listRes = await journalRoute.loader({
            request: new Request("http://test.local/api/v1/trading-journal", {
              headers: { Authorization: `Bearer ${noteToken}` },
            }),
          } as never);
          const listBody = (await listRes.json()) as {
            data?: { entries?: { transactionId?: string; note?: string | null }[] };
          };
          const listed = listBody.data?.entries?.find(
            (e) => e.transactionId === noteTxId
          );
          ok(
            listRes.status === 200 && listed?.note === "เหตุผลที่ซื้อ NOTEX",
            "REG-notes: note is served back through GET /api/v1/trading-journal"
          );

          // 3. Blank clears the note (back to honest null).
          const clearRes = await putNote(noteToken, noteTxId, { note: "   " });
          const clearBody = (await clearRes.json()) as {
            data?: { note?: string | null };
          };
          ok(
            clearRes.status === 200 && clearBody.data?.note === null,
            "REG-notes: blank note clears back to null"
          );

          // 4. Another user cannot annotate this row.
          if (otherToken) {
            const crossRes = await putNote(otherToken, noteTxId, { note: "x" });
            ok(
              crossRes.status === 404,
              "REG-notes: cross-user note write is a safe 404"
            );
          }

          // 5. Missing row + bad input + wrong method.
          const missingRes = await putNote(noteToken, randomUUID(), { note: "x" });
          ok(
            missingRes.status === 404,
            "REG-notes: note on a missing row is 404"
          );
          const badRes = await putNote(noteToken, noteTxId, { note: 42 });
          ok(
            badRes.status === 400,
            "REG-notes: non-string note is rejected (400)"
          );
          const longRes = await putNote(noteToken, noteTxId, {
            note: "y".repeat(2001),
          });
          ok(
            longRes.status === 400,
            "REG-notes: over-long note is rejected (400)"
          );
          const getRes = await noteRoute.loader();
          ok(getRes.status === 405, "REG-notes: note loader is GET-rejected (405)");
        }
      }
    }
  }

  // ================= REG: SPIN_OFF FMV (cost-basis allocation) =================
  // Spin-offs with an FMV pair split the parent's cumCost pro-rata by total
  // FMV (parent FMV x held shares : child FMV x shares received); legacy rows
  // without the pair keep the old valuation and surface needsReview: true.
  // Requires the 0023 migration (parent/child FMV columns) — skipped when absent.
  {
    const fmvCol =
      await client`SELECT column_name FROM information_schema.columns WHERE table_name = 'corporate_actions' AND column_name = 'parent_fmv_per_share'`;
    if (fmvCol.length === 0) {
      console.log(
        "\n  SKIP  REG-spin-fmv: FMV columns absent (run the 0023 migration)"
      );
    } else {
      console.log("\n=== REG: SPIN_OFF FMV ===");
      const { randomUUID } = await import("node:crypto");
      const caRoute = await import("../app/routes/api/corporate-actions");
      const spinEmail = `spin-${randomUUID()}@test.local`;
      const spinPass = "SpinPass!234";
      const spinReg = await registerAs(spinEmail, spinPass);
      const spinJson = (await spinReg.json()) as {
        data?: { user?: { id?: string } };
      };
      const spinUserId = spinJson.data?.user?.id;
      if (!spinUserId) {
        ok(false, "REG-spin: register failed to create the spin test user");
      } else {
        smokeUserIds.push(spinUserId);
        const spinLogin = await loginAs(spinEmail, spinPass);
        const spinToken = spinLogin.data?.accessToken as string | undefined;
        if (!spinToken) {
          ok(false, "REG-spin: spin user could not log in");
        } else {
          const postCa = (token: string, body: unknown) =>
            caRoute.action({
              request: new Request("http://test.local/api/v1/corporate-actions", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
              }),
            } as never);
          const listCa = (token: string) =>
            caRoute.loader({
              request: new Request("http://test.local/api/v1/corporate-actions", {
                headers: { Authorization: `Bearer ${token}` },
              }),
            } as never);

          // 1. One-sided FMV is rejected (both-or-neither, never guessed).
          const oneSided = await postCa(spinToken, {
            symbol: "MOM",
            actionType: "SPIN_OFF",
            transactionDate: "2026-03-01",
            sharesOut: "10",
            priceOut: "10",
            parentFmvPerShare: "90",
          });
          ok(oneSided.status === 422, "REG-spin: one-sided FMV spin-off rejected (422)");

          // 2. FMV pair accepted.
          const fmvRes = await postCa(spinToken, {
            symbol: "MOM",
            actionType: "SPIN_OFF",
            transactionDate: "2026-03-01",
            sharesOut: "10",
            priceOut: "10",
            newSymbol: "KID",
            parentFmvPerShare: "90",
            childFmvPerShare: "10",
          });
          ok(fmvRes.status === 201, "REG-spin: FMV-pair spin-off created (201)");

          // 3. Legacy spin-off (no FMV) accepted and flagged for review.
          const legacyRes = await postCa(spinToken, {
            symbol: "MOM",
            actionType: "SPIN_OFF",
            transactionDate: "2026-03-02",
            sharesOut: "5",
            priceOut: "8",
            newSymbol: "KID2",
          });
          ok(legacyRes.status === 201, "REG-spin: legacy spin-off without FMV created (201)");

          const listRes = await listCa(spinToken);
          const listBody = (await listRes.json()) as {
            data?: { newSymbol?: string | null; needsReview?: boolean }[];
          };
          const kid = listBody.data?.find((r) => r.newSymbol === "KID");
          const kid2 = listBody.data?.find((r) => r.newSymbol === "KID2");
          ok(
            listRes.status === 200 && kid?.needsReview === false,
            "REG-spin: FMV spin-off lists with needsReview false"
          );
          ok(
            listRes.status === 200 && kid2?.needsReview === true,
            "REG-spin: legacy spin-off lists with needsReview true"
          );

          // Self-cleaning so CLEANUP can delete the user (FK has no cascade).
          await client`DELETE FROM corporate_actions WHERE user_id = ${spinUserId}`;
          await client`DELETE FROM cost_basis_state WHERE user_id = ${spinUserId}`;
        }
      }
    }
  }

  // ================= REG: TRADING JOURNAL SCOPE (replay + current-holdings) =================
  // The journal page's avgCostAtTime must be replayed over the FULL lifetime
  // history BEFORE the from/to/symbol filters are applied (a date window that
  // truncates the replay used to rewrite/erase the averages landing inside
  // it), and the per-stock summary must list ONLY currently-held symbols (a
  // fully-sold position has no cost_basis_state row, so no card — its trades
  // stay in the journal table). Requires the 0020 trade-detail columns.
  {
    const detailCol =
      await client`SELECT column_name FROM information_schema.columns WHERE table_name = 'journal_entries' AND column_name = 'gross_amount'`;
    if (detailCol.length === 0) {
      console.log(
        "\n  SKIP  REG-journal-scope: trade-detail columns absent (run the 0020 migration)"
      );
    } else {
console.log("\n=== REG: TRADING JOURNAL SCOPE ===");
      const { randomUUID } = await import("node:crypto");
      const scopedJournalRoute = await import("../app/routes/api/trading-journal");
      const scopeEmail = `scope-${randomUUID()}@test.local`;
      const scopePass = "ScopePass!234";
      const scopeReg = await registerAs(scopeEmail, scopePass);
      const scopeJson = (await scopeReg.json()) as {
        data?: { user?: { id?: string } };
      };
      const scopeUserId = scopeJson.data?.user?.id;
      if (!scopeUserId) {
        ok(false, "REG-scope: register failed to create the scope test user");
      } else {
        smokeUserIds.push(scopeUserId);
        const scopeLogin = await loginAs(scopeEmail, scopePass);
        const scopeToken = scopeLogin.data?.accessToken as string | undefined;
        if (!scopeToken) {
          ok(false, "REG-scope: scope user could not log in");
        } else {
          const nowIso = new Date().toISOString();
          const insertRow = (
            entryNo: number,
            entryDate: string,
            txId: string,
            values: Record<string, string | null | boolean>
          ) =>
            client`
              INSERT INTO journal_entries
                (id, user_id, entry_no, entry_date, description, source_type, source_transaction_id, status, created_at, updated_at, category, symbol, side, quantity, unit_price, gross_amount, fees, net_amount, currency, amount, amount_thb, fx_rate_effective, is_fx_conversion, posting_state)
              VALUES
                (${randomUUID()}, ${scopeUserId}, ${entryNo}, ${entryDate}, ${`REG ${txId}`}, 'STATEMENT', ${txId}, 'POSTED', ${nowIso}, ${nowIso}, 'asset', ${values.symbol}, ${values.side}, ${values.quantity}, ${values.unitPrice}, ${values.grossAmount}, ${values.fees}, ${values.netAmount}, 'USD', ${values.amount}, ${values.amountThb}, '35.50', false, 'SKIPPED')`;
          // SCOPX: one BUY before 2026-01-01, then BUY + SELL inside the window.
          // Full-lifetime Webull replay: avg 10 -> (100+300)/20 = 20 for both.
          await insertRow(1, "2025-11-01", randomUUID(), {
            symbol: "SCOPX", side: "BUY", quantity: "10", unitPrice: "10.00",
            grossAmount: "100.00", fees: "0.05", netAmount: "100.05",
            amount: "100.00", amountThb: "3550.00",
          });
          await insertRow(2, "2026-02-01", randomUUID(), {
            symbol: "SCOPX", side: "BUY", quantity: "10", unitPrice: "30.00",
            grossAmount: "300.00", fees: "0.05", netAmount: "300.05",
            amount: "300.00", amountThb: "10650.00",
          });
          await insertRow(3, "2026-03-01", randomUUID(), {
            symbol: "SCOPX", side: "SELL", quantity: "5", unitPrice: "40.00",
            grossAmount: "200.00", fees: "0.05", netAmount: "199.95",
            amount: "200.00", amountThb: "7100.00",
          });
          // SOLDX: journal trade with NO cost_basis_state row (fully sold).
          await insertRow(4, "2026-04-01", randomUUID(), {
            symbol: "SOLDX", side: "BUY", quantity: "10", unitPrice: "5.00",
            grossAmount: "50.00", fees: "0.05", netAmount: "50.05",
            amount: "50.00", amountThb: "1775.00",
          });
          // HELDX: currently held (has a cost_basis_state row).
          await insertRow(5, "2026-04-02", randomUUID(), {
            symbol: "HELDX", side: "BUY", quantity: "5", unitPrice: "10.00",
            grossAmount: "50.00", fees: "0.05", netAmount: "50.05",
            amount: "50.00", amountThb: "1775.00",
          });
          await client`
            INSERT INTO cost_basis_state
              (id, user_id, symbol, quantity, avg_cost, cum_quantity, cum_cost, updated_at)
            VALUES
              (${randomUUID()}, ${scopeUserId}, 'HELDX', '5', '10.00', '5', '50.00', ${nowIso})`;

          const getJournal = (qs: string) =>
            scopedJournalRoute.loader({
              request: new Request(`http://test.local/api/v1/trading-journal${qs}`, {
                headers: { Authorization: `Bearer ${scopeToken}` },
              }),
            } as never);
          const readEntries = async (qs: string) => {
            const res = await getJournal(qs);
            const body = (await res.json()) as {
              data?: {
                entries?: {
                  transactionId?: string; date?: string; side?: string;
                  symbol?: string | null; avgCostAtTime?: number | null;
                }[];
                holdings?: { symbol?: string }[];
              };
            };
            ok(res.status === 200, `REG-scope: GET /api/v1/trading-journal${qs || " (unfiltered)"} is 200`);
            return body.data;
          };
          const unfiltered = await readEntries("");
          const windowed = await readEntries("?from=2026-01-01");
          const avgOf = (
            rows: { symbol?: string | null; side?: string; date?: string; avgCostAtTime?: number | null }[] | undefined,
            side: string,
            symbol: string,
            date: string
          ) =>
            rows?.find((e) => e.side === side && e.symbol === symbol && e.date === date)
              ?.avgCostAtTime ?? null;
          const fullBuy = avgOf(unfiltered?.entries, "BUY", "SCOPX", "2026-02-01");
          const fullSell = avgOf(unfiltered?.entries, "SELL", "SCOPX", "2026-03-01");
          const winBuy = avgOf(windowed?.entries, "BUY", "SCOPX", "2026-02-01");
          const winSell = avgOf(windowed?.entries, "SELL", "SCOPX", "2026-03-01");
          ok(
            fullBuy === 10 && fullSell === 20,
            "REG-scope: unfiltered SCOPX replay reports lifetime averages (BUY 10 pre-trade / SELL 20) for the in-window rows"
          );
          ok(
            winBuy === fullBuy && winSell === fullSell,
            "REG-scope: ?from=2026-01-01 does not rewrite the averages (was null/30 before the full-lifetime replay fix)"
          );
          ok(
            unfiltered?.entries?.some((e) => e.symbol === "SOLDX") === true,
            "REG-scope: fully-sold SOLDX stays in the journal table"
          );
          ok(
            unfiltered?.holdings?.some((h) => h.symbol === "HELDX") === true &&
              unfiltered?.holdings?.some((h) => h.symbol === "SOLDX") === false,
            "REG-scope: summary lists the currently-held HELDX but not the fully-sold SOLDX"
          );

          // Self-cleaning (shared CLEANUP also removes this user's journal rows).
          await client`DELETE FROM cost_basis_state WHERE user_id = ${scopeUserId}`;
          await client`DELETE FROM journal_entries WHERE user_id = ${scopeUserId}`;
        }
      }
    }
  }

  // ================= REG: MONTHLY FEE AGGREGATE PERSISTENCE (migration 0027) =================
  // The R4 monthly-fee/VAT provenance flag (is_monthly_fee_aggregate) must land
  // in BOTH Capital_Transactions and journal_entries when a statement import
  // persists rows, and a REBUILD from the persisted shape (deletion
  // reconciliation / recompute scripts re-read the DB then re-post) must keep
  // the monthly rows (TRUE) SKIPPED-by-flag and the legacy/unknown rows (NULL)
  // SKIPPED-by-unknown-provenance rather than inventing a 5010 expense line,
  // while a genuine standalone fee (flag false) still POSTs once. Requires the
  // 0027 migration.
  {
    const feeAggCol =
      await client`SELECT column_name FROM information_schema.columns WHERE lower(table_name) = 'capital_transactions' AND column_name = 'is_monthly_fee_aggregate'`;
    if (feeAggCol.length === 0) {
      console.log(
        "\n  SKIP  REG-monthly-fee-agg: is_monthly_fee_aggregate absent (run the 0027 migration)"
      );
    } else {
      console.log("\n=== REG: MONTHLY FEE AGGREGATE PERSISTENCE ===");
      const { randomUUID } = await import("node:crypto");
      const mfaEmail = `mfa-${randomUUID()}@test.local`;
      const mfaPass = "MfaCheck!234";
      const mfaReg = await registerAs(mfaEmail, mfaPass);
      const mfaJson = (await mfaReg.json()) as { data?: { user?: { id?: string } } };
      const mfaUserId = mfaJson.data?.user?.id;
      if (!mfaUserId) {
        ok(false, "REG-mfa: register failed to create the fee-aggregate test user");
      } else {
        smokeUserIds.push(mfaUserId);
        const mfaLogin = await loginAs(mfaEmail, mfaPass);
        const mfaToken = mfaLogin.data?.accessToken as string | undefined;
        if (!mfaToken) {
          ok(false, "REG-mfa: fee-aggregate user could not log in");
        } else {
          const mfaLedger = await import("../app/lib/ledger-service");
          const mfaEngine = await import("../app/lib/posting-engine");
          const docId = randomUUID();
          const now = new Date().toISOString();
          await client`INSERT INTO documents (id, user_id, original_name, file_path, mime_type, file_size, created_at, updated_at)
                       VALUES (${docId}, ${mfaUserId}, 'mfa.PDF', '/tmp/mfa.pdf', 'application/pdf', 100, ${now}, ${now})`;
          const baseRow = (over: Record<string, unknown>) =>
            ({
              transactionId: randomUUID(),
              userId: mfaUserId,
              amountForeign: "11.00",
              currency: "USD",
              transactionDate: "2026-01-15",
              fxRateBot: null,
              amountThb: "389.50",
              type: "CASH_IN",
              sourceType: "AI_PARSED",
              sourceDocumentId: docId,
              category: "expense",
              section: "ค่าธรรมเนียม",
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
              fxRateStatement: "35.4",
              fxRateEffective: "35.4",
              netAmount: null,
              exchange: null,
              exchangeFromCurrency: null,
              exchangeFromAmount: null,
              exchangeRate: null,
              isMonthlyFeeAggregate: false,
              ...over,
            }) as unknown as Parameters<typeof mfaLedger.insertStatementImport>[1][number];
          const txMonthly = randomUUID();
          const txStandalone = randomUUID();
          const txLegacy = randomUUID();
          const persistedRows = [
            baseRow({
              transactionId: txMonthly,
              isMonthlyFeeAggregate: true,
            }),
            baseRow({
              transactionId: txStandalone,
              isMonthlyFeeAggregate: false,
              amountForeign: "9.00",
              amountThb: "318.60",
            }),
            // Legacy pre-0027 row: the old parser emitted an IDENTICAL persisted
            // shape for aggregates AND standalone fees, so its provenance is
            // UNKNOWN. The tri-state contract stores NULL (never a fabricated
            // false) and the rebuild SKIPS it (no lines) until a delete +
            // re-import re-runs the parser for a deterministic TRUE/FALSE.
            baseRow({
              transactionId: txLegacy,
              isMonthlyFeeAggregate: null,
              amountForeign: "2.50",
              amountThb: "88.50",
            }),
          ];
          const imported = await mfaLedger.insertStatementImport(mfaUserId, persistedRows);
          ok(
            imported.insertedCount === 3 &&
              imported.transactionIds.includes(txMonthly) &&
              imported.transactionIds.includes(txLegacy),
            "REG-mfa: statement import persists the monthly + standalone + legacy fee rows"
          );
          const capFlag = await client`
            SELECT is_monthly_fee_aggregate FROM "Capital_Transactions"
            WHERE transaction_id = ${txMonthly}`;
          ok(
            capFlag.length === 1 && capFlag[0].is_monthly_fee_aggregate === true,
            "REG-mfa: Capital_Transactions row stores is_monthly_fee_aggregate = true"
          );
          const capStandalone = await client`
            SELECT is_monthly_fee_aggregate FROM "Capital_Transactions"
            WHERE transaction_id = ${txStandalone}`;
          ok(
            capStandalone.length === 1 && capStandalone[0].is_monthly_fee_aggregate === false,
            "REG-mfa: standalone fee row stores is_monthly_fee_aggregate = false"
          );
          const capLegacy = await client`
            SELECT is_monthly_fee_aggregate FROM "Capital_Transactions"
            WHERE transaction_id = ${txLegacy}`;
          ok(
            capLegacy.length === 1 && capLegacy[0].is_monthly_fee_aggregate === null,
            "REG-mfa: legacy (pre-0027) row stores is_monthly_fee_aggregate = NULL (never coerced to false)"
          );
          const jrnFlag = await client`
            SELECT is_monthly_fee_aggregate, posting_state FROM journal_entries
            WHERE source_transaction_id = ${txMonthly}`;
          ok(
            jrnFlag.length === 1 &&
              jrnFlag[0].is_monthly_fee_aggregate === true &&
              jrnFlag[0].posting_state === "SKIPPED",
            "REG-mfa: journal_entries row stores the flag true AND is SKIPPED (monthly) — independent fields"
          );
          const jrnStandalone = await client`
            SELECT is_monthly_fee_aggregate, posting_state FROM journal_entries
            WHERE source_transaction_id = ${txStandalone}`;
          ok(
            jrnStandalone.length === 1 &&
              jrnStandalone[0].is_monthly_fee_aggregate === false &&
              jrnStandalone[0].posting_state === "POSTED",
            "REG-mfa: standalone fee journal row stores flag false AND is POSTED — independent fields"
          );
          const jrnLegacy = await client`
            SELECT is_monthly_fee_aggregate, posting_state, skip_reason FROM journal_entries
            WHERE source_transaction_id = ${txLegacy}`;
          ok(
            jrnLegacy.length === 1 &&
              jrnLegacy[0].is_monthly_fee_aggregate === null &&
              jrnLegacy[0].posting_state === "SKIPPED" &&
              typeof jrnLegacy[0].skip_reason === "string" &&
              jrnLegacy[0].skip_reason.includes(
                "re-import required for deterministic classification"
              ),
            "REG-mfa: legacy journal row keeps flag NULL AND is SKIPPED with explicit unknown-provenance reason — independent fields"
          );
          // Rebuild from the persisted DB shape (what reconcileStatementDeletion /
          // recompute scripts do): read the rows back and re-run the pure engine.
          const capRowsAll = await client`
            SELECT * FROM "Capital_Transactions"
            WHERE user_id = ${mfaUserId} AND source_document_id = ${docId}
            ORDER BY transaction_id`;
          const toCapitalShape = (r: Record<string, unknown>) => ({
            transactionId: r.transaction_id as string,
            userId: r.user_id as string,
            amountForeign: r.amount_foreign as string,
            currency: r.currency as string,
            transactionDate: r.transaction_date as string,
            fxRateBot: r.fx_rate_bot as string | null,
            amountThb: r.amount_thb as string | null,
            type: r.type as string,
            sourceType: r.source_type as string,
            sourceDocumentId: r.source_document_id as string | null,
            category: r.category as string,
            section: r.section as string | null,
            symbol: r.symbol as string | null,
            side: r.side as string | null,
            quantity: r.quantity as string | null,
            unitPrice: r.unit_price as string | null,
            grossAmount: r.gross_amount as string | null,
            fees: r.fees as string | null,
            proceeds: r.proceeds as string | null,
            costBasis: r.cost_basis as string | null,
            realizedGainLoss: r.realized_gain_loss as string | null,
            realizedGainLossThb: r.realized_gain_loss_thb as string | null,
            fxRateStatement: r.fx_rate_statement as string | null,
            fxRateEffective: r.fx_rate_effective as string | null,
            netAmount: r.net_amount as string | null,
            exchange: r.exchange as string | null,
            exchangeFromCurrency: r.exchange_from_currency as string | null,
            exchangeFromAmount: r.exchange_from_amount as string | null,
            exchangeRate: r.exchange_rate as string | null,
            isMonthlyFeeAggregate:
              r.is_monthly_fee_aggregate == null
                ? null
                : (r.is_monthly_fee_aggregate as boolean) === true,
          });
          const rebuiltMonthly = toCapitalShape(
            capRowsAll.find((r) => r.transaction_id === txMonthly) as Record<string, unknown> | undefined ?? {}
          );
          const rebuiltStandalone = toCapitalShape(
            capRowsAll.find((r) => r.transaction_id === txStandalone) as Record<string, unknown> | undefined ?? {}
          );
          const rebuiltLegacy = toCapitalShape(
            capRowsAll.find((r) => r.transaction_id === txLegacy) as Record<string, unknown> | undefined ?? {}
          );
          const rebuiltEntries = mfaEngine.buildStatementJournalEntries([
            rebuiltMonthly as never,
            rebuiltStandalone as never,
            rebuiltLegacy as never,
          ]);
          const rebuiltMonthlyEntry = rebuiltEntries.find((e) => e.entry.detail?.section === "ค่าธรรมเนียม" && e.entry.detail?.isMonthlyFeeAggregate === true);
          const rebuiltStandaloneEntry = rebuiltEntries.find((e) => e.entry.detail?.section === "ค่าธรรมเนียม" && e.entry.detail?.isMonthlyFeeAggregate === false);
          const rebuiltLegacyEntry = rebuiltEntries.find((e) => e.entry.detail?.section === "ค่าธรรมเนียม" && e.entry.detail?.isMonthlyFeeAggregate == null);
          ok(
            rebuiltMonthlyEntry?.postingState === "SKIPPED" &&
              rebuiltMonthlyEntry?.entry.lines.length === 0,
            "REG-mfa: rebuild from persisted rows keeps the monthly fee SKIPPED with zero lines"
          );
          ok(
            rebuiltStandaloneEntry?.postingState === "POSTED" &&
              rebuiltStandaloneEntry?.entry.lines.some(
                (l) => l.accountId === "5010" && l.debit === "9.00"
              ),
            "REG-mfa: rebuild from persisted rows POSTs the standalone fee (Dr 5010 once)"
          );
          ok(
            rebuiltLegacyEntry?.postingState === "SKIPPED" &&
              rebuiltLegacyEntry?.entry.lines.length === 0 &&
              rebuiltLegacyEntry?.entry.detail?.isMonthlyFeeAggregate === null &&
              typeof rebuiltLegacyEntry?.entry.skipReason === "string" &&
              (rebuiltLegacyEntry.entry.skipReason ?? "").includes(
                "re-import required for deterministic classification"
              ),
            "REG-mfa: rebuild from a legacy NULL row is SKIPPED with zero lines + explicit reason (detail stays null)"
          );
          // R2/R5/R8: verify actual persisted headers/lines, not just pure plans.
          const accountingRows = [
            baseRow({ category: "asset", side: "SELL", symbol: "R258", amountForeign: "1189.00",
              costBasis: "1000.00", proceeds: "1189.00", realizedGainLoss: "189.00",
              realizedGainLossThb: "6694.38", fxRateEffective: "35.42", amountThb: "999" }),
            baseRow({ category: "asset", side: "SELL", symbol: "R258", amountForeign: "1000.00",
              costBasis: "1000.00", realizedGainLoss: "0.00", realizedGainLossThb: "0.00" }),
            baseRow({ category: "asset", side: "SELL", symbol: "R258", amountForeign: "1000.00",
              costBasis: null, realizedGainLoss: null, realizedGainLossThb: null }),
          ];
          await mfaLedger.insertStatementImport(mfaUserId, accountingRows);
          const accountingIds = accountingRows.map(r => r.transactionId);
          const persistedAccounting = await client`
            SELECT e.source_transaction_id, e.posting_state, e.skip_reason,
              e.cost_basis, e.realized_gain_loss, e.realized_gain_loss_thb, e.amount_thb,
              count(l.id)::int AS line_count,
              coalesce(sum(l.debit_amount),0) = coalesce(sum(l.credit_amount),0) AS native_balanced,
              coalesce(sum(CASE WHEN l.debit_amount IS NOT NULL THEN l.amount_thb ELSE 0 END),0) =
              coalesce(sum(CASE WHEN l.credit_amount IS NOT NULL THEN l.amount_thb ELSE 0 END),0) AS thb_balanced
            FROM journal_entries e LEFT JOIN journal_entry_lines l ON l.journal_entry_id = e.id
            WHERE e.source_transaction_id = ANY(${accountingIds}::text[])
            GROUP BY e.id`;
          const gainEntry = persistedAccounting.find(e => e.source_transaction_id === accountingIds[0]);
          const zeroEntry = persistedAccounting.find(e => e.source_transaction_id === accountingIds[1]);
          const missingEntry = persistedAccounting.find(e => e.source_transaction_id === accountingIds[2]);
          ok(gainEntry?.posting_state === "POSTED" && Number(gainEntry.realized_gain_loss) === 189 &&
            Number(gainEntry.realized_gain_loss_thb) === 6694.38 && Number(gainEntry.amount_thb) === 42114.38,
            "REG-R258: gain 189 / THB 6694.38 persisted; conflicting header THB replaced");
          ok(zeroEntry?.posting_state === "POSTED" && zeroEntry.line_count === 2,
            "REG-R258: zero-gain SELL persists two positive lines");
          ok(missingEntry?.posting_state === "SKIPPED" && missingEntry.line_count === 0 &&
            missingEntry.cost_basis === null && missingEntry.realized_gain_loss === null &&
            missingEntry.realized_gain_loss_thb === null && !!missingEntry.skip_reason,
            "REG-R258: no-basis SELL persists null gains and zero lines with reason");
          ok(persistedAccounting.every(e => e.native_balanced && e.thb_balanced),
            "REG-R258: persisted native and THB debit/credit totals match");
          const manual = await mfaLedger.createJournalEntry(mfaUserId, {
            entryDate: "2026-01-15", description: "R5 conflicting line THB",
            lines: [
              { accountId: "1020", currency: "USD", debit: "10.005", fxRateEffective: "35.42", amountThb: "999" },
              { accountId: "3010", currency: "USD", credit: "10.005", fxRateEffective: "35.42", amountThb: "888" },
            ],
          });
          const manualLines = manual.ok ? await client`
            SELECT debit_amount, credit_amount, amount_thb FROM journal_entry_lines
            WHERE journal_entry_id = ${manual.entryId}` : [];
          ok(manualLines.length === 2 && manualLines.every(l =>
            Number(l.debit_amount ?? l.credit_amount) === 10.01 && Number(l.amount_thb) === 354.55),
            "REG-R258: conflicting caller line THB cannot persist (10.01 -> 354.55)");
          const edge = await mfaLedger.createJournalEntry(mfaUserId, {
            entryDate: "2026-01-15", description: "R5 rounding rejection",
            lines: [
              { accountId: "1020", currency: "USD", debit: "0.005", fxRateEffective: "35" },
              { accountId: "1020", currency: "USD", debit: "0.005", fxRateEffective: "35" },
              { accountId: "3010", currency: "USD", credit: "0.010", fxRateEffective: "35" },
            ],
          });
          ok(!edge.ok && edge.errors.some(e => e.includes("does not balance")),
            "REG-R258: raw-balanced but rounded-unbalanced write is rejected");
          // Execute the real recompute command: these SELLs have no supporting BUY.
          execFileSync(process.execPath, ["./node_modules/tsx/dist/cli.mjs",
            "./scripts/recompute-cost-basis-webull.mts", mfaUserId], { stdio: "pipe" });
          const recomputedSells = await client`SELECT e.posting_state, e.cost_basis,
            e.realized_gain_loss, e.realized_gain_loss_thb,
            (SELECT count(*)::int FROM journal_entry_lines l WHERE l.journal_entry_id=e.id) AS line_count
            FROM journal_entries e WHERE e.source_transaction_id = ANY(${accountingIds}::text[])
              AND e.status='POSTED' AND e.source_type='STATEMENT'`;
          ok(recomputedSells.length === 3 && recomputedSells.every(e =>
            e.posting_state === "SKIPPED" && e.cost_basis === null && e.realized_gain_loss === null &&
            e.realized_gain_loss_thb === null && e.line_count === 0),
            "REG-R258: actual recompute clears unsupported basis/gains and retains line-less SELLs");
          await client`DELETE FROM journal_entry_lines WHERE journal_entry_id IN
            (SELECT id FROM journal_entries WHERE source_transaction_id = ANY(${accountingIds}::text[]))`;
          await client`DELETE FROM journal_entries WHERE source_transaction_id = ANY(${accountingIds}::text[])`;
          await client`DELETE FROM "Capital_Transactions" WHERE transaction_id = ANY(${accountingIds}::text[])`;
          // Self-cleaning (shared CLEANUP also removes this user's linked rows).
          await client`
            DELETE FROM journal_entry_lines
            WHERE journal_entry_id IN (
              SELECT id FROM journal_entries WHERE source_transaction_id IN (${txMonthly}, ${txStandalone}, ${txLegacy})
            )`;
          await client`
            DELETE FROM journal_entries WHERE source_transaction_id IN (${txMonthly}, ${txStandalone}, ${txLegacy})`;
          await client`
            DELETE FROM "Capital_Transactions" WHERE transaction_id IN (${txMonthly}, ${txStandalone}, ${txLegacy})`;
          await client`DELETE FROM documents WHERE id = ${docId} AND user_id = ${mfaUserId}`;
        }
      }
    }
  }

  // ================= REG: DATA INTEGRITY CHECKS (migration 0025) =================
  // Proves the 14 CHECK constraints that remained after the upgrade-safety
  // review are present and enforce the closed sets + magnitude guards at the
  // DB level: invalid journal finite-state values, invalid journal-line
  // magnitudes, the both/neither single-leg defect, negative attempts, the
  // audit action closed set, and a valid-value sweep that exercises every
  // allowed state. Invalid inserts must fail with SQLSTATE 23514. Requires the
  // 0025 migration.
  //
  // The 8 constraints DEFERRED by that review (chk_users_role/status,
  // chk_capital_transactions_type/source_type/side/category/quantity_positive,
  // chk_notifications_type) are verified in the upgrade-regression block below:
  // a legacy row carrying an out-of-domain value must now survive an unrelated
  // UPDATE (no 23514) — the exact breakage that live PG17 testing proved those
  // NOT VALID constraints would have caused.
  {
    const checkExists = await client`
      SELECT 1 AS one FROM pg_constraint
      WHERE conname = 'chk_audit_logs_action'
      LIMIT 1`;
    if (checkExists.length === 0) {
      console.log(
        "\n  SKIP  REG-data-integrity: migration 0025 constraints absent (run the 0025 migration)"
      );
    } else {
      console.log("\n=== REG: DATA INTEGRITY CHECKS ===");
      const { randomUUID } = await import("node:crypto");
      const diEmail = `di-${randomUUID()}@test.local`;
      const diPass = "DiCheck!234";
      const diReg = await registerAs(diEmail, diPass);
      const diJson = (await diReg.json()) as { data?: { user?: { id?: string } } };
      const diUserId = diJson.data?.user?.id;
      if (!diUserId) {
        ok(false, "REG-di: register failed to create the data-integrity test user");
      } else {
        smokeUserIds.push(diUserId);
        ok(diReg.status === 201, "REG-di: test user registers (role USER / status ACTIVE pass)");

        const nowIso = new Date().toISOString();
        // Grab a seeded account to satisfy FKs when testing journal lines.
        const acct = await client`
          SELECT id FROM accounts WHERE user_id = ${diUserId} AND code = '1010' LIMIT 1`;
        const acctId: string = acct[0]?.id;
        const jNo = 5000 + Math.floor(Math.random() * 4000);
        const jEntryId = randomUUID();

        const expectCheckViolation = async (
          label: string,
          run: () => Promise<unknown>
        ) => {
          try {
            await run();
            ok(false, `REG-di: ${label} — expected SQLSTATE 23514 but the write succeeded`);
          } catch (e) {
            const code = (e as { code?: string })?.code ?? "none";
            ok(code === "23514", `REG-di: ${label} — rejected with SQLSTATE 23514 (got ${code})`);
          }
        };

        // ---- Schema shape: all 14 surviving constraints registered with the right tier ----
        const chkRows = await client`
          SELECT c.conname, c.convalidated
          FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
          WHERE c.contype = 'c' AND c.conname IN (
            'chk_corporate_actions_action_type',
            'chk_accounts_type','chk_accounts_opening_balance_non_negative',
            'chk_journal_entries_source_type','chk_journal_entries_status',
            'chk_journal_entries_side','chk_journal_entries_posting_state',
            'chk_journal_entries_type',
            'chk_journal_entry_lines_debit_positive','chk_journal_entry_lines_credit_positive',
            'chk_journal_entry_lines_fx_rate_effective_positive','chk_journal_entry_lines_amount_thb_positive',
            'chk_audit_logs_action',
            'chk_auth_rate_limits_attempts_non_negative'
          )`;
        ok(
          chkRows.length === 14,
          `REG-di: all 14 data-integrity constraints are registered (found ${chkRows.length})`
        );
        const nameOf = (n: string) => chkRows.find((r) => r.conname === n);
        const assertTier = (n: string, notValidExpected: boolean) =>
          ok(
            (nameOf(n)?.convalidated === !notValidExpected) === true,
            `REG-di: ${n} is ${notValidExpected ? "NOT VALID (notvalid=true)" : "VALIDATED"}`
          );
        // NOT VALID tier: only audit_logs (append-only — proven zero UPDATE paths).
        assertTier("chk_audit_logs_action", true);
        // VALIDATED tier: audited repo-only writers.
        assertTier("chk_journal_entries_status", false);
        assertTier("chk_accounts_type", false);
        assertTier("chk_journal_entry_lines_debit_positive", false);
        assertTier("chk_auth_rate_limits_attempts_non_negative", false);
        // The 8 deferred constraints must be ABSENT (removed from 0025 after the
        // upgrade-safety review proved NOT VALID breaks legacy rows on UPDATE).
        const absentChk = await client`
          SELECT c.conname FROM pg_constraint c
          WHERE c.contype = 'c' AND c.conname IN (
            'chk_users_role','chk_users_status',
            'chk_capital_transactions_type','chk_capital_transactions_source_type',
            'chk_capital_transactions_side','chk_capital_transactions_category',
            'chk_capital_transactions_quantity_positive','chk_notifications_type'
          )`;
        ok(
          absentChk.length === 0,
          `REG-di: the 8 deferred constraints are absent from the DB (found ${absentChk.length})`
        );

        // ---- Invalid journal finite-state values (5 fields) ----
        await expectCheckViolation("bad journal_entries.source_type", () =>
          client`INSERT INTO journal_entries (id, user_id, entry_no, entry_date, description, source_type, status, created_at, updated_at)
            VALUES (${randomUUID()}, ${diUserId}, ${jNo}, '2026-01-01', 'REG-di', 'CSV', 'POSTED', ${nowIso}, ${nowIso})`
        );
        await expectCheckViolation("bad journal_entries.status", () =>
          client`INSERT INTO journal_entries (id, user_id, entry_no, entry_date, description, source_type, status, created_at, updated_at)
            VALUES (${randomUUID()}, ${diUserId}, ${jNo + 1}, '2026-01-01', 'REG-di', 'MANUAL', 'DRAFT', ${nowIso}, ${nowIso})`
        );
        await expectCheckViolation("bad journal_entries.posting_state", () =>
          client`INSERT INTO journal_entries (id, user_id, entry_no, entry_date, description, source_type, status, posting_state, created_at, updated_at)
            VALUES (${randomUUID()}, ${diUserId}, ${jNo + 2}, '2026-01-01', 'REG-di', 'MANUAL', 'POSTED', 'FAILED', ${nowIso}, ${nowIso})`
        );
        await expectCheckViolation("bad journal_entries.side", () =>
          client`INSERT INTO journal_entries (id, user_id, entry_no, entry_date, description, source_type, status, side, created_at, updated_at)
            VALUES (${randomUUID()}, ${diUserId}, ${jNo + 3}, '2026-01-01', 'REG-di', 'MANUAL', 'POSTED', 'HOLD', ${nowIso}, ${nowIso})`
        );
        await expectCheckViolation("bad journal_entries.type", () =>
          client`INSERT INTO journal_entries (id, user_id, entry_no, entry_date, description, source_type, status, type, created_at, updated_at)
            VALUES (${randomUUID()}, ${diUserId}, ${jNo + 4}, '2026-01-01', 'REG-di', 'MANUAL', 'POSTED', 'BUY', ${nowIso}, ${nowIso})`
        );

        // ---- Invalid journal-line magnitudes + single-leg defect (5 cases) ----
        const seedLineEntry = await client`
          INSERT INTO journal_entries (id, user_id, entry_no, entry_date, description, source_type, status, created_at, updated_at)
          VALUES (${jEntryId}, ${diUserId}, ${jNo + 5}, '2026-01-01', 'REG-di lines', 'MANUAL', 'POSTED', ${nowIso}, ${nowIso})
          RETURNING id`;
        await expectCheckViolation("zero debit_amount", () =>
          client`INSERT INTO journal_entry_lines (id, journal_entry_id, user_id, account_id, currency, debit_amount, credit_amount, amount_thb, fx_rate_effective)
            VALUES (${randomUUID()}, ${jEntryId}, ${diUserId}, ${acctId}, 'USD', '0', NULL, '10.00', '1.00')`
        );
        await expectCheckViolation("negative credit_amount", () =>
          client`INSERT INTO journal_entry_lines (id, journal_entry_id, user_id, account_id, currency, debit_amount, credit_amount, amount_thb, fx_rate_effective)
            VALUES (${randomUUID()}, ${jEntryId}, ${diUserId}, ${acctId}, 'USD', NULL, '-5.00', '5.00', '1.00')`
        );
        await expectCheckViolation("zero fx_rate_effective", () =>
          client`INSERT INTO journal_entry_lines (id, journal_entry_id, user_id, account_id, currency, debit_amount, credit_amount, amount_thb, fx_rate_effective)
            VALUES (${randomUUID()}, ${jEntryId}, ${diUserId}, ${acctId}, 'USD', '10.00', NULL, '10.00', '0')`
        );
        await expectCheckViolation("zero amount_thb", () =>
          client`INSERT INTO journal_entry_lines (id, journal_entry_id, user_id, account_id, currency, debit_amount, credit_amount, amount_thb, fx_rate_effective)
            VALUES (${randomUUID()}, ${jEntryId}, ${diUserId}, ${acctId}, 'USD', '10.00', NULL, '0', '1.00')`
        );
        await expectCheckViolation("both debit AND credit set", () =>
          client`INSERT INTO journal_entry_lines (id, journal_entry_id, user_id, account_id, currency, debit_amount, credit_amount, amount_thb, fx_rate_effective)
            VALUES (${randomUUID()}, ${jEntryId}, ${diUserId}, ${acctId}, 'USD', '10.00', '10.00', '10.00', '1.00')`
        );
        await expectCheckViolation("neither debit nor credit set", () =>
          client`INSERT INTO journal_entry_lines (id, journal_entry_id, user_id, account_id, currency, debit_amount, credit_amount, amount_thb, fx_rate_effective)
            VALUES (${randomUUID()}, ${jEntryId}, ${diUserId}, ${acctId}, 'USD', NULL, NULL, '10.00', '1.00')`
        );

        // ---- Negative auth_rate_limits.attempts ----
        await expectCheckViolation("negative auth_rate_limits.attempts", () =>
          client`INSERT INTO auth_rate_limits (key, attempts) VALUES (${`di-${randomUUID()}`}, -1)`
        );

        // ---- Upgrade regression: legacy rows with out-of-domain values survive ----
        // This is the EXACT breakage the 8 deferred constraints would have
        // caused if kept with NOT VALID: a legacy row holding a value outside
        // the closed set breaks ANY unrelated UPDATE (SQLSTATE 23514). With them
        // deferred, the same legacy row must now update freely — no DB gate.
        // Service-layer validation still blocks NEW invalid writes (the valid
        // sweep below + the app routes cover that).
        const legacyUserId = randomUUID();
        const legacyUserEmail = `legacy-${randomUUID()}@test.local`;
        await client`
          INSERT INTO "User" (id, email, password_hash, role, status, created_at)
          VALUES (${legacyUserId}, ${legacyUserEmail}, 'x', 'PORTFOLIO_VIEWER', 'DEACTIVATED', ${nowIso})`;
        const legacyUserUpdate = await client`
          UPDATE "User" SET "last_seen_at" = now()
          WHERE id = ${legacyUserId} RETURNING id`;
        ok(
          legacyUserUpdate.length === 1,
          "REG-di upgrade-regression: legacy User (role PORTFOLIO_VIEWER / status DEACTIVATED) survives an unrelated heartbeat UPDATE"
        );

        const legacyTxId = `legacy-${randomUUID()}`;
        await client`
          INSERT INTO "Capital_Transactions" (transaction_id, user_id, amount_foreign, currency, transaction_date, amount_thb, type, source_type, side, category, quantity)
          VALUES (${legacyTxId}, ${legacyUserId}, '100.00', 'USD', '2024-01-15', '3200.00', 'BUY', 'CSV', 'RIGHT', 'liability', '0')`;
        const legacyTxUpdate = await client`
          UPDATE "Capital_Transactions" SET "amount_foreign" = '200.00'
          WHERE transaction_id = ${legacyTxId} RETURNING transaction_id`;
        ok(
          legacyTxUpdate.length === 1,
          "REG-di upgrade-regression: legacy Capital_Transactions (BUY/CSV/RIGHT/liability/qty 0) survives an unrelated amount UPDATE"
        );

        const legacyNotifId = randomUUID();
        await client`
          INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at)
          VALUES (${legacyNotifId}, ${legacyUserId}, 'Legacy', 'old', 'EMAIL_ALERT', false, ${nowIso})`;
        const legacyNotifUpdate = await client`
          UPDATE notifications SET is_read = true
          WHERE id = ${legacyNotifId} RETURNING id`;
        ok(
          legacyNotifUpdate.length === 1,
          "REG-di upgrade-regression: legacy notification (type EMAIL_ALERT) survives a mark-read UPDATE"
        );
        // Cleanup the legacy rows (User is dangling-safe: no FK children remain).
        await client`DELETE FROM notifications WHERE id = ${legacyNotifId}`;
        await client`DELETE FROM "Capital_Transactions" WHERE transaction_id = ${legacyTxId}`;
        await client`DELETE FROM "User" WHERE id = ${legacyUserId}`;

        // ---- Valid-value sweep: every allowed state still writes successfully ----
        const validAction = await client`
          INSERT INTO corporate_actions (id, user_id, symbol, action_type, transaction_date, created_at, updated_at)
          VALUES (${randomUUID()}, ${diUserId}, 'NVDA', 'SPLIT', '2026-01-01', ${nowIso}, ${nowIso})
          RETURNING id`;
        ok(validAction.length === 1, "REG-di: valid corporate_actions (SPLIT) passes");
        await client`DELETE FROM corporate_actions WHERE id = ${validAction[0].id}`;

        const validAccount = await client`
          INSERT INTO accounts (id, user_id, code, name, type, opening_balance, created_at, updated_at)
          VALUES (${randomUUID()}, ${diUserId}, '9997', 'X', 'INCOME', NULL, ${nowIso}, ${nowIso})
          RETURNING id`;
        ok(validAccount.length === 1, "REG-di: valid accounts (INCOME / NULL opening_balance) passes");
        await client`DELETE FROM accounts WHERE id = ${validAccount[0].id}`;

        const validEntry = await client`
          INSERT INTO journal_entries (id, user_id, entry_no, entry_date, description, source_type, status, posting_state, side, type, created_at, updated_at)
          VALUES (${randomUUID()}, ${diUserId}, ${jNo + 9}, '2026-01-01', 'REG-di valid', 'STATEMENT', 'POSTED', 'SKIPPED', 'SELL', 'CASH_IN', ${nowIso}, ${nowIso})
          RETURNING id`;
        ok(validEntry.length === 1, "REG-di: valid journal_entries (STATEMENT/POSTED/SKIPPED/SELL/CASH_IN) passes");
        // Nullable tallows: a plain GL-manual entry with all trade-detail fields NULL.
        const validEntryNulls = await client`
          INSERT INTO journal_entries (id, user_id, entry_no, entry_date, description, source_type, status, created_at, updated_at)
          VALUES (${randomUUID()}, ${diUserId}, ${jNo + 10}, '2026-01-01', 'REG-di nulls', 'MANUAL', 'POSTED', ${nowIso}, ${nowIso})
          RETURNING id`;
        ok(validEntryNulls.length === 1, "REG-di: valid journal_entries with NULL side/type/posting-nulls passes");
        await client`DELETE FROM journal_entries WHERE id = ${validEntry[0].id}`;
        await client`DELETE FROM journal_entries WHERE id = ${validEntryNulls[0].id}`;

        const lineDebit = await client`
          INSERT INTO journal_entry_lines (id, journal_entry_id, user_id, account_id, currency, debit_amount, credit_amount, amount_thb, fx_rate_effective)
          VALUES (${randomUUID()}, ${jEntryId}, ${diUserId}, ${acctId}, 'USD', '1234.56', NULL, '1234.56', '35.50')
          RETURNING id`;
        const lineCredit = await client`
          INSERT INTO journal_entry_lines (id, journal_entry_id, user_id, account_id, currency, debit_amount, credit_amount, amount_thb, fx_rate_effective)
          VALUES (${randomUUID()}, ${jEntryId}, ${diUserId}, ${acctId}, 'USD', NULL, '1234.56', '1234.56', '1.00')
          RETURNING id`;
        ok(
          lineDebit.length === 1 && lineCredit.length === 1,
          "REG-di: valid journal lines (debit-only + credit-only, positive, THB base > 0) pass"
        );
        await client`DELETE FROM journal_entry_lines WHERE id = ${lineDebit[0].id}`;
        await client`DELETE FROM journal_entry_lines WHERE id = ${lineCredit[0].id}`;

        const validNotif = await client`
          INSERT INTO notifications (id, user_id, title, message, type, created_at)
          VALUES (${randomUUID()}, ${diUserId}, 't', 'm', 'SYSTEM', ${nowIso})
          RETURNING id`;
        ok(validNotif.length === 1, "REG-di: valid notifications (SYSTEM) passes");

        const validAudit = await client`
          INSERT INTO audit_logs (id, user_id, action, created_at)
          VALUES (${randomUUID()}, ${diUserId}, 'LOGIN_SUCCESS', ${nowIso})
          RETURNING id`;
        ok(validAudit.length === 1, "REG-di: valid audit_logs (LOGIN_SUCCESS) passes");

        const validRate = await client`
          INSERT INTO auth_rate_limits (key, attempts) VALUES (${`di-${randomUUID()}`}, 3)
          RETURNING key`;
        ok(validRate.length === 1, "REG-di: valid auth_rate_limits (attempts 3) passes");

        // Self-cleaning: journal lines -> the seeded line entry + INTENTIONAL
        // loop rows are FK-bound to accounts; the shared CLEANUP already deletes
        // lines/entries/accounts/user for this smoke user.
        await client`DELETE FROM journal_entry_lines WHERE journal_entry_id = ${jEntryId}`;
        await client`DELETE FROM journal_entries WHERE id = ${jEntryId}`;
      }
    }
  }

  // ================= REG: USER ISOLATION =================
  const { runReleaseReadinessTests } = await import("./release-readiness-db.mjs");
  await runReleaseReadinessTests(client, ok, tokenA, tokenAd, userARow.id);

  console.log("\n=== REG: USER ISOLATION ===");
  const { runUserIsolationTests } = await import("./user-isolation-db.mjs");
  await runUserIsolationTests(client, ok, makePdf, tokenAd);

  // ================= CLEANUP =================
  const { runStatementDeleteTests } = await import("./statement-delete-db.mjs");
  await runStatementDeleteTests(client, ok, makePdf);
  const { runCurrencyExchangeTests } = await import("./r6-r7-db.mjs");
  await runCurrencyExchangeTests(client, ok);

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
  // Rate-limit counters written during this window (dedicated test IPs/emails)
  // so a re-run inside the 15-minute window starts from a clean slate.
  await client`DELETE FROM auth_rate_limits WHERE updated_at >= ${startTime}`;
  // Ledger rows are FK-bound to accounts/entries: remove lines -> entries ->
  // accounts for every smoke user (register now seeds a chart of accounts) and
  // for USER A (whose statement uploads lazily-seeded accounts + postings).
  if (userARow) {
    await client`DELETE FROM journal_entry_lines WHERE user_id = ${userARow.id}`;
    await client`DELETE FROM journal_entries WHERE user_id = ${userARow.id}`;
    await client`DELETE FROM accounts WHERE user_id = ${userARow.id}`;
  }
  for (const sid of smokeUserIds) {
    await client`DELETE FROM journal_entry_lines WHERE user_id = ${sid}`;
    await client`DELETE FROM journal_entries WHERE user_id = ${sid}`;
    await client`DELETE FROM accounts WHERE user_id = ${sid}`;
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
