// Statement duplicate-import (content-hash) unit tests.
//
// Covers the DB-free logic that backs the duplicate guard:
//   - computeContentHash is deterministic and content-sensitive
//   - buildDuplicatePayload exposes STATEMENT_ALREADY_IMPORTED safely
//   - an in-memory model of the user-scoped dedup decision mirrors the route
//     semantics (same user+content -> duplicate; different user -> allowed;
//     different content + same filename -> allowed; count must not grow).
//
// The real DB path (findExistingDocumentByHash / unique index) is exercised by
// the DB integration harness (scripts/run-tests.mts), which requires
// TEST_DATABASE_URL; it is intentionally not called here.
// No Gemini API is involved.
//
// Run:  npx tsx scripts/test-statement-dedup.mts
import { createHash } from "node:crypto";
import {
  computeContentHash,
  buildDuplicatePayload,
  STATEMENT_ALREADY_IMPORTED,
} from "../app/lib/statement-hash";

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

// Minimal in-memory model replicating the route's user-scoped dedup decision:
// a ledger of {userId, contentHash, documentId} plus a function that, for a
// given (userId, contentHash), returns whether a duplicate already exists.
function makeModel() {
  type Row = { userId: string; contentHash: string; documentId: string };
  const rows: Row[] = [];
  let seq = 0;
  return {
    importPdf(
      userId: string,
      bytes: Uint8Array
    ):
      | { duplicate: true; payload: ReturnType<typeof buildDuplicatePayload> }
      | { duplicate: false; documentId: string } {
      const contentHash = computeContentHash(bytes);
      const existing = rows.find(
        (r) => r.userId === userId && r.contentHash === contentHash
      );
      if (existing) {
        return { duplicate: true, payload: buildDuplicatePayload(existing.documentId) };
      }
      const documentId = `doc-${++seq}`;
      rows.push({ userId, contentHash, documentId });
      return { duplicate: false, documentId };
    },
    count(userId: string) {
      return rows.filter((r) => r.userId === userId).length;
    },
  };
}

function main() {
  console.log("\n=== STATEMENT DUPLICATE IMPORT (content hash) ===\n");

  // 1. Hash determinism + correctness.
  const a = new Uint8Array([1, 2, 3, 4]);
  ok(computeContentHash(a) === computeContentHash(a), "hash is deterministic (same bytes -> same hash)");
  const expected = createHash("sha256").update(Buffer.from(a)).digest("hex");
  ok(computeContentHash(a) === expected, "hash matches canonical SHA-256 of the bytes");
  const b = new Uint8Array([1, 2, 3, 5]);
  ok(computeContentHash(a) !== computeContentHash(b), "different bytes -> different hash");

  // 2. Duplicate payload shape.
  const p1 = buildDuplicatePayload("doc-keep");
  ok(
    p1.duplicate === true &&
      p1.code === STATEMENT_ALREADY_IMPORTED &&
      p1.message === "Statement นี้เคยถูกนำเข้าแล้ว" &&
      p1.existingDocumentId === "doc-keep",
    "duplicate payload exposes code/message and the user's own existingDocumentId"
  );
  ok(buildDuplicatePayload(null).existingDocumentId === null, "duplicate payload supports null existingDocumentId (concurrent path)");

  // 3. Same user uploads identical bytes twice: first allowed, second duplicate.
  const m = makeModel();
  const sameBytes = new Uint8Array(256).fill(7);
  const first = m.importPdf("user-1", sameBytes);
  ok(first.duplicate === false, "same user, first identical import is allowed");
  const firstId = first.duplicate === false ? first.documentId : "";
  const second = m.importPdf("user-1", sameBytes);
  ok(
    second.duplicate === true &&
      second.payload.existingDocumentId === firstId,
    "same user, second identical import -> STATEMENT_ALREADY_IMPORTED"
  );
  ok(m.count("user-1") === 1, "Capital_Transactions-style row count does not increase on duplicate (stays 1)");

  // 4. Same user, two different PDFs with the same filename: both allowed.
  const m2 = makeModel();
  const p1a = m2.importPdf("user-2", new Uint8Array([9, 9]));
  const p1b = m2.importPdf("user-2", new Uint8Array([9, 8]));
  ok(p1a.duplicate === false && p1b.duplicate === false, "same filename but different content: both imports allowed");
  ok(m2.count("user-2") === 2, "two different-content documents both count as separate imports");

  // 5. Different users upload identical bytes: both allowed (user scoping).
  const m3 = makeModel();
  const shared = new Uint8Array(64).fill(3);
  const u1 = m3.importPdf("user-A", shared);
  const u2 = m3.importPdf("user-B", shared);
  ok(u1.duplicate === false && u2.duplicate === false, "identical PDF, different users -> both allowed (no cross-user leak)");

  console.log(`\n================ SUMMARY ================`);
  console.log(`PASS: ${passed}   FAIL: ${failed}`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main();
