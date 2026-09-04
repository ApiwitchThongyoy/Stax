import { readFile } from "node:fs/promises";
import { getDocumentProxy } from "unpdf";

// ---------------------------------------------------------------------------
// Generic server-side PDF text extraction built on `unpdf`'s serverless PDF.js
// build.
//
// This module is deliberately provider / broker / document agnostic. It turns
// PDF bytes into plain text (plus a faithful reading-order reconstruction of
// each page). It performs NO detection or interpretation of what the document
// represents — no columns, no transaction vocabulary, no currency, no date
// format, no statement structure. All detection and parsing lives downstream
// from here (the current statement parser lives in statement-pipeline.ts), so
// additional broker/provider parsers can be added without replacing this
// engine.
//
// Why this no longer uses pdfjs-dist directly:
//   `pdfjs-dist/legacy/build/pdf.mjs` performs module-level init that uses
//   `createRequire(import.meta.url)` to load @napi-rs/canvas and polyfill
//   globalThis.DOMMatrix / Path2D.  Vercel's file tracer (@vercel/nft)
//   cannot follow `createRequire(import.meta.url)`, so @napi-rs/canvas (and
//   its platform-specific .node binary) may not be included in the serverless
//   function deployment, crashing PDF text extraction at runtime with
//   "ReferenceError: DOMMatrix is not defined".
//
//   `unpdf` (https://github.com/unjs/unpdf) ships a self-contained serverless
//   PDF.js build (`unpdf/pdfjs`) with the worker inlined and browser-specific
//   references stripped.  It bundles its OWN DOMMatrix polyfill and has zero
//   dependency on @napi-rs/canvas or any native binary for TEXT extraction
//   (canvas is only used by unpdf's image-rendering helpers, which this module
//   never calls).  Text extraction therefore works identically locally and on
//   serverless runtimes like Vercel without any native packaging.
// ---------------------------------------------------------------------------

export const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024;

export type PdfTextExtractionResult =
  | { ok: true; text: string; pageCount: number }
  | { ok: false; status: number; message: string };

/** A single positioned text run on a page, in PDF coordinate space. */
export interface PdfTextItem {
  x: number;
  y: number;
  str: string;
}

/** One reconstructed visual line: items on the same baseline, left-to-right. */
export interface PdfTextRow {
  y: number;
  items: PdfTextItem[];
}

/** One page's reconstructed reading order. */
export interface PdfPageText {
  pageNumber: number;
  rows: PdfTextRow[];
}

/**
 * Reconstruct the visual reading order of a page's text items into rows.
 *
 * This is GENERIC PDF layout reconstruction using only the glyph geometry that
 * PDF.js exposes: text items sharing a ~baseline (rounded Y) are grouped into a
 * row, and rows are ordered top-to-bottom while items in a row are ordered
 * left-to-right. It makes no assumptions about columns, tables, currencies,
 * dates, brokers, or what the text means — it only restores the order in which
 * a human would read the rendered page. Downstream parsers are free to further
 * interpret (or ignore) this layout.
 */
function reconstructReadingOrder(content: {
  items: Array<{ str?: string; transform?: number[] }>;
}): PdfTextRow[] {
  const rowMap = new Map<number, PdfTextItem[]>();

  for (const item of content.items) {
    if (typeof item.str !== "string" || item.str.trim() === "") continue;
    if (!Array.isArray(item.transform) || item.transform.length < 6) continue;
    const y = item.transform[5] as number;
    const x = item.transform[4] as number;
    // Bucket by baseline so glyphs on the same visual line share a row.
    const bucketKey = Math.round(y / 3) * 3;
    if (!rowMap.has(bucketKey)) rowMap.set(bucketKey, []);
    rowMap.get(bucketKey)!.push({ x, y, str: item.str });
  }

  const sortedKeys = Array.from(rowMap.keys()).sort((a, b) => b - a);
  const rows: PdfTextRow[] = [];

  for (const key of sortedKeys) {
    const items = rowMap.get(key)!;
    if (items.length === 0) continue;
    items.sort((a, b) => a.x - b.x);
    rows.push({ y: key, items });
  }

  return rows;
}

