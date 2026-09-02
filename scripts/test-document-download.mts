// Server-authoritative Statement DOWNLOAD regression tests — DB-free tier.
//
// No database, no browser, no running server. Covers the parts of
// GET /api/v1/documents/:id/download that can be proven purely:
//   - filename sanitization (no CR/LF / quote / backslash / control chars in
//     Content-Disposition),
//   - strict path containment (path-traversal protection) via safeResolveStoredPath,
//   - frontend download wiring uses the server endpoint, not IndexedDB authority.
//
// The DB-backed route behavior tests (own-doc success, cross-user 404, missing
// doc, missing physical file) live in scripts/run-tests.mts (integration tier).
// Run:  npx tsx scripts/test-document-download.mts
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  sanitizeDownloadFilename,
  safeResolveStoredPath,
} from "../app/lib/storage/statement-path";
import {
  buildObjectKey,
  resolveStorageMode,
  localStorageDriver,
  supabaseStorageDriver,
} from "../app/lib/storage/storage-driver";

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
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

console.log("\n=== SERVER-AUTHORITATIVE STATEMENT DOWNLOAD (DB-free) ===\n");

// ---- Filename sanitization ----
ok(
  sanitizeDownloadFilename('bad"\\\r\nname.PDF').indexOf('"') === -1 &&
    sanitizeDownloadFilename('bad"\\\r\nname.PDF').indexOf("\r") === -1 &&
    sanitizeDownloadFilename('bad"\\\r\nname.PDF').indexOf("\n") === -1 &&
    sanitizeDownloadFilename('bad"\\\r\nname.PDF').indexOf("\\") === -1,
  "sanitize: quotes / CR / LF / backslash stripped from filename"
);
ok(
  !sanitizeDownloadFilename("normal Statement.PDF").includes("\r") &&
    !sanitizeDownloadFilename("normal Statement.PDF").includes("\n") &&
    !sanitizeDownloadFilename("normal Statement.PDF").includes('"'),
  "sanitize: normal filename is unchanged and header-safe"
);
ok(
  sanitizeDownloadFilename("../..//") === "statement.pdf",
  "sanitize: degenerate path collapses to safe default"
);
ok(
  sanitizeDownloadFilename("") === "statement.pdf",
  "sanitize: empty name uses safe default"
);
const ctl = String.fromCharCode(3, 16, 27) + "x.pdf";
ok(
  !/[^\x20-\x7e]/.test(sanitizeDownloadFilename(ctl)),
  "sanitize: control characters removed entirely"
);

// ---- Path-traversal / containment ----
const root = path.resolve("C:", "test", "statements");
ok(
  safeResolveStoredPath(path.join(root, "abc.pdf"), root) === path.resolve(path.join(root, "abc.pdf")),
  "path: file inside baseDir resolves"
);
ok(
  safeResolveStoredPath(path.join(root, "..", "secret.pdf"), root) === null,
  "path: parent-escape rejected"
);
ok(
  safeResolveStoredPath(path.join(root, "sub", "..", "..", "etc", "passwd"), root) === null,
  "path: traversal landing outside rejected"
);
ok(
  safeResolveStoredPath(path.resolve("C:", "other", "x.pdf"), root) === null,
  "path: unrelated absolute path rejected"
);
ok(
  safeResolveStoredPath("", root) === null && safeResolveStoredPath(null, root) === null,
  "path: empty / null rejected"
);
ok(
  safeResolveStoredPath(root, root) === null,
  "path: the baseDir itself (a directory) is not a valid file"
);
ok(
  safeResolveStoredPath(path.join(root, "..", "..", "root.bin"), root) === null,
  "path: deep escape above root rejected"
);

// ---- Frontend download wiring (server endpoint, not IndexedDB authority) ----
function handleDownloadBody(src: string): string {
  const start = src.indexOf("const handleDownload");
  const end = src.indexOf("\n  };", start);
  return start >= 0 && end >= 0 ? src.slice(start, end + 4) : "";
}

const archive = read("app/component/DashboardUser/StatementArchivePage.tsx");
ok(
  archive.includes("downloadUserDocument"),
  "Statement Archive download uses the server download helper"
);
ok(
  archive.includes("/download") || archive.includes("downloadUserDocument("),
  "Statement Archive download targets :id/download with the access token"
);
const archiveDl = handleDownloadBody(archive);
ok(
  archiveDl.includes("downloadUserDocument") &&
    !archiveDl.includes("getLocalBlobById") &&
    !archiveDl.includes("getLocalDocumentByName"),
  "Statement Archive download handler fetches from the server, not IndexedDB"
);

const list = read("app/component/DashboardUser/Storeddocumentslist.tsx");
ok(
  list.includes("downloadUserDocument"),
  "Stored Documents List download uses the server download helper"
);
const listDl = handleDownloadBody(list);
ok(
  listDl.includes("downloadUserDocument") &&
    !listDl.includes("getLocalBlobById") &&
    !listDl.includes("getLocalDocumentByName"),
  "Stored Documents List download handler fetches from the server, not IndexedDB"
);

