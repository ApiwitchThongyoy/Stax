// Statement Library ("คลัง Statement") rapid-delete regression tests.
//
// Root cause fixed: Statement Archive / stored-documents delete fired a DELETE
// per click with no *synchronous per-document* in-flight guard.
//   - StatementArchivePage used a single React `deletingId` flag; React state
//     updates are async, so a second rapid click on the same row could fire
//     BEFORE the re-render set the flag -> a second DELETE for the same id.
//   - StoredDocumentsList had NO in-flight guard at all.
// The first DELETE succeeds (200); the now-concurrent duplicate hits
// /api/v1/documents/:id once the row is gone and returns 404 (observed as
// repeated "404 Not Found" with the same document id requested more than once).
//
// The fix extracts coordination into `app/lib/document-delete.ts`:
//   - `InFlightDeletionGuard.run(id, task)` sends `task` at most once per
//     in-flight window (synchronous Set, keyed by id), so at most one DELETE
//     reaches the server per document and different documents delete
//     independently.
//   - `classifyDeleteDocumentResponse` maps a DELETE status to
//     "deleted / gone / error / auth" so the UI revalidates only when the
//     server confirms the document is gone and never swallows 401/403.
//
// DOM-free: the guard + classifier are pure and run anywhere with tsx.
//
// Run:  npx tsx scripts/test-document-delete.mts
import { strict as assert } from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";
import {
  InFlightDeletionGuard,
  classifyDeleteDocumentResponse,
} from "../app/lib/document-delete";

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

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// 1. InFlightDeletionGuard — at most one network call per document in flight.
// ---------------------------------------------------------------------------
console.log("\n=== DOCUMENT DELETE: IN-FLIGHT GUARD ===\n");

{
  // Rapid repeated deletes of the SAME document: only the first reaches network.
  let networkCalls = 0;
  const guard = new InFlightDeletionGuard();
  const task = async () => {
    networkCalls++;
    await sleep(10);
  };

  const a = guard.run("doc-1", task);
  const b = guard.run("doc-1", task); // same id, still in flight
  const c = guard.run("doc-1", task); // same id, still in flight
  await Promise.all([a, b, c]);

  ok(
    (await a).started === true &&
      (await b).started === false &&
      (await c).started === false,
    "only the first run() for the same in-flight document sends the delete"
  );
  ok(
    networkCalls === 1,
    "exactly one network DELETE for rapid same-document clicks"
  );
}

{
  // After a delete finishes the id is released and a later delete works.
  let networkCalls = 0;
  const guard = new InFlightDeletionGuard();
  const task = async () => {
    networkCalls++;
    await sleep(5);
  };
  const first = await guard.run("doc-2", task);
  const second = await guard.run("doc-2", task);
  ok(
    first.started === true &&
      second.started === true &&
      networkCalls === 2,
    "id is released after a delete completes (retry allowed)"
  );
}

{
  // Different documents delete concurrently (independent, no global lock).
  let networkCalls = 0;
  const guard = new InFlightDeletionGuard();
  const task = async () => {
    networkCalls++;
    await sleep(20);
  };
  const results = await Promise.all([
    guard.run("doc-a", task),
    guard.run("doc-b", task),
    guard.run("doc-c", task),
  ]);
  ok(
    results.every((r) => r.started) && networkCalls === 3,
    "different documents delete independently without interfering"
  );
}

{
  // isInFlight reflects live snapshot (true mid-flight, false after).
  const hold = deferred<void>();
  const guard = new InFlightDeletionGuard();
  const p = guard.run("doc-3", async () => {
    await hold.promise;
  });
  ok(guard.isInFlight("doc-3"), "isInFlight true while a delete is in progress");
  hold.resolve();
  const result = await p;
  ok(
    !guard.isInFlight("doc-3") && result.started === true,
    "isInFlight false after the delete completes"
  );
}

{
  // onStateChange mirrors begin/end so the UI can disable that row.
  const order: Array<[string, boolean]> = [];
  const guard = new InFlightDeletionGuard((id, inflight) =>
    order.push([id, inflight])
  );
  const hold = deferred<void>();
  const p = guard.run("doc-4", async () => {
    await hold.promise;
  });
  ok(
    order.some(([id, inflight]) => id === "doc-4" && inflight === true),
    "onStateChange fires (id, true) when deletion begins"
  );
  hold.resolve();
  await p;
  ok(
    order.some(([id, inflight]) => id === "doc-4" && inflight === false),
    "onStateChange fires (id, false) when deletion ends"
  );
}

