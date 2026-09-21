import type { Route } from "./+types/journal.$id";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import {
  getJournalEntryById,
  getJournalEntryAuditHistory,
  editJournalEntry,
  type EditJournalEntryInput,
} from "~/lib/ledger-service";
import type { JournalLineInput } from "~/lib/general-ledger";

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

export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  const entryId = (params.id ?? "").trim();
  if (!entryId) {
    return Response.json(
      { success: false, message: "Journal entry id is required" },
      { status: 400 }
    );
  }

  try {
    const entry = await getJournalEntryById(auth.userId, entryId);
    if (!entry) {
      return Response.json(
        { success: false, message: "Journal entry not found" },
        { status: 404 }
      );
    }

    const history = await getJournalEntryAuditHistory(auth.userId, entryId);
    return Response.json(
      {
        success: true,
        data: {
          entry,
          history,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("GET /api/v1/journal/:id failed:", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  if (request.method !== "PUT" && request.method !== "PATCH") {
    return Response.json(
      { success: false, message: "Method not allowed" },
      { status: 405 }
    );
  }

  const entryId = (params.id ?? "").trim();
  if (!entryId) {
    return Response.json(
      { success: false, message: "Journal entry id is required" },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, message: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const {
    entryDate,
    description,
    note,
    category,
    type,
    symbol,
    side,
    quantity,
    unitPrice,
    grossAmount,
    fees,
    netAmount,
    currency,
    amount,
    fxRateEffective,
    lines,
    reason,
  } = (body ?? {}) as Record<string, unknown>;

  if (entryDate !== undefined && (typeof entryDate !== "string" || !isValidIsoDate(entryDate))) {
    return Response.json(
      { success: false, message: "entryDate must be an ISO date (yyyy-mm-dd)" },
      { status: 400 }
    );
  }

  let inputLines: JournalLineInput[] | undefined = undefined;
  if (lines !== undefined) {
    if (!Array.isArray(lines) || lines.length < 2) {
      return Response.json(
        { success: false, message: "at least 2 lines are required when updating lines" },
        { status: 400 }
      );
    }
    inputLines = [];
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? {}) as Record<string, unknown>;
      const accountId = typeof line.accountId === "string" ? line.accountId.trim() : "";
      const cur = typeof line.currency === "string" ? line.currency.trim().toUpperCase() : "";
      if (!accountId) {
        return Response.json(
          { success: false, message: `line[${i}]: accountId is required` },
          { status: 400 }
        );
      }
      if (!/^[A-Z]{3}$/.test(cur)) {
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
      const fxEff =
        typeof line.fxRateEffective === "string" && line.fxRateEffective.trim() !== ""
          ? line.fxRateEffective.trim()
          : undefined;
      const fxStmt =
        typeof line.fxRateStatement === "string" && line.fxRateStatement.trim() !== ""
          ? line.fxRateStatement.trim()
          : undefined;

      inputLines.push({
        accountId,
        currency: cur,
        ...(debit !== null ? { debit } : { credit }),
        ...(fxEff ? { fxRateEffective: fxEff } : {}),
        ...(fxStmt ? { fxRateStatement: fxStmt } : {}),
        memo: typeof line.memo === "string" ? line.memo : null,
      });
    }
  }

  const updates: EditJournalEntryInput = {
    ...(typeof entryDate === "string" ? { entryDate: entryDate.trim() } : {}),
    ...(typeof description === "string" ? { description: description.trim() } : {}),
    ...(note !== undefined ? { note: typeof note === "string" ? note.trim() || null : null } : {}),
    ...(typeof category === "string" ? { category: category.trim() } : {}),
    ...(typeof type === "string" ? { type: type.trim() } : {}),
    ...(typeof symbol === "string" ? { symbol: symbol.trim() } : {}),
    ...(typeof side === "string" ? { side: side.trim() } : {}),
    ...(typeof quantity === "string" ? { quantity: quantity.trim() } : {}),
    ...(typeof unitPrice === "string" ? { unitPrice: unitPrice.trim() } : {}),
    ...(typeof grossAmount === "string" ? { grossAmount: grossAmount.trim() } : {}),
    ...(typeof fees === "string" ? { fees: fees.trim() } : {}),
    ...(typeof netAmount === "string" ? { netAmount: netAmount.trim() } : {}),
    ...(typeof currency === "string" ? { currency: currency.trim().toUpperCase() } : {}),
    ...(typeof amount === "string" ? { amount: amount.trim() } : {}),
    ...(typeof fxRateEffective === "string" ? { fxRateEffective: fxRateEffective.trim() } : {}),
    ...(inputLines ? { lines: inputLines } : {}),
  };

  const userReason = typeof reason === "string" ? reason.trim() : undefined;

  const result = await editJournalEntry(auth.userId, entryId, updates, userReason);
  if (!result.ok) {
    return Response.json(
      { success: false, message: result.errors.join("; "), errors: result.errors },
      { status: result.status }
    );
  }

  return Response.json(
    {
      success: true,
      data: result.entry,
    },
    { status: 200 }
  );
}