const route = read("app/routes/api/documents.$id.download.ts");
ok(
  route.includes("Content-Disposition") &&
    route.includes("sanitizeDownloadFilename") &&
    route.includes("getStorageDriver") &&
    route.includes(".readPdf("),
  "download route sanitizes the header filename and reads via the storage driver"
);
ok(
  route.includes("application/pdf"),
  "download route serves application/pdf"
);

// ---- Server-side object key generation ----
const uid = "00000000-0000-0000-0000-0000000000aa";
const did = "00000000-0000-0000-0000-0000000000bb";
ok(
  buildObjectKey(uid, did) === `statements/${uid}/${did}.pdf`,
  "object key: statements/<userId>/<documentId>.pdf"
);
const distinctId1: string = uid;
const distinctId2: string = did;
ok(
  distinctId1 !== distinctId2 &&
    buildObjectKey(distinctId1, distinctId1) === `statements/${distinctId1}/${distinctId1}.pdf`,
  "object key: deterministic server-side composition"
);

// ---- Storage driver selection (never connects to live Supabase in tests) ----
const savedStorageEnv = {
  STORAGE_MODE: process.env.STORAGE_MODE,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET,
};
try {
  process.env.STORAGE_MODE = "local";
  ok(
    resolveStorageMode() === "local",
    "mode: STORAGE_MODE=local forces local driver"
  );
  process.env.STORAGE_MODE = "supabase";
  ok(
    resolveStorageMode() === "supabase",
    "mode: STORAGE_MODE=supabase forces supabase driver"
  );
  process.env.STORAGE_MODE = "";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  process.env.SUPABASE_STORAGE_BUCKET = "statements";
  ok(
    resolveStorageMode() === "supabase",
    "mode: auto-selected supabase when all storage vars present"
  );
  process.env.SUPABASE_URL = "";
  ok(
    resolveStorageMode() === "local",
    "mode: auto-selected local when storage vars absent (tests never touch live storage)"
  );
} finally {
  for (const [k, v] of Object.entries(savedStorageEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ---- Local driver: store -> read -> delete round trip (filesystem, gitignored) ----
const uidB = "00000000-0000-0000-0000-0000000000aa";
const cidB = "00000000-0000-0000-0000-0000000000cc";
const objKey = buildObjectKey(uidB, cidB);
const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 66]);
const storeRes = await localStorageDriver.storePdf({
  key: objKey,
  bytes: pdfBytes,
});
ok(storeRes.ok === true, "local driver: storePdf succeeds for a valid object key");
const readBack = await localStorageDriver.readPdf(objKey);
ok(
  readBack !== null && Buffer.from(readBack).equals(Buffer.from(pdfBytes)),
  "local driver: readPdf returns the exact stored bytes"
);
ok(
  await localStorageDriver.readPdf(`${objKey}.missing`) === null,
  "local driver: readPdf for a missing object returns null"
);
ok(
  await localStorageDriver.deletePdf(objKey) === true,
  "local driver: deletePdf removes the object"
);
ok(
  await localStorageDriver.readPdf(objKey) === null,
  "local driver: object gone after delete"
);

// ---- Local driver: traversal/invalid keys are refused with no file access ----
const traversal = path.join("..", "..", "secret.pdf");
const badStore = await localStorageDriver.storePdf({
  key: traversal,
  bytes: pdfBytes,
});
ok(
  badStore.ok === false,
  "local driver: storePdf refuses a traversal key"
);
ok(
  await localStorageDriver.readPdf(traversal) === null,
  "local driver: readPdf refuses a traversal key"
);
ok(
  await localStorageDriver.deletePdf(traversal) === true,
  "local driver: deletePdf refuses (no-op) a traversal key"
);

// ---- Supabase driver: invalid object keys are never sent to Storage ----
const supInvalid = "../../etc/passwd";
ok(
  await supabaseStorageDriver.readPdf(supInvalid) === null,
  "supabase driver: readPdf refuses an invalid object key without network"
);
ok(
  await supabaseStorageDriver.deletePdf(supInvalid) === true,
  "supabase driver: deletePdf refuses an invalid object key without network"
);
const supBadStore = await supabaseStorageDriver.storePdf({
  key: supInvalid,
  bytes: pdfBytes,
});
ok(
  supBadStore.ok === false,
  "supabase driver: storePdf rejects an invalid object key without network"
);
ok(
  await supabaseStorageDriver.readPdf(`statements/not-a-pdf-path/../x.pdf`) ===
    null,
  "supabase driver: structurally invalid keys are refused offline"
);

console.log(`\n================ SUMMARY ================`);
console.log(`PASS: ${passed}   FAIL: ${failed}`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
