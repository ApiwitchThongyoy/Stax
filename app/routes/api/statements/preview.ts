import { randomUUID } from "node:crypto";
import type { Route } from "./+types/preview";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import {
  findExistingDocumentByHash,
  hasPdfMagicBytes,
  sanitizeOriginalName,
  validatePdfFile,
} from "~/lib/storage/statement-storage";
import { computeContentHash, buildDuplicatePayload } from "~/lib/statement-hash";
import {
  extractTextFromPdfBytes,
  setCachedPdfText,
} from "~/lib/pdf-text-extractor";
import {
  applyFxRateFallback,
  buildStatementTransactions,
  hasSavedDocumentRows,
  loadCostBasisState,
  summarizeRows,
} from "~/lib/statement-pipeline";
import { buildStatementJournalEntries } from "~/lib/posting-engine";
import { resolveHistoricalFxRate } from "~/lib/historical-fx-provider";

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

/**
 * External HISTORICAL FX fallback used by the preview pipeline: cache-first
 * (same strategy as the real upload), so the preview numbers match the numbers
 * the commit will produce. Statement FX always wins; provider failures return
 * null and never break a preview.
 */
const fxFallback = {
  resolve(rateDate: string, currency: string) {
    return resolveHistoricalFxRate(rateDate, currency);
  },
};

export async function loader(_: Route.LoaderArgs) {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

/**
 * POST /api/v1/statements/preview
 *
 * Read-only import preview: validates the uploaded PDF, extracts its text,
 * runs the SAME deterministic parse/validation pipeline as the real upload, and
 * computes the import diagnostics — but NEVER writes anything:
 *  - no storage object, no documents row
 *  - no Capital_Transactions rows
 *  - no cost_basis_state write
 *  - no ledger postings, no Gemini call (deferred to the real import)
 *
 * The response carries the full validated rows so the client can render a
 * server-authoritative detail table before the user commits with OK.
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405 }
    );
  }

  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json(
      { success: false, message: "Invalid multipart form data" },
      { status: 400 }
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Response.json(
      { success: false, message: "A PDF file must be provided in the 'file' field" },
      { status: 400 }
    );
  }

  const validation = validatePdfFile(file);
  if (!validation.ok) {
    return Response.json(
      { success: false, message: validation.message },
      { status: 400 }
    );
  }

  try {
    if (!(await hasPdfMagicBytes(file))) {
      return Response.json(
        { success: false, message: "File content is not a valid PDF" },
        { status: 400 }
      );
    }
  } catch {
    return Response.json(
      { success: false, message: "File content is not a valid PDF" },
      { status: 400 }
    );
  }

  // User-scoped duplicate detection (same key as the real upload). A document
  // that already has saved rows can only yield "already imported"; a document
  // whose rows were deleted is re-importable and gets a rebuild preview.
  const contentHash = computeContentHash(
    new Uint8Array(await file.arrayBuffer())
  );
  const existingDocument = await findExistingDocumentByHash(
    auth.userId,
    contentHash
  );
  if (existingDocument) {
    if (await hasSavedDocumentRows(auth.userId, existingDocument.id)) {
      return Response.json({
        success: true,
        data: buildDuplicatePayload(existingDocument.id),
      });
    }
  }

  const fileName = sanitizeOriginalName(file.name);

  let extraction;
  try {
    extraction = await extractTextFromPdfBytes(
      new Uint8Array(await file.arrayBuffer())
    );
  } catch (extractError) {
    console.error("Statement preview: extractTextFromPdfBytes threw", extractError);
    return Response.json(
      { success: false, message: "Failed to extract text from the PDF" },
      { status: 500 }
    );
  }
  if (!extraction.ok) {
    return Response.json(
      { success: false, message: extraction.message },
      { status: extraction.status }
    );
  }

  setCachedPdfText(contentHash, {
    text: extraction.text,
    pageCount: extraction.pageCount,
  });

  // Deterministic in-memory pipeline. The documentId below is preview-only:
  // it links the rows the UI shows, never persisted (the real import generates
  // its own id / reuses the existing one on a rebuild).
  const previewDocumentId = existingDocument?.id ?? randomUUID();
  const costBasis = await loadCostBasisState(auth.userId);
  const built = buildStatementTransactions(
    extraction.text,
    auth.userId,
    previewDocumentId,
    costBasis
  );

  const fallbackRows = await applyFxRateFallback(built.rows, fxFallback);

  // Pure, read-only journal preview: figure out which rows WOULD become POSTED
  // journal entries and which would be recorded as SKIPPED, without touching
  // the DB (no account resolution / CoA seeding — those commit-time checks can
  // only downgrade a POSTED row to SKIPPED, never the reverse).
  const journalPreview = (() => {
    const entries = buildStatementJournalEntries(fallbackRows);
    const skipped = entries
      .filter((e) => e.postingState === "SKIPPED")
      .map((e) => ({
        transactionId: e.transactionId,
        reason: e.reason ?? e.entry.skipReason ?? "skipped",
      }));
    return {
      postedCount: entries.length - skipped.length,
      skippedCount: skipped.length,
      skipped,
      commitNote:
        "preview only: account-currency checks are enforced at commit time",
    };
  })();

  if (fallbackRows.length === 0) {
    return Response.json({
      success: true,
      data: {
        preview: true,
        fileName,
        documentId: existingDocument?.id ?? null,
        duplicate: false,
        duplicateDecision: "unsupported",
        extracted: built.extractedCount,
        rows: [],
        rejected: built.rejections,
        stats: summarizeRows([]),
        postingPreview: journalPreview,
      },
    });
  }

  return Response.json({
    success: true,
    data: {
      preview: true,
      fileName,
      documentId: existingDocument?.id ?? null,
      duplicate: false,
      duplicateDecision: existingDocument ? "rebuilt" : "fresh",
      extracted: built.extractedCount,
      rows: fallbackRows,
      rejected: built.rejections,
      stats: summarizeRows(fallbackRows),
      postingPreview: journalPreview,
    },
  });
}