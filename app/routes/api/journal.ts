import type { Route } from "./+types/journal";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import { insertAuditLog, AuditAction } from "~/lib/audit-log";
import {
  createJournalEntry,
  createStructuredManualJournal,
  listJournalEntries,
  type StructuredManualJournalInput,
} from "~/lib/ledger-service";
import type { JournalLineInput, JournalEntryInput } from "~/lib/general-ledger";

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

function isValidIsoDate(value: string): boolean {
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  return true;
}

function parseNonNegativeAmount(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(n);
}

export async function loader({ request }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  if ((from && !isValidIsoDate(from)) || (to && !isValidIsoDate(to))) {
    return Response.json(
      { success: false, message: "from/to must be ISO dates (yyyy-mm-dd)" },
      { status: 400 }
    );
  }
  const sourceTypeParam = url.searchParams.get("sourceType");
  const sourceType =
    sourceTypeParam === "MANUAL" || sourceTypeParam === "STATEMENT"
      ? sourceTypeParam
      : undefined;
  const postingStateParam = url.searchParams.get("postingState");
  const postingState =
    postingStateParam === "POSTED" || postingStateParam === "SKIPPED"
      ? postingStateParam
      : undefined;
  if (sourceTypeParam && !sourceType) {
    return Response.json(
      { success: false, message: "sourceType must be MANUAL or STATEMENT" },
      { status: 400 }
    );
  }
  if (postingStateParam && !postingState) {
    return Response.json(
      { success: false, message: "postingState must be POSTED or SKIPPED" },
      { status: 400 }
    );
  }

  try {
    const entries = await listJournalEntries(auth.userId, from, to, {
      sourceType,
      postingState,
    });
    return Response.json({ success: true, data: entries }, { status: 200 });
  } catch (error) {
    console.error("Journal GET: failed to query", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  if (request.method === "POST") {
    return handleCreate(request, auth);
  }

  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

/**
 * Body shape for a manual journal entry:
 *   { entryDate: "2026-01-15", description: "...", lines: [
 *       { accountId: "<account id or code>", currency: "USD",
 *         debit: "1000", fxRateEffective: "35.5" },
 *       { accountId: "<account id or code>", currency: "USD",
 *         credit: "1000", fxRateEffective: "35.5" },
 *   ] }
 *
 * Exactly one of debit/credit per line, positive magnitudes. Per-currency
 * balance (debit total == credit total per currency) is enforced by the ledger
 * service on the server — never trusted from the client.
 */
async function handleCreate(
  request: Request,
  auth: { userId: string; email: string; role: string }
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, message: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { entryDate, description, lines, transactionType } = (body ?? {}) as {
    entryDate?: unknown;
    description?: unknown;
    lines?: unknown;
    transactionType?: unknown;
  };

  if (typeof entryDate !== "string" || !isValidIsoDate(entryDate)) {
    return Response.json(
      { success: false, message: "entryDate must be an ISO date (yyyy-mm-dd)" },
      { status: 400 }
    );
  }
  if (typeof description !== "string" || description.trim() === "") {
    return Response.json(
      { success: false, message: "description is required" },
      { status: 400 }
    );
  }

  // Support structured manual transactions from "+ เพิ่มรายการเอง" modal
  if (typeof transactionType === "string" && transactionType.trim() !== "") {
    const structuredResult = await createStructuredManualJournal(
      auth.userId,
      body as StructuredManualJournalInput
    );
    if (!structuredResult.ok) {
      return Response.json(
        { success: false, message: "Invalid journal entry", errors: structuredResult.errors },
        { status: 422 }
      );
    }

    await insertAuditLog({
      userId: auth.userId,
      action: AuditAction.JOURNAL_ENTRY_CREATE,
      entityType: "journal_entries",
      entityId: structuredResult.entryId,
      details: {
        method: "POST",
        route: "/api/v1/journal",
        transactionType: transactionType.trim(),
        description: (description as string).trim(),
        entryDate: (entryDate as string).trim(),
      },
    });

    return Response.json(
      {
        success: true,
        data: {
          entryId: structuredResult.entryId,
          entryNo: structuredResult.entryNo,
          description: (description as string).trim(),
          entryDate: (entryDate as string).trim(),
        },
      },
      { status: 201 }
    );
  }

  if (!Array.isArray(lines) || lines.length < 2) {
    return Response.json(
      { success: false, message: "at least 2 lines are required" },
      { status: 400 }
    );
  }

  const inputLines: JournalLineInput[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? {}) as Record<string, unknown>;
    const accountId = typeof line.accountId === "string" ? line.accountId.trim() : "";
    const currency = typeof line.currency === "string" ? line.currency.trim().toUpperCase() : "";
    if (!accountId) {
      return Response.json(
        { success: false, message: `line[${i}]: accountId is required` },
        { status: 400 }
      );
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      return Response.json(
        { success: false, message: `line[${i}]: currency must be a 3-letter ISO code` },
        { status: 400 }
      );
    }
    const debit = parseNonNegativeAmount(line.debit);
    const credit = parseNonNegativeAmount(line.credit);
    if ((debit === null) === (credit === null)) {
      return Response.json(
        { success: false, message: `line[${i}]: exactly one of debit/credit must be set` },
        { status: 400 }
      );
    }
    const fxRateEffective =
      typeof line.fxRateEffective === "string" && line.fxRateEffective.trim() !== ""
        ? line.fxRateEffective.trim()
        : undefined;
    const fxRateStatement =
      typeof line.fxRateStatement === "string" && line.fxRateStatement.trim() !== ""
        ? line.fxRateStatement.trim()
        : undefined;
    inputLines.push({
      accountId,
      currency,
      ...(debit !== null ? { debit } : { credit }),
      ...(fxRateEffective ? { fxRateEffective } : {}),
      ...(fxRateStatement ? { fxRateStatement } : {}),
      memo: typeof line.memo === "string" ? line.memo : null,
    });
  }

  const input: JournalEntryInput = {
    entryDate: entryDate.trim(),
    description: description.trim(),
    sourceType: "MANUAL",
    lines: inputLines,
  };

  const result = await createJournalEntry(auth.userId, input);
  if (!result.ok) {
    return Response.json(
      { success: false, message: "Invalid journal entry", errors: result.errors },
      { status: 422 }
    );
  }

  await insertAuditLog({
    userId: auth.userId,
    action: AuditAction.JOURNAL_ENTRY_CREATE,
    entityType: "journal_entries",
    entityId: result.entryId,
    details: {
      method: "POST",
      route: "/api/v1/journal",
      description: input.description,
      entryDate: input.entryDate,
      lineCount: inputLines.length,
    },
  });

  return Response.json(
    {
      success: true,
      data: {
        entryId: result.entryId,
        entryNo: result.entryNo,
        description: input.description,
        entryDate: input.entryDate,
      },
    },
    { status: 201 }
  );
}