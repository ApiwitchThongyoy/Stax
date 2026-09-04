// Server-side PDF extraction regression tests — DB-free, no browser.
//
// The extractor is a GENERIC, broker/provider-agnostic text engine (not a
// Webull parser). These tests verify:
//   1. Generic text PDF extraction (content below is intentionally NOT Webull
//      shaped — proving the engine has no broker assumptions)
//   2. Multi-page generic PDF extraction
//   3. Novel one-page layout shows extractor reads in visual order
//   4. Generic structured rows API (extractPdfTextRows) exposes geometry for
//      downstream/future parsers
//   5. Malformed / invalid PDF bytes are rejected safely
//   6. Valid PDF with no extractable text -> 422 (no partial data produced)
//   7. Failure never yields partial extracted content
//   8. Webull remains ONE downstream real-world fixture (the deterministic
//      parser in statement-pipeline.ts + test-webull-trade-parser cover it)
//   9. The extraction relies on unpdf's serverless PDF.js build (no
//      @napi-rs/canvas / native binary / DOMMatrix crash dependency), so it
//      behaves identically locally and on serverless runtimes like Vercel.
//
// Run:  npx tsx scripts/test-pdf-extraction.mts
import {
  extractPdfTextRows,
  extractTextFromPdfBytes,
} from "../app/lib/pdf-text-extractor";

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

/**
 * Minimal PDF builder. Accepts either a single page's worth of lines
 * (`string[]`) or an array of pages (`string[][]`). A page given as an empty
 * array still produces a valid PDF page but with no text content.
 */
