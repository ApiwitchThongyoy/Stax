import type { Route } from "./+types/upload";
import { verifyAuth } from "~/lib/auth-middleware";
import { saveStatementPdf } from "~/lib/storage/statement-storage";
import { extractTextFromPdf } from "~/lib/pdf-text-extractor";
import {
  buildStatementTransactions,
  insertStatementTransactions,
  hasSavedDocumentRows,
} from "~/lib/statement-pipeline";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
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
    return Response.json(
      { success: false, message: auth.message },
      { status: auth.status }
    );
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

  // 1. Validate + store the PDF (UUID filename) and record it in the documents table.
  const stored = await saveStatementPdf({ userId: auth.userId, file });
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