{
  // A throwing task still releases the id (does not hang the guard).
  let networkCalls = 0;
  const guard = new InFlightDeletionGuard();
  try {
    await guard.run("doc-fail", async () => {
      networkCalls++;
      throw new Error("boom");
    });
  } catch {
    /* expected */
  }
  ok(networkCalls === 1, "failed delete still counts as started (reaches network once)");
  const retry = await guard.run("doc-fail", async () => {
    networkCalls++;
  });
  ok(
    retry.started === true && networkCalls === 2,
    "id is released after a failed delete so it can be retried"
  );
}

// ---------------------------------------------------------------------------
// 2. classifyDeleteDocumentResponse — outcome mapping for the UI.
// ---------------------------------------------------------------------------
console.log("\n=== DOCUMENT DELETE: OUTCOME CLASSIFICATION ===\n");

ok(
  classifyDeleteDocumentResponse({ status: 200, ok: true }).kind === "deleted",
  "200 -> deleted (revalidate)"
);
ok(
  classifyDeleteDocumentResponse({ status: 404, ok: false }).kind === "gone",
  "404 on owned document -> gone (row already deleted; revalidate cleanly)"
);
ok(
  classifyDeleteDocumentResponse({ status: 401, ok: false }).kind === "auth",
  "401 -> auth (not swallowed)"
);
ok(
  classifyDeleteDocumentResponse({ status: 403, ok: false }).kind === "auth",
  "403 -> auth (not swallowed)"
);
{
  const err = classifyDeleteDocumentResponse({ status: 500, ok: false });
  ok(
    err.kind === "error" && err.message.length > 0,
    "5xx -> retryable error with a user-visible message"
  );
}
ok(
  classifyDeleteDocumentResponse({ status: 0, ok: false }).kind === "error",
  "network/unknown (status 0) -> retryable error"
);
ok(
  !["deleted", "gone"].includes(
    classifyDeleteDocumentResponse({ status: 401, ok: false }).kind
  ) &&
    !["deleted", "gone"].includes(
      classifyDeleteDocumentResponse({ status: 403, ok: false }).kind
    ) &&
    !["deleted", "gone"].includes(
      classifyDeleteDocumentResponse({ status: 500, ok: false }).kind
    ),
  "classifier never fabricates a deletion for auth/5xx/unknown"
);

// ---------------------------------------------------------------------------
// 3. Frontend wiring — components route deletes through the guard + classifier.
// ---------------------------------------------------------------------------
console.log("\n=== DOCUMENT DELETE: FRONTEND WIRING ===\n");

import { readFileSync } from "node:fs";
import { join } from "node:path";
const archive = readFileSync(
  join(process.cwd(), "app/component/DashboardUser/StatementArchivePage.tsx"),
  "utf8"
);
const stored = readFileSync(
  join(process.cwd(), "app/component/DashboardUser/Storeddocumentslist.tsx"),
  "utf8"
);

for (const [name, src] of [
  ["StatementArchivePage", archive],
  ["StoredDocumentsList", stored],
] as const) {
  ok(
    src.includes("InFlightDeletionGuard") &&
      src.includes("inFlight.current.run(") &&
      src.includes("classifyDeleteDocumentResponse"),
    `${name} routes deletes through the in-flight guard + classifier`
  );
  ok(
    src.includes("disabled={deletingIds.has(doc.id)}"),
    `${name} disables the delete control while only that document is in flight`
  );
  ok(
    src.includes("case \"gone\"") && src.includes("case \"deleted\""),
    `${name} treats a 2xx or an already-gone 404 as a clean removal`
  );
  ok(
    src.includes("case \"auth\""),
    `${name} handles 401/403 explicitly (never swallowed)`
  );
}

