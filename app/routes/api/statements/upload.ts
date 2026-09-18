import type { Route } from "./+types/upload";
import { eq, and } from "drizzle-orm";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import {
  saveStatementPdf,
  findExistingDocumentByHash,
  deleteStoredFile,
  validatePdfFile,
  hasPdfMagicBytes,
} from "~/lib/storage/statement-storage";
import { db } from "~/lib/drizzle-db";
import { documents } from "~/db/schema";
import { computeContentHash, buildDuplicatePayload } from "~/lib/statement-hash";
import { extractTextFromPdfBytes } from "~/lib/pdf-text-extractor";
import {
  buildStatementTransactions,
  applyFxRateFallback,
  hasSavedDocumentRows,
  loadCostBasisState,
  summarizeRows,
  type ValidatedCapitalRow,
} from "~/lib/statement-pipeline";
import { insertStatementImport, reconcileStatementImport } from "~/lib/ledger-service";
import { resolveHistoricalFxRate } from "~/lib/historical-fx-provider";
import {
  parseStatementWithGemini,
  isGeminiConfigured,
  GeminiError,
  GeminiErrorCode,
  type GeminiStatementResult,
  type GeminiErrorCodeValue,
} from "~/lib/gemini-statement-parser";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";
import {
  notifyStatementUploaded,
  notifyStatementImported,
  notifyStatementDuplicate,
  notifyAnalysisComplete,
} from "~/lib/notification-service";

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

/**
 * The set of tickers touched by a just-imported statement. The deterministic
 * ledger reconcile only needs to recompute these symbols' SELL rows + journal
 * postings; the cost-basis cache is rebuilt in full either way.
 */
function affectedSymbolsOf(rows: ValidatedCapitalRow[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (row.symbol && row.symbol.trim() !== "") {
      out.add(row.symbol.trim().toUpperCase());
    }
  }
  return out;
}

/**
 * External HISTORICAL FX fallback used by the import pipeline: cache-first
 * (DB cache, then the keyless provider). Only consulted for non-THB rows that
 * carry NO statement rate; statement FX always wins. Provider failures return
 * null and never break an import.
 */
const fxFallback = {
  resolve(rateDate: string, currency: string) {
    return resolveHistoricalFxRate(rateDate, currency);
  },
};

/**
 * Shape of the `ai` field returned in the upload response so the UI can render
 * a truthful Gemini state from a real backend result.
 *  - success: source "gemini" + the locally validated structured result.
 *  - failure: source "unavailable" + a stable machine-readable code + messages.
 * Never exposes the API key. Malformed AI output is rejected server-side and
 * never reaches this payload (it surfaces as a failure code instead).
 */
export type UploadAiResult =
  | { source: "gemini"; code: null; result: GeminiStatementResult }
  | { source: "unavailable"; code: GeminiErrorCodeValue; errors: string[] };

/**
 * Run Gemini structured analysis on the extracted statement text when Gemini is
 * configured. Never throws — on any failure it returns a clear "not available"
 * state and logs an audit event, so a Gemini problem can never break the
 * existing deterministic upload flow. The Gemini result is for preview/analysis
 * only; it is not inserted and never decides final tax.
 */
async function runGeminiAnalysis(
  text: string,
  userId: string,
  documentId: string
): Promise<UploadAiResult> {
  if (!isGeminiConfigured()) {
    return {
      source: "unavailable",
      code: GeminiErrorCode.NOT_CONFIGURED,
      errors: ["Gemini integration is not configured (GEMINI_API_KEY is missing)"],
    };
  }

  try {
    const outcome = await parseStatementWithGemini(text);
    await insertAuditLog({
      userId,
      action: AuditAction.GEMINI_PARSE,
      entityType: "Capital_Transactions",
      entityId: documentId,
      details: {
        source: "gemini",
        model: outcome.model,
        transactionCount: outcome.result.statement.transactions.length,
        warningCount: outcome.result.statement.warnings.length,
      },
    });
    return { source: "gemini", code: null, result: outcome.result };
  } catch (error) {
    const code =
      error instanceof GeminiError ? error.code : GeminiErrorCode.REQUEST_FAILED;
    // Server-side only: surface the sanitized cause (type, optional HTTP status,
    // low-level cause code) for diagnosis. Never log the API key, auth headers,
    // or statement text. The browser payload below stays generic.
    const sanitized =
      error instanceof GeminiError && error.cause
        ? {
            upstreamType: error.cause.type,
            upstreamStatus: error.cause.status ?? undefined,
            causeCode: error.cause.code ?? undefined,
          }
        : undefined;
    console.error("runGeminiAnalysis: failed", code, sanitized ?? "");
    await insertAuditLog({
      userId,
      action: AuditAction.GEMINI_PARSE_FAILED,
      entityType: "Capital_Transactions",
      entityId: documentId,
      details: sanitized ? { code, ...sanitized } : { code },
    }).catch(() => {});
    return {
      source: "unavailable",
      code,
      errors: [
        code === GeminiErrorCode.NOT_CONFIGURED
          ? "Gemini integration is not configured (GEMINI_API_KEY is missing)"
          : "Gemini analysis is not available",
      ],
    };
  }
}

