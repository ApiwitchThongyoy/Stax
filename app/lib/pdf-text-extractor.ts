import { readFile } from "node:fs/promises";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024;

export type PdfTextExtractionResult =
  | { ok: true; text: string; pageCount: number }
  | { ok: false; status: number; message: string };

/**
 * Extract plain text from a PDF file on the server filesystem.
 * Uses pdfjs-dist for text-only extraction (no OCR, no canvas).
 *
 * @param filePath - Absolute path to the PDF file on disk
 * @returns Extracted text or an error result
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
    const pdfjsLib = await import("pdfjs-dist");
    const data = new Uint8Array(buffer);
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const pageCount = doc.numPages;
    const allText: string[] = [];

    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();

      const rowMap = new Map<number, Array<{ x: number; str: string }>>();

      for (const item of content.items) {
        if (!("str" in item) || typeof item.str !== "string" || item.str.trim() === "") continue;
        if (!("transform" in item)) continue;
        const y = item.transform[5] as number;
        const x = item.transform[4] as number;
        const bucketKey = Math.round(y / 3) * 3;
        if (!rowMap.has(bucketKey)) rowMap.set(bucketKey, []);
        rowMap.get(bucketKey)!.push({ x, str: item.str });
      }

      const sortedKeys = Array.from(rowMap.keys()).sort((a, b) => b - a);
      const pageRows: string[] = [];

      for (const key of sortedKeys) {
        const rowItems = rowMap.get(key)!.sort((a, b) => a.x - b.x);
        const rowText = rowItems
          .map((i) => i.str)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (rowText) pageRows.push(rowText);
      }

      allText.push(...pageRows);
    }

    const fullText = allText.join("\n");

    if (fullText.trim().length === 0) {
      return {
        ok: false,
        status: 422,
        message: "PDF contains no extractable text (may be scanned/image-based)",
      };
    }

    return { ok: true, text: fullText, pageCount };
  } catch (error) {
    console.error("extractTextFromPdf: extraction failed", filePath, error);
    return {
      ok: false,
      status: 500,
      message: "Failed to extract text from PDF",
    };
  }
}