// Execute the actual component handlers with a minimal hook/JSX harness.
// Network, auth and IndexedDB are stubbed; deletion coordination is real.
// Native dialog focus/layout is left to the browser, not simulated here.
{
  const ts = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const slots: any[] = [];
  let cursor = 0;
  let calls = 0;
  let refreshes = 0;
  let response = deferred<Response>();
  const fixture = { id: "modal-doc", originalName: 'Statement "ไทย" <2026>.pdf', createdAt: "2026-01-01", fileSize: 10 };
  const jsx = (type: any, props: any) => ({ type, props });
  const react = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: any) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial: any) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useEffect() {},
  };
  const exported: any = {};
  runInNewContext(ts.transpileModule(archive, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, {
    exports: exported,
    require(name: string) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "lucide-react") return {};
      if (name.endsWith("/auth")) return { useAuth: () => ({ user: { id: "test", accessToken: "test" } }) };
      if (name.endsWith("/document-delete")) return { InFlightDeletionGuard, classifyDeleteDocumentResponse };
      if (name.endsWith("/Documentstorage")) return { getLocalDocumentByName: async () => null };
      if (name.endsWith("/server-api")) return { fetchUserDocuments: async () => [] };
      throw new Error(`Unexpected import ${name}`);
    },
    fetch: () => { calls++; return response.promise; },
  });
  const render = () => { cursor = 0; return exported.default({ onDocumentDeleted: () => { refreshes++; } }); };
  function nodes(tree: any): any[] {
    if (!tree || typeof tree !== "object") return [];
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    return [tree, ...nodes(tree.props?.children)];
  }
  const find = (tree: any, predicate: (node: any) => boolean) => nodes(tree).find(predicate);
  render();
  // Seed the documents/loading/folder hooks instead of running the mount fetch.
  slots[0] = [{ ...fixture, fileName: fixture.originalName, uploadedAt: fixture.createdAt, size: fixture.fileSize }];
  slots[1] = false;
  const folderIndex = slots.findIndex(value => Object.prototype.toString.call(value) === "[object Set]" && value !== slots[2]);
  slots[folderIndex] = new Set(["2026/01"]);
  const trash = (tree: any) => find(tree, node => node.props?.["aria-label"] === "ลบไฟล์");
  const cancel = (tree: any) => find(tree, node => node.type === "button" && node.props.children === "ยกเลิก");
  const confirm = (tree: any) => find(tree, node => node.type === "button" && ["ลบเอกสาร", "กำลังลบ..."].includes(node.props.children));
  trash(render()).props.onClick();
  let tree = render();
  ok(calls === 0 && slots.includes(slots[0][0]), "opening confirmation sends zero DELETE requests");
  ok(find(tree, node => node.props?.id === "statement-delete-message").props.children.includes(fixture.originalName), "confirmation renders the actual filename as text");
  cancel(tree).props.onClick();
  ok(calls === 0, "cancel confirmation sends zero DELETE requests");
  trash(render()).props.onClick();
  tree = render();
  const first = confirm(tree).props.onClick();
  const repeated = confirm(tree).props.onClick();
  tree = render();
  ok(calls === 1, "rapid confirmation clicks send exactly one DELETE");
  ok(confirm(tree).props.disabled && cancel(tree).props.disabled
    && find(tree, node => node.props?.["aria-label"] === "กำลังลบไฟล์").props.disabled,
    "confirm, cancel and row delete are disabled during DELETE");
  response.resolve(new Response(null, { status: 200 }));
  await Promise.all([first, repeated]);
  ok(refreshes === 1, "successful confirmed deletion refreshes the parent once");
  // A failure retains the document and surfaces the existing error message.
  slots[0] = [{ ...fixture, fileName: fixture.originalName, uploadedAt: fixture.createdAt, size: fixture.fileSize }];
  response = deferred<Response>();
  trash(render()).props.onClick();
  const failedDelete = confirm(render()).props.onClick();
  response.resolve(new Response(null, { status: 500 }));
  await failedDelete;
  ok(slots[0].length === 1 && slots[3].length > 0 && refreshes === 1,
    "failed confirmed deletion retains the row and existing error handling");
}

// The old single-global-flag guard that blocked ALL rows is gone from the archive
// (it disabled every delete button whenever any delete was in flight).
ok(
  archive.indexOf("deletingId !== null") === -1 &&
    archive.indexOf("deletingId === doc.id") === -1,
  "StatementArchivePage no longer uses a single global deletingId flag"
);
// The old deletingId STATE variable is fully gone (replaced by per-doc deletingIds).
// After removing all occurrences of "deletingIds" (plural), "deletingId" (singular)
// should not appear anywhere in the source.
ok(
  !archive.replace(/deletingIds/g, "").includes("deletingId"),
  "StatementArchivePage has no old singular deletingId state (only per-document deletingIds)"
);

// ---------------------------------------------------------------------------
console.log("\n------------------------------------------");
console.log(`DOCUMENT DELETE: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
