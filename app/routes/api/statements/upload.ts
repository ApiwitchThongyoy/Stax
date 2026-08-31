import type { Route } from "./+types/upload";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { saveStatementPdf, findExistingDocumentByHash } from "~/lib/storage/statement-storage";
import { computeContentHash, buildDuplicatePayload } from "~/lib/statement-hash";
import { extractTextFromPdf } from "~/lib/pdf-text-extractor";
import {
  buildStatementTransactions,
  insertStatementTransactions,
  hasSavedDocumentRows,
} from "~/lib/statement-pipeline";
import {
  parseStatementWithGemini,
  isGeminiConfigured,
  GeminiError,
  GeminiErrorCode,
  type GeminiStatementResult,
  type GeminiErrorCodeValue,
} from "~/lib/gemini-statement-parser";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

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

  // 0. User-scoped duplicate detection BEFORE storing anything, so a re-uploaded
  // Statement never creates an orphaned file/document row and never re-imports
  // or re-analyzes the same PDF. The hash is deterministic on the file bytes.
  const contentHash = computeContentHash(
    new Uint8Array(await file.arrayBuffer())
  );
  const existingDocument = await findExistingDocumentByHash(
    auth.userId,
    contentHash
  );
  if (existingDocument) {
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
    return Response.json({
      success: true,
      data: buildDuplicatePayload(existingDocument.id),
    });
  }

  // 1. Validate + store the PDF (UUID filename) and record it in the documents table.
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

  try {
    // 2. Server-side text extraction from the stored file path.
    let extraction;
    try {
      extraction = await extractTextFromPdf(stored.document.filePath);
    } catch (extractError) {
      console.error("Statement upload: extractTextFromPdf threw", extractError);
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

    // 3. Parse + validate into Capital_Transactions rows.
    const built = buildStatementTransactions(
      extraction.text,
      auth.userId,
      documentId
    );

    // 3b. Gemini structured analysis (best-effort, for preview only).
    const aiResult = await runGeminiAnalysis(
      extraction.text,
      auth.userId,
      documentId
    );

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
          ai: aiResult,
        },
      });
    }

    // 4. Duplicate protection: if this document was already saved for this user, skip.
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

    // 5. Atomic insert into Capital_Transactions.
    const result = await insertStatementTransactions(auth.userId, built.rows);

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
      },
    });

    return Response.json({
      success: true,
      data: {
        documentId,
        fileName,
        extracted: built.extractedCount,
        saved: result.insertedCount,
        transactionIds: result.transactionIds,
        rejected: built.rejections,
        ai: aiResult,
      },
    });
  } catch (error) {
    console.error("Statement upload: processing failed", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}
