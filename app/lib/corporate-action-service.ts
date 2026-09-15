// Corporate action service — Drizzle/Postgres wiring for the pure engine.
//
// Persists a user's corporate actions (split / reverse-split / spin-off /
// rename) so the derived cost_basis_state cache can be replayed with them after
// any deletion. Validation lives here (server-authoritative, mirroring the
// ledger-service pattern); `createCorporateAction` validates before insert.
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "./drizzle-db";
import { corporateActions } from "../db/schema";
import {
  type CorporateActionInput,
  type CorporateActionType,
} from "./corporate-action";
import { rebuildCostBasisStateFromLedger } from "./statement-pipeline";

export type CorporateActionRow = typeof corporateActions.$inferSelect;

const VALID_ACTION_TYPES: CorporateActionType[] = [
  "SPLIT",
  "REVERSE_SPLIT",
  "SPIN_OFF",
  "RENAME",
];

function isValidIsoDate(value: string): boolean {
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function isPositive(value: string | null | undefined): boolean {
  if (!value || String(value).trim() === "") return false;
  const n = Number(String(value).trim());
  return Number.isFinite(n) && n > 0;
}

export interface CreateCorporateActionResult {
  ok: boolean;
  id?: string;
  errors?: string[];
}

/**
 * Validate + persist a corporate action for the given user. On success the
 * derived cost-basis cache is reconciled so the new action's effect is visible
 * to future SELL rows immediately.
 */
export async function createCorporateAction(
  userId: string,
  input: CorporateActionInput
): Promise<CreateCorporateActionResult> {
  const errors: string[] = [];

  const symbol = typeof input.symbol === "string" ? input.symbol.trim().toUpperCase() : "";
  if (!symbol) {
    errors.push("symbol is required");
  }
  const actionType = String(input.actionType ?? "").trim().toUpperCase();
  if (!VALID_ACTION_TYPES.includes(actionType as CorporateActionType)) {
    errors.push(`actionType must be one of: ${VALID_ACTION_TYPES.join(", ")}`);
  }
  const transactionDate = typeof input.transactionDate === "string" ? input.transactionDate.trim() : "";
  if (!transactionDate) {
    errors.push("transactionDate is required");
  } else if (!isValidIsoDate(transactionDate)) {
    errors.push("transactionDate must be a valid date (yyyy-mm-dd)");
  }

  if (errors.length > 0) return { ok: false, errors };

  // Per-type required fields.
  if (actionType === "SPLIT" || actionType === "REVERSE_SPLIT") {
    if (!isPositive(input.ratioNew)) {
      errors.push("ratioNew is required and must be positive for split actions");
    }
    if (
      input.ratioOld !== null &&
      input.ratioOld !== undefined &&
      !isPositive(input.ratioOld)
    ) {
      errors.push("ratioOld must be positive when provided");
    }
  } else if (actionType === "RENAME") {
    if (!input.newSymbol || String(input.newSymbol).trim() === "") {
      errors.push("newSymbol is required for rename");
    }
  } else if (actionType === "SPIN_OFF") {
    if (!isPositive(input.sharesOut)) {
      errors.push("sharesOut is required and must be positive for spin-off");
    }
    if (!isPositive(input.priceOut)) {
      errors.push("priceOut is required and must be positive for spin-off");
    }
    // FMV pair is both-or-neither: one-sided input is rejected, never guessed.
    const hasParentFmv = input.parentFmvPerShare != null && String(input.parentFmvPerShare).trim() !== "";
    const hasChildFmv = input.childFmvPerShare != null && String(input.childFmvPerShare).trim() !== "";
    if (hasParentFmv !== hasChildFmv) {
      errors.push("parentFmvPerShare and childFmvPerShare must be provided together for spin-off FMV allocation");
    }
    if ((hasParentFmv && !isPositive(input.parentFmvPerShare)) || (hasChildFmv && !isPositive(input.childFmvPerShare))) {
      errors.push("spin-off FMV per-share values must be positive");
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const id = randomUUID();
  const now = new Date().toISOString();

  try {
    await db
      .insert(corporateActions)
      .values({
        id,
        userId,
        symbol,
        actionType: actionType,
        transactionDate,
        ratioOld:
          input.ratioOld != null && String(input.ratioOld).trim() !== ""
            ? String(input.ratioOld).trim()
            : null,
        ratioNew:
          input.ratioNew != null && String(input.ratioNew).trim() !== ""
            ? String(input.ratioNew).trim()
            : null,
        newSymbol:
          input.newSymbol && String(input.newSymbol).trim() !== ""
            ? String(input.newSymbol).trim().toUpperCase()
            : null,
        sharesOut:
          input.sharesOut != null && String(input.sharesOut).trim() !== ""
            ? String(input.sharesOut).trim()
            : null,
        priceOut:
          input.priceOut != null && String(input.priceOut).trim() !== ""
            ? String(input.priceOut).trim()
            : null,
        parentFmvPerShare:
          input.parentFmvPerShare != null && String(input.parentFmvPerShare).trim() !== ""
            ? String(input.parentFmvPerShare).trim()
            : null,
        childFmvPerShare:
          input.childFmvPerShare != null && String(input.childFmvPerShare).trim() !== ""
            ? String(input.childFmvPerShare).trim()
            : null,
        cashInLieu:
          input.cashInLieu != null && String(input.cashInLieu).trim() !== ""
            ? String(input.cashInLieu).trim()
            : null,
        description:
          input.description && String(input.description).trim() !== ""
            ? String(input.description).trim()
            : null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    // Reconcile the derived cache so the split's effect is applied immediately.
    try {
      await rebuildCostBasisStateFromLedger(userId);
    } catch (error) {
      // Best-effort: an import/seeding failure must not fail the create.
      console.warn(
        "CorporateAction create: cost_basis_state rebuild failed",
        error
      );
    }

    return { ok: true, id };
  } catch (error) {
    console.error("createCorporateAction: failed to insert", error);
    return { ok: false, errors: ["Internal server error"] };
  }
}

export async function listCorporateActions(
  userId: string
): Promise<CorporateActionRow[]> {
  const rows = await db
    .select()
    .from(corporateActions)
    .where(eq(corporateActions.userId, userId))
    .orderBy(corporateActions.transactionDate, corporateActions.symbol)
    .execute();
  return rows;
}

export interface DeleteCorporateActionResult {
  ok: boolean;
  errors?: string[];
}

/**
 * Delete one of the user's corporate actions, then reconcile the derived
 * cost-basis cache so the position/spin-off adjustment is undone.
 */
export async function deleteCorporateAction(
  userId: string,
  id: string
): Promise<DeleteCorporateActionResult> {
  try {
    const existing = await db
      .select({ id: corporateActions.id })
      .from(corporateActions)
      .where(
        and(
          eq(corporateActions.id, id),
          eq(corporateActions.userId, userId)
        )
      )
      .limit(1)
      .execute();

    if (existing.length === 0) {
      return { ok: false, errors: ["Record not found"] };
    }

    await db
      .delete(corporateActions)
      .where(
        and(
          eq(corporateActions.id, id),
          eq(corporateActions.userId, userId)
        )
      )
      .execute();

    try {
      await rebuildCostBasisStateFromLedger(userId);
    } catch (error) {
      console.warn(
        "CorporateAction delete: cost_basis_state rebuild failed",
        error
      );
    }

    return { ok: true };
  } catch (error) {
    console.error("deleteCorporateAction: failed to delete", error);
    return { ok: false, errors: ["Internal server error"] };
  }
}