/**
 * Journal stats for the remaining "posting" transport shape. The journal is now
 * written ATOMICALLY with the Capital_Transactions rows (insertStatementImport),
 * so any row that could not be posted is recorded as a SKIPPED entry IN the
 * journal (never silently dropped, never written outside the transaction).
 * skippedWrite stays [] — a write-level failure can no longer happen "after"
 * a committed import (it would roll the whole import back instead).
 */
function toPostingView(journal: {
  postedCount: number;
  entryNumbers: number[];
  skipped: { transactionId: string; reason: string }[];
}) {
  return {
    posted: journal.postedCount,
    entryNumbers: journal.entryNumbers,
    skippedRows: journal.skipped.length,
    skippedWrite: [],
    skipped: journal.skipped.map((s) => ({ transactionId: s.transactionId, reason: s.reason })),
  };
}

/**
 * Re-import/rebuild path for a document whose derived ledger rows were deleted.
 *
 * Re-extracts the text from the uploaded bytes (identical content hash), re-parses,
 * then re-inserts the authoritative Capital_Transactions rows under the EXISTING
 * document id (no second document row, no new storage object, no duplicate rows).
 * The cost-basis cache is only rewritten AFTER the rows are committed. If the
 * re-uploaded file is NOT importable (extraction failed or re-parse yields no
 * rows), the stable duplicate payload is returned so files that have nothing to
 * restore keep their previous idempotent response instead of a hard error.
 */
async function rebuildStatementImport(input: {
  userId: string;
  file: File;
  documentId: string;
  fileName: string;
  contentHash: string;
}): Promise<Response> {
  const { userId, file, documentId, fileName, contentHash } = input;

  const duplicateResponse = async (): Promise<Response> => {
    await insertAuditLog({
      userId,
      action: AuditAction.STATEMENT_UPLOAD,
      entityType: "documents",
      entityId: documentId,
      details: {
        route: "/api/v1/statements/upload",
        method: "POST",
        result: "duplicate",
        contentHash,
      },
    });
    await notifyStatementDuplicate(userId, fileName, documentId);
    return Response.json({
      success: true,
      data: buildDuplicatePayload(documentId),
    });
  };

  let extraction;
  try {
    extraction = await extractTextFromPdfBytes(new Uint8Array(await file.arrayBuffer()));
  } catch (extractError) {
    console.error("Statement rebuild: extractTextFromPdfBytes threw", extractError);
    return duplicateResponse();
  }
  if (!extraction.ok) {
    return duplicateResponse();
  }

  const costBasis = await loadCostBasisState(userId);
  const built = buildStatementTransactions(
    extraction.text,
    userId,
    documentId,
    costBasis
  );

  if (built.rows.length === 0) {
    return duplicateResponse();
  }

  // External historical FX fallback (statement rate absent only); never throws,
  // never invents a rate. Rebuild path keeps the same idempotent document id.
  const fallbackRows = await applyFxRateFallback(built.rows, fxFallback);

  const aiResult = await runGeminiAnalysis(extraction.text, userId, documentId);
  if (aiResult.source === "gemini") {
    await notifyAnalysisComplete(userId, fileName, documentId);
  }

  // Insert authority FIRST (rows AND their journal entries commit atomically),
  // then reconcile the derived state deterministically from the final ledger
  // (affected SELL gains + journal postings + full cost-basis cache rebuild).
  // Best-effort: a reconcile failure must not surface as a 500 once the rows
  // are committed.
  const result = await insertStatementImport(userId, fallbackRows);
  try {
    await reconcileStatementImport(userId, affectedSymbolsOf(fallbackRows));
  } catch (reconcileError) {
    console.error("Statement rebuild: ledger reconcile failed", reconcileError);
  }

  // The journal was written inside the same transaction as the rows above
  // (every row -> POSTED or SKIPPED journal entry). Nothing left to post here.
  const posting = toPostingView(result.journal);

  const stats = summarizeRows(fallbackRows);
  await insertAuditLog({
    userId,
    action: AuditAction.STATEMENT_IMPORT,
    entityType: "Capital_Transactions",
    entityId: documentId,
    details: {
      route: "/api/v1/statements/upload",
      method: "POST",
      result: "reimported",
      insertedCount: result.insertedCount,
      stats,
      posting: {
        posted: posting.posted,
        skippedRows: posting.skippedRows,
        skippedWrite: posting.skippedWrite.length,
      },
    },
  });
  await notifyStatementImported(userId, fileName, result.insertedCount, documentId);

  return Response.json({
    success: true,
    data: {
      documentId,
      fileName,
      extracted: built.extractedCount,
      saved: result.insertedCount,
      transactionIds: result.transactionIds,
      rejected: built.rejections,
      rebuilt: true,
      duplicateDecision: "rebuilt",
      stats,
      posting: {
        posted: posting.posted,
        entryNumbers: posting.entryNumbers,
        skippedRows: posting.skippedRows,
        skippedWrite: posting.skippedWrite.length,
        skipped: posting.skipped,
      },
      ai: aiResult,
    },
  });
}

