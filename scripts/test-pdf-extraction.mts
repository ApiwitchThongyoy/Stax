// Server-side PDF extraction regression tests — DB-free, no browser.
//
// Verifies that:
//   1. @napi-rs/canvas is importable and exposes DOMMatrix / Path2D
//   2. pdf-text-extractor.ts eagerly sets globalThis.DOMMatrix and Path2D
//   3. extractTextFromPdfBytes successfully extracts text from a real PDF
//      (the same makePdf helper used in run-tests.mts)
//   4. DOMMatrix remains defined after pdfjs-dist module initialization
//
// Run:  npx tsx scripts/test-pdf-extraction.mts
import { extractTextFromPdfBytes } from "../app/lib/pdf-text-extractor";

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

// Minimal single-page PDF builder (same logic as run-tests.mts)
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

async function main() {
  console.log("\n=== SERVER-SIDE PDF EXTRACTION (DOMMatrix polyfill regression) ===\n");

  // 1. @napi-rs/canvas is importable and exposes DOMMatrix + Path2D
  try {
    const canvas = await import("@napi-rs/canvas");
    ok(typeof canvas.DOMMatrix === "function", "@napi-rs/canvas exports DOMMatrix constructor");
    ok(typeof canvas.Path2D === "function", "@napi-rs/canvas exports Path2D constructor");
  } catch (e) {
    ok(false, `@napi-rs/canvas is importable: ${e}`);
  }

  // 2. After importing pdf-text-extractor, globals are set
  // (The module-level await in pdf-text-extractor.ts runs on import.)
  ok(
    typeof globalThis.DOMMatrix === "function",
    "globalThis.DOMMatrix is set after pdf-text-extractor import"
  );
  ok(
    typeof globalThis.Path2D === "function",
    "globalThis.Path2D is set after pdf-text-extractor import"
  );

  // 3. extractTextFromPdfBytes extracts text from a valid PDF
  const pdfBytes = makePdf([
    "USD/THB = 31.055",
    "TRADE RECORDS",
    "GOOG",
    "30/01/2026 10:00:00,GMT+07 30/01/2026 BUY 10 150.00 1500.00 -1500.25 -0.15 -0.10 NASDAQ",
    "PORTFOLIO SUMMARY",
    "GOOG",
    "10 1 150.00 1500.00 160.00 100.00 USD NASDAQ",
  ]);

  const result = await extractTextFromPdfBytes(pdfBytes);
  ok(result.ok === true, "extractTextFromPdfBytes succeeds on valid PDF");
  if (result.ok) {
    ok(result.pageCount === 1, "pageCount is 1");
    ok(
      result.text.includes("USD/THB = 31.055"),
      "extracted text contains header line"
    );
    ok(
      result.text.includes("GOOG"),
      "extracted text contains symbol GOOG"
    );
    ok(
      result.text.includes("TRADE RECORDS"),
      "extracted text contains section header"
    );
  }

  // 4. DOMMatrix still defined after extraction (pdfjs-dist init didn't break it)
  ok(
    typeof globalThis.DOMMatrix === "function",
    "globalThis.DOMMatrix still defined after pdfjs-dist usage"
  );

  // 5. Edge cases: empty buffer
  const emptyResult = await extractTextFromPdfBytes(new Uint8Array(0));
  ok(emptyResult.ok === false && emptyResult.status === 400, "empty buffer returns 400");

  // 6. Edge cases: invalid magic bytes
  const badMagic = new Uint8Array([0, 1, 2, 3, 4]);
  const badResult = await extractTextFromPdfBytes(badMagic);
  ok(badResult.ok === false && badResult.status === 400, "invalid magic bytes returns 400");

  // 7. Oversized buffer rejection
  const hugeBuf = Buffer.alloc(20 * 1024 * 1024 + 1, 0x20);
  const hugeResult = await extractTextFromPdfBytes(hugeBuf);
  ok(hugeResult.ok === false && hugeResult.status === 400, "oversized PDF returns 400");

  // Summary
  console.log(`\n  Total: ${passed + failed} | PASS: ${passed} | FAIL: ${failed}`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(`    - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