/** Render rows to a flat, space-joined, whitespace-normalised string. */
function renderRowsToText(rows: PdfTextRow[]): string {
  return rows
    .map((row) =>
      row.items
        .map((i) => i.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Shared: load a document from bytes, run `work`, then release it. */
async function withPdfDocument<T>(
  bytes: Uint8Array,
  work: (doc: Awaited<ReturnType<typeof getDocumentProxy>>) => Promise<T>
): Promise<T> {
  const doc = await getDocumentProxy(bytes);
  try {
    return await work(doc);
  } finally {
    try {
      await doc.loadingTask.destroy();
    } catch {
      // Best-effort cleanup; a destroy failure must not fail extraction.
    }
  }
}

/**
 * Extract the reconstructed reading order (rows of positioned text items) for
 * every page. This is the generic, parser-friendly view of a PDF's text; it
 * exposes the glyph geometry so downstream consumers can do their own layout
 * interpretation without re-reading the PDF or replacing this engine.
 *
 * Validates size / emptiness / PDF magic bytes, mirroring
 * `extractTextFromPdfBytes`.
 */
export async function extractPdfTextRows(
  source: Uint8Array | Buffer
): Promise<
  | { ok: true; pages: PdfPageText[]; pageCount: number }
  | { ok: false; status: number; message: string }
> {
  const buffer = Buffer.from(source);

  if (buffer.length > MAX_PDF_SIZE_BYTES) {
    return {
      ok: false,
      status: 400,
      message: `PDF file exceeds maximum allowed size of ${MAX_PDF_SIZE_BYTES} bytes`,
    };
  }
  if (buffer.length === 0) {
    return { ok: false, status: 400, message: "PDF file is empty" };
  }
  const magic = buffer.slice(0, 5).toString("latin1");
  if (magic !== "%PDF-") {
    return { ok: false, status: 400, message: "File is not a valid PDF" };
  }

  try {
    return await withPdfDocument(new Uint8Array(buffer), async (doc) => {
      const pageCount = doc.numPages;
      const pages: PdfPageText[] = [];
      for (let i = 1; i <= pageCount; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const rows = reconstructReadingOrder(content as {
          items: Array<{ str?: string; transform?: number[] }>;
        });
        pages.push({ pageNumber: i, rows });
      }
      return { ok: true as const, pages, pageCount };
    });
  } catch (error) {
    console.error("extractPdfTextRows: extraction failed", error);
    return { ok: false, status: 500, message: "Failed to extract text from PDF" };
  }
}

/**
 * Extract plain text from PDF bytes.
 * Uses unpdf's serverless PDF.js build for text-only extraction
 * (no OCR, no canvas, no native dependencies).
 *
 * Works with bytes already read from any storage (filesystem, Supabase Storage,
 * etc.) so extraction never depends on a local filesystem path.
 */
export async function extractTextFromPdfBytes(
  source: Uint8Array | Buffer
): Promise<PdfTextExtractionResult> {
  const buffer = Buffer.from(source);

  if (buffer.length > MAX_PDF_SIZE_BYTES) {
    return {
      ok: false,
      status: 400,
      message: `PDF file exceeds maximum allowed size of ${MAX_PDF_SIZE_BYTES} bytes`,
    };
  }

  if (buffer.length === 0) {
    return { ok: false, status: 400, message: "PDF file is empty" };
  }

  const magic = buffer.slice(0, 5).toString("latin1");
  if (magic !== "%PDF-") {
    return { ok: false, status: 400, message: "File is not a valid PDF" };
  }

  try {
    const rowsResult = await extractPdfTextRows(buffer);
    if (!rowsResult.ok) {
      return { ok: false, status: rowsResult.status, message: rowsResult.message };
    }
    const fullText = rowsResult.pages.map((p) => renderRowsToText(p.rows)).join("\n");

    if (fullText.trim().length === 0) {
      return {
        ok: false,
        status: 422,
        message: "PDF contains no extractable text (may be scanned/image-based)",
      };
    }

    return { ok: true, text: fullText, pageCount: rowsResult.pageCount };
  } catch (error) {
    console.error("extractTextFromPdfBytes: extraction failed", error);
    return {
      ok: false,
      status: 500,
      message: "Failed to extract text from PDF",
    };
  }
}

/**
 * Extract plain text from a PDF file on the server filesystem.
 * Kept for backwards compatibility (local files on disk).
 *
 * @param filePath - Absolute path to the PDF file on disk
 */
export async function extractTextFromPdf(
  filePath: string
): Promise<PdfTextExtractionResult> {
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (error) {
    console.error("extractTextFromPdf: failed to read file", filePath, error);
    return { ok: false, status: 500, message: "Failed to read PDF file" };
  }
  return extractTextFromPdfBytes(buffer);
}