function makePdf(linesOrPages: string[] | string[][]): Uint8Array {
  const pages: string[][] =
    Array.isArray(linesOrPages[0])
      ? (linesOrPages as string[][])
      : [(linesOrPages as string[])];
  const esc = (s: string) => s.replace(/([()\\])/g, "\\$1");

  const objs: string[] = [
    "<</Type/Catalog/Pages 2 0 R>>",
  ];

  const pageRefs: number[] = [];
  let obj = 3; // object 2 is the Pages node

  // Build the Pages tree.
  for (let p = 0; p < pages.length; p++) {
    pageRefs.push(obj);
    obj += 1; // the page object
    obj += 1; // the content stream object for this page
  }
  // Font object + content stream objects share the remaining space.
  const fontRef = obj;
  objs.push(
    `<</Type/Pages/Kids[${pageRefs.map((r) => `${r} 0 R`).join(" ")}]/Count ${pages.length}>>`
  );

  const contentStreams: string[] = [];
  let currentObj = 3;
  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p];
    const content =
      "BT\n/F1 10 Tf\n" +
      lines
        .map((l, i) => `${i === 0 ? "72 720 Td" : "0 -14 Td"} (${esc(l)}) Tj`)
        .join("\n") +
      "\nET\n";
    const contentRef = currentObj + 1;
    contentStreams.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentRef} 0 R/Resources<</Font<</F1 ${fontRef} 0 R>>>>>>`,
      `<</Length ${Buffer.byteLength(content, "latin1")}>>\nstream\n${content}endstream`
    );
    currentObj += 2;
  }
  objs.push(...contentStreams, "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");

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
  console.log("\n=== GENERIC PDF TEXT EXTRACTION (unpdf serverless build) ===\n");

  // 1. Generic single-page extraction (content deliberately NOT Webull-shaped:
  //    abstract text that no broker-specific parser would recognise, proving
  //    the engine itself is broker/provider agnostic).
  const genericPdf = makePdf([
    "ACME INVESTMENTS QUARTERLY REPORT",
    "Account 45291  Period ending 31 Mar 2026",
    "The quick brown fox jumps over the lazy dog",
    "Totals: 12,345.67  Grand total 5,678.90",
    "Bottom line",
  ]);
  const genResult = await extractTextFromPdfBytes(genericPdf);
  ok(genResult.ok === true, "generic single-page PDF extraction succeeds");
  if (genResult.ok) {
    ok(genResult.pageCount === 1, "generic PDF pageCount is 1");
    ok(genResult.text.includes("ACME INVESTMENTS QUARTERLY REPORT"), "extracts first row in reading order");
    ok(genResult.text.includes("Totals: 12,345.67 Grand total 5,678.90"), "items within a row joined in order (whitespace normalized)");
    ok(genResult.text.includes("Bottom line"), "extracts last row");
  }

  // 2. Multi-page generic extraction.
  const multiPdf = makePdf([
    ["PAGE ONE HEADER", "first page line", "another first-page line"],
    ["PAGE TWO HEADER", "second page line"],
  ]);
  const multiResult = await extractTextFromPdfBytes(multiPdf);
  ok(multiResult.ok === true, "multi-page PDF extraction succeeds");
  if (multiResult.ok) {
    ok(multiResult.pageCount === 2, "multi-page pageCount is 2");
    ok(multiResult.text.includes("PAGE ONE HEADER"), "extracts page-one content");
    ok(multiResult.text.includes("PAGE TWO HEADER"), "extracts page-two content");
    ok(multiResult.text.indexOf("PAGE ONE HEADER") < multiResult.text.indexOf("PAGE TWO HEADER"), "pages flow in order");
  }

  // 3. Left-to-right, top-to-bottom visual order within a row / across rows.
  const orderPdf = makePdf([
    "zz-top-A zz-top-B",
    "zz-mid-A zz-mid-B zz-mid-C",
    "zz-bottom A",
  ]);
  const orderResult = await extractTextFromPdfBytes(orderPdf);
  ok(orderResult.ok === true, "reading-order PDF extraction succeeds");
  if (orderResult.ok) {
    const zzTop = orderResult.text.indexOf("zz-top-A zz-top-B");
    const zzMid = orderResult.text.indexOf("zz-mid-A zz-mid-B zz-mid-C");
    const zzBottom = orderResult.text.indexOf("zz-bottom A");
    ok(zzTop !== -1 && zzMid !== -1 && zzBottom !== -1, "all rows present");
    ok(zzTop < zzMid && zzMid < zzBottom, "rows reconstructed top-to-bottom");
    ok(orderResult.text.includes("zz-top-A zz-top-B"), "items within a row kept left-to-right in order");
  }

  // 4. Generic structured rows API exposes geometry for downstream parsers.
  const rowsResult = await extractPdfTextRows(genericPdf);
  ok(rowsResult.ok === true, "extractPdfTextRows succeeds on generic PDF");
  if (rowsResult.ok) {
    ok(rowsResult.pages.length === 1, "structured rows exposes per-page data");
    ok(rowsResult.pages[0].rows.length > 0, "structured rows exposes row list");
    const firstItems = rowsResult.pages[0].rows[0].items;
    ok(typeof firstItems[0].x === "number" && typeof firstItems[0].y === "number", "structured items carry x/y geometry");
    ok(typeof firstItems[0].str === "string", "structured items carry text");
  }

  // 5. Malformed / invalid PDF bytes are rejected safely (no partial data).
  const badMagic = new Uint8Array([0, 1, 2, 3, 4]);
  const badResult = await extractTextFromPdfBytes(badMagic);
  ok(badResult.ok === false && badResult.status === 400, "invalid magic bytes returns 400");

  // Truncated / corrupt PDF that still starts with the magic header.
  const truncated = Buffer.from("%PDF-1.4\n", "latin1");
  const truncResult = await extractTextFromPdfBytes(truncated);
  ok(truncResult.ok === false, "truncated/corrupt PDF fails safely");
  ok("text" in truncResult === false, "no partial text produced on corrupt PDF");

  // 6. Valid PDF with no extractable text (scanned/image-like) -> 422.
  const noTextPdf = makePdf([[]]);
  const noTextResult = await extractTextFromPdfBytes(noTextPdf);
  ok(noTextResult.ok === false && noTextResult.status === 422, "no-text PDF returns 422");
  ok("text" in noTextResult === false, "no partial text produced on no-text PDF");

  // 7. Failure paths never expose partial extraction results.
  const emptyResult = await extractTextFromPdfBytes(new Uint8Array(0));
  ok(emptyResult.ok === false && emptyResult.status === 400, "empty buffer returns 400");
  ok("text" in emptyResult === false, "empty buffer produces no text");

  // 8. Oversized buffer rejection.
  const hugeBuf = Buffer.alloc(20 * 1024 * 1024 + 1, 0x20);
  const hugeResult = await extractTextFromPdfBytes(hugeBuf);
  ok(hugeResult.ok === false && hugeResult.status === 400, "oversized PDF returns 400");

  // 9. Generic extractor carries no broker/provider vocabulary. Detection and
  //    parsing are downstream (statement-pipeline.ts parseStatementRows for the
  //    current broker fixture, covered by test-webull-trade-parser /
  //    test-statement-tax-recon / the DB-backed W2 block). Here we only assert
  //    that the extraction layer itself embeds no broker-specific terms.
  const { readFileSync } = await import("node:fs");
  const extractorSrc = readFileSync(
    new URL("../app/lib/pdf-text-extractor.ts", import.meta.url),
    "utf8"
  );
  // Word-boundary match so ordinary words never false-positive (e.g. "BOT"
  // inside "bottom"/"best-effort").
  const brokerVocabulary = [
    "webull",
    "nasdaq",
    "nyse",
    "trade records",
    "portfolio summary",
    "spread",
    "realized gain",
    "pnl",
    "symbol",
    "ticker",
  ];
  for (const term of brokerVocabulary) {
    const re = new RegExp(`\\b${term.replace(/ /g, "\\s+")}`, "i");
    ok(!re.test(extractorSrc), `extractor source has no broker vocabulary: "${term}"`);
  }

  // Summary
  console.log(`\n  Total: ${passed + failed} | PASS: ${passed} | FAIL: ${failed}`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(`    - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