export async function loader(_: Route.LoaderArgs) {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

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

  // 1. Validate BEFORE reading the full file — size + extension + MIME metadata,
  //    then a small header slice for %PDF- magic bytes. Only after validation
  //    passes do we load the full file into memory for hashing / extraction.
  const validation = validatePdfFile(file);
  if (!validation.ok) {
    return Response.json(
      { success: false, message: validation.message },
      { status: 400 }
    );
  }

  let isValidPdf: boolean;
  try {
    isValidPdf = await hasPdfMagicBytes(file);
  } catch {
    isValidPdf = false;
  }
  if (!isValidPdf) {
    return Response.json(
      { success: false, message: "File is not a valid PDF (missing %PDF- header)" },
      { status: 400 }
    );
  }

  // 2. Content-hash dedup BEFORE storing anything, so a re-uploaded Statement
  //    never creates an orphaned file/document row. The full file is read only
  //    now that validation has passed (safe for memory + fast-fail on bad input).
  const contentHash = computeContentHash(
    new Uint8Array(await file.arrayBuffer())
  );
  const existingDocument = await findExistingDocumentByHash(
    auth.userId,
    contentHash
  );
  if (existingDocument) {
    if (await hasSavedDocumentRows(auth.userId, existingDocument.id)) {
      await insertAuditLog({
        userId: auth.userId,
        action: AuditAction.STATEMENT_UPLOAD,
        entityType: "documents",
        entityId: existingDocument.id,
        details: {
          route: "/api/v1/statements/upload",
          method: "POST",
          result: "duplicate",
          contentHash,
        },
      });
      await notifyStatementDuplicate(
        auth.userId,
        existingDocument.originalName ?? "Statement",
        existingDocument.id
      );
      return Response.json({
        success: true,
        data: buildDuplicatePayload(existingDocument.id),
      });
    }
    // Rebuild path: re-extract + re-insert under the EXISTING document id.
    // Wrapped in try-catch so a DB failure (loadCostBasisState / insertStatementImport)
    // returns a clean 500 instead of crashing; no new storage object was created
    // in this path, so there is nothing to clean up on failure.
    try {
      return await rebuildStatementImport({
        userId: auth.userId,
        file,
        documentId: existingDocument.id,
        fileName: existingDocument.originalName ?? "Statement",
        contentHash,
      });
    } catch (rebuildError) {
      console.error("Statement upload: rebuild failed", {
        documentId: existingDocument.id,
        errorName:
          rebuildError instanceof Error
            ? rebuildError.name
            : "UnknownError",
      });
      return Response.json(
        { success: false, message: "Internal server error" },
        { status: 500 }
      );
    }
  }

  // Extract before creating metadata/storage: corrupt or textless PDFs must
  // not leave a document behind when extraction returns an error response.
  let extraction;
  try {
    extraction = await extractTextFromPdfBytes(new Uint8Array(await file.arrayBuffer()));
  } catch (extractError) {
    console.error("Statement upload: text extraction failed", {
      errorName: extractError instanceof Error ? extractError.name : "UnknownError",
    });
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

  // 3. Store the PDF (UUID filename) and record it in the documents table.
  //    Validation (size/ext/MIME/magic bytes) was already done above before the
  //    full-file read. saveStatementPdf repeats validation defensively.
  let stored;
  try {
    stored = await saveStatementPdf({ userId: auth.userId, file });
  } catch (error) {
    // Concurrent duplicate guard: the partial unique index can reject a second
    // simultaneous upload of the same PDF (postgres unique violation 23505).
    // Treat it as a duplicate, not a server failure.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505"
    ) {
      return Response.json({
        success: true,
        data: buildDuplicatePayload(null),
      });
    }
    throw error;
  }
  if (!stored.ok) {
    return Response.json(
      { success: false, message: stored.message },
      { status: stored.status }
    );
  }

  const documentId = stored.document.id;
  const fileName = stored.document.originalName;

  await insertAuditLog({
    userId: auth.userId,
    action: AuditAction.STATEMENT_UPLOAD,
    entityType: "documents",
    entityId: documentId,
    details: {
      route: "/api/v1/statements/upload",
      method: "POST",
      result: "uploaded",
    },
  });

  await notifyStatementUploaded(auth.userId, fileName, documentId);

  try {
    // 5. Parse + validate into Capital_Transactions rows. Seed the
    //    server-authoritative running-average cost basis from previous imports
    //    and persist the updated state after a successful build (so SELL
    //    realized gain/loss stays computable across statements/months).
    const costBasis = await loadCostBasisState(auth.userId);
    const built = buildStatementTransactions(
      extraction.text,
      auth.userId,
      documentId,
      costBasis
    );

    // 5a. External historical FX fallback (only for rows WITHOUT a statement
    //     rate; statement FX always wins). Graceful — never throws, never
    //     invents a rate, never changes row count.
    const fallbackRows = await applyFxRateFallback(built.rows, fxFallback);

    // 5b. Gemini structured analysis (best-effort, for preview only).
    const aiResult = await runGeminiAnalysis(
      extraction.text,
      auth.userId,
      documentId
    );

    if (aiResult.source === "gemini") {
      await notifyAnalysisComplete(auth.userId, fileName, documentId);
    }

    if (built.rows.length === 0) {
      return Response.json({
        success: true,
        data: {
          documentId,
          fileName,
          extracted: built.extractedCount,
          saved: 0,
          rejected: built.rejections,
          unsupported: true,
          duplicateDecision: "unsupported",
          stats: summarizeRows([]),
          ai: aiResult,
        },
      });
    }

    // 6. Duplicate protection: if this document was already saved for this user, skip.
    if (await hasSavedDocumentRows(auth.userId, documentId)) {
      return Response.json({
        success: true,
        data: {
          documentId,
          fileName,
          extracted: built.extractedCount,
          saved: 0,
          duplicates: true,
          rejected: [],
          ai: aiResult,
        },
      });
    }

    // 7. Atomic insert into Capital_Transactions + journal_entries (every row
    //    gets its POSTED or SKIPPED journal entry in the SAME transaction) —
    //    the authoritative SSOT step.
    const result = await insertStatementImport(auth.userId, fallbackRows);

    // 7a. Reconcile ALL derived state deterministically from the final ledger:
    //     recompute the affected SELL gains + journal postings and rebuild the
    //     cost-basis cache from the committed rows + corporate actions — a pure
    //     function of the row set, so a later delete + re-import of this (or an
    //     interleaved) statement converges to the same state as a clean import.
    //     Best-effort — a reconcile failure must not fail the committed import.
    try {
      await reconcileStatementImport(auth.userId, affectedSymbolsOf(fallbackRows));
    } catch (reconcileError) {
      console.error("Statement upload: ledger reconcile failed", reconcileError);
    }

    // 7b. The journal was written inside the same transaction as the rows above
    //     (every row -> POSTED or SKIPPED journal entry). Nothing more to post.
    const posting = toPostingView(result.journal);

    await insertAuditLog({
      userId: auth.userId,
      action: AuditAction.STATEMENT_IMPORT,
      entityType: "Capital_Transactions",
      entityId: documentId,
      details: {
        route: "/api/v1/statements/upload",
        method: "POST",
        result: "imported",
        insertedCount: result.insertedCount,
        stats: summarizeRows(fallbackRows),
        posting: {
          posted: posting.posted,
          skippedRows: posting.skippedRows,
          skippedWrite: posting.skippedWrite.length,
        },
      },
    });

    await notifyStatementImported(auth.userId, fileName, result.insertedCount, documentId);

    return Response.json({
      success: true,
      data: {
        documentId,
        fileName,
        extracted: built.extractedCount,
        saved: result.insertedCount,
        transactionIds: result.transactionIds,
        rejected: built.rejections,
        rebuilt: false,
        duplicateDecision: "fresh",
        stats: summarizeRows(fallbackRows),
        posting: {
          posted: posting.posted,
          entryNumbers: posting.entryNumbers,
          skippedRows: posting.skippedRows,
          skippedWrite: posting.skippedWrite.length,
          skipped: posting.skipped,
        },
        ai: aiResult,
      },
    });
  } catch (error) {
    console.error("Statement upload: processing failed", error);
    // Best-effort cleanup: an upload whose DB/import pipeline failed should not
    // leave an orphaned storage object or a metadata row that would later block
    // a clean re-upload via content-hash dedup. Both removals are best-effort —
    // failures are logged, never surfaced to the client.
    try {
      await deleteStoredFile(stored.document.filePath);
    } catch {
      // best-effort object cleanup only
    }
    try {
      await db
        .delete(documents)
        .where(
          and(
            eq(documents.id, stored.document.id),
            eq(documents.userId, auth.userId)
          )
        )
        .execute();
    } catch {
      // best-effort row cleanup only
    }
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
