// Batch Reconciliation Script for Accounting Pipeline.
//
// Chronological, idempotent, DRY RUN by default (--apply only to write).
// Replays full historical records from earliest date (2025 or earlier) under the
// Webull Average Cost engine and re-evaluates all Statement transactions.
//
// Outputs exact metrics:
//   scanned, alreadyPosted, referenceOnly, promotable, missingCostBasis,
//   missingFx, oversell, unbalanced, promoted, stillSkipped.
//
// Usage:
//   node ./node_modules/tsx/dist/cli.mjs scripts/reconcile-accounting-pipeline.mts [userId] [--apply]
import "dotenv/config";
import { and, eq, asc, sql } from "drizzle-orm";
import { db } from "../app/lib/drizzle-db";
import { randomUUID } from "node:crypto";
import {
  users,
  capitalTransactions,
  corporateActions,
  journalEntries,
  journalEntryLines,
  accounts,
} from "../app/db/schema";
import {
  recomputeAllGainLoss,
  rebuildCostBasisStateFromLedger,
  type GainLossBackfillRow,
  type ValidatedCapitalRow,
} from "../app/lib/statement-pipeline";
import { buildStatementJournalEntries } from "../app/lib/posting-engine";
import {
  createJournalEntry,
  reverseJournalEntry,
  loadAccountLookup,
  seedDefaultChartOfAccounts,
  resolveEntryAccountIds,
} from "../app/lib/ledger-service";
import { isReferenceOnlySkip, validateJournalEntry } from "../app/lib/general-ledger";
import { Decimal } from "decimal.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const filterUserId = args.find((a) => !a.startsWith("--")) || undefined;

export interface ReconciliationMetrics {
  userId: string;
  userEmail: string;
  scanned: number;
  alreadyPosted: number;
  referenceOnly: number;
  promotable: number;
  missingCostBasis: number;
  missingFx: number;
  oversell: number;
  unbalanced: number;
  promoted: number;
  stillSkipped: number;
}

interface LedgerRow extends GainLossBackfillRow {
  userId: string;
  amountForeign: string;
  currency: string;
  transactionDate: string;
  fxRateBot: string | null;
  fxRateStatement: string | null;
  amountThb: string | null;
  type: string;
  sourceDocumentId: string | null;
  category: string | null;
  section: string | null;
  exchange: string | null;
  exchangeFromCurrency: string | null;
  exchangeFromAmount: string | null;
  exchangeRate: string | null;
  isMonthlyFeeAggregate: boolean | null;
  costBasis: string | null;
  proceeds: string | null;
  realizedGainLoss: string | null;
}

const CAPITAL_TX = {
  transactionId: capitalTransactions.transactionId,
  userId: capitalTransactions.userId,
  sourceType: capitalTransactions.sourceType,
  transactionDate: capitalTransactions.transactionDate,
  symbol: capitalTransactions.symbol,
  side: capitalTransactions.side,
  quantity: capitalTransactions.quantity,
  unitPrice: capitalTransactions.unitPrice,
  grossAmount: capitalTransactions.grossAmount,
  fees: capitalTransactions.fees,
  netAmount: capitalTransactions.netAmount,
  currency: capitalTransactions.currency,
  fxRateEffective: capitalTransactions.fxRateEffective,
  fxRateStatement: capitalTransactions.fxRateStatement,
  fxRateBot: capitalTransactions.fxRateBot,
  amountForeign: capitalTransactions.amountForeign,
  amountThb: capitalTransactions.amountThb,
  type: capitalTransactions.type,
  sourceDocumentId: capitalTransactions.sourceDocumentId,
  category: capitalTransactions.category,
  section: capitalTransactions.section,
  exchange: capitalTransactions.exchange,
  exchangeFromCurrency: capitalTransactions.exchangeFromCurrency,
  exchangeFromAmount: capitalTransactions.exchangeFromAmount,
  exchangeRate: capitalTransactions.exchangeRate,
  isMonthlyFeeAggregate: capitalTransactions.isMonthlyFeeAggregate,
  costBasis: capitalTransactions.costBasis,
  proceeds: capitalTransactions.proceeds,
  realizedGainLoss: capitalTransactions.realizedGainLoss,
  realizedGainLossThb: capitalTransactions.realizedGainLossThb,
};

function toValidatedRow(r: LedgerRow): ValidatedCapitalRow {
  return {
    transactionId: r.transactionId,
    userId: r.userId,
    amountForeign: r.amountForeign,
    currency: r.currency,
    transactionDate: r.transactionDate,
    fxRateBot: r.fxRateBot,
    amountThb: r.amountThb,
    type: r.type === "CASH_OUT" ? "CASH_OUT" : "CASH_IN",
    sourceType: "AI_PARSED",
    sourceDocumentId: r.sourceDocumentId ?? "",
    category: r.category ?? "",
    section: r.section ?? "",
    symbol: r.symbol,
    side: r.side === "BUY" || r.side === "SELL" ? r.side : null,
    quantity: r.quantity,
    unitPrice: r.unitPrice,
    grossAmount: r.grossAmount,
    fees: r.fees,
    proceeds: r.proceeds,
    costBasis: r.costBasis,
    realizedGainLoss: r.realizedGainLoss,
    realizedGainLossThb: r.realizedGainLossThb,
    fxRateStatement: r.fxRateStatement,
    fxRateEffective: r.fxRateEffective,
    netAmount: r.netAmount,
    exchange: r.exchange,
    exchangeFromCurrency: r.exchangeFromCurrency,
    exchangeFromAmount: r.exchangeFromAmount,
    exchangeRate: r.exchangeRate,
    isMonthlyFeeAggregate: r.isMonthlyFeeAggregate,
  };
}

async function loadCorporateActions(userId: string) {
  try {
    const actionRows = await db
      .select({
        id: corporateActions.id,
        symbol: corporateActions.symbol,
        actionType: corporateActions.actionType,
        transactionDate: corporateActions.transactionDate,
        ratioOld: corporateActions.ratioOld,
        ratioNew: corporateActions.ratioNew,
        newSymbol: corporateActions.newSymbol,
        sharesOut: corporateActions.sharesOut,
        priceOut: corporateActions.priceOut,
        parentFmvPerShare: corporateActions.parentFmvPerShare,
        childFmvPerShare: corporateActions.childFmvPerShare,
      })
      .from(corporateActions)
      .where(eq(corporateActions.userId, userId))
      .orderBy(corporateActions.transactionDate)
      .execute();
    return actionRows.map((a) => ({
      id: a.id,
      symbol: a.symbol,
      actionType: a.actionType as "SPLIT" | "REVERSE_SPLIT" | "SPIN_OFF" | "RENAME",
      transactionDate: a.transactionDate,
      ratioOld: a.ratioOld,
      ratioNew: a.ratioNew,
      newSymbol: a.newSymbol,
      sharesOut: a.sharesOut,
      priceOut: a.priceOut,
      parentFmvPerShare: a.parentFmvPerShare,
      childFmvPerShare: a.childFmvPerShare,
    }));
  } catch (error) {
    const inner =
      error && typeof error === "object" && "cause" in error && error.cause instanceof Error
        ? error.cause.message
        : "";
    const msg = `${error instanceof Error ? error.message : String(error)} ${inner}`;
    if (/does not exist/i.test(msg)) return [];
    throw error;
  }
}

export async function reconcileUser(
  userId: string,
  userEmail: string,
  doApply: boolean
): Promise<ReconciliationMetrics> {
  const metrics: ReconciliationMetrics = {
    userId,
    userEmail,
    scanned: 0,
    alreadyPosted: 0,
    referenceOnly: 0,
    promotable: 0,
    missingCostBasis: 0,
    missingFx: 0,
    oversell: 0,
    unbalanced: 0,
    promoted: 0,
    stillSkipped: 0,
  };

  // 1. Ensure user has default CoA seeded (including 5130 VAT)
  let lookup = await loadAccountLookup(userId);
  if (lookup.size === 0 || !lookup.has("5130")) {
    if (doApply) {
      await seedDefaultChartOfAccounts(userId);
      lookup = await loadAccountLookup(userId);
    }
  }

  // 2. Load all historical capital transactions chronologically
  const storedRows: LedgerRow[] = await db
    .select(CAPITAL_TX)
    .from(capitalTransactions)
    .where(eq(capitalTransactions.userId, userId))
    .orderBy(asc(capitalTransactions.transactionDate), asc(capitalTransactions.transactionId))
    .execute();

  metrics.scanned = storedRows.length;
  if (storedRows.length === 0) return metrics;

  // 3. Load corporate actions and run full chronological recompute
  const actions = await loadCorporateActions(userId);
  const { updates: computedUpdates } = recomputeAllGainLoss(storedRows, actions);
  const updateMap = new Map(computedUpdates.map((u) => [u.transactionId, u.update]));

  // 4. Load current journal entries
  const existingEntries = await db
    .select({
      id: journalEntries.id,
      sourceTransactionId: journalEntries.sourceTransactionId,
      status: journalEntries.status,
      postingState: journalEntries.postingState,
      skipReason: journalEntries.skipReason,
    })
    .from(journalEntries)
    .where(eq(journalEntries.userId, userId))
    .execute();

  const entryBySourceTx = new Map<string, (typeof existingEntries)[0]>();
  for (const e of existingEntries) {
    if (!e.sourceTransactionId) continue;
    const prev = entryBySourceTx.get(e.sourceTransactionId);
    // Prioritize active POSTED entry over any SKIPPED placeholder or superseded entry
    if (!prev || (prev.postingState !== "POSTED" && e.postingState === "POSTED")) {
      entryBySourceTx.set(e.sourceTransactionId, e);
    }
  }

  // 5. Evaluate each transaction
  const rowsToPromote: LedgerRow[] = [];
  const changedCapitalRows: { transactionId: string; update: any }[] = [];

  for (const row of storedRows) {
    const isReference =
      row.isMonthlyFeeAggregate === true ||
      isReferenceOnlySkip(row.section) ||
      (row.category === "income" && (row.section ?? "").includes("กำไรจากการขาย"));

    if (isReference) {
      metrics.referenceOnly++;
      continue;
    }

    // FX check
    if (row.currency !== "THB") {
      const eff = row.fxRateEffective;
      if (eff == null || !(Number(eff) > 0)) {
        metrics.missingFx++;
        continue;
      }
    }

    // Merge computed cost basis & trading gain for SELL
    let effectiveRow = { ...row };
    if (row.side === "SELL") {
      const update = updateMap.get(row.transactionId);
      if (update) {
        effectiveRow = {
          ...row,
          costBasis: update.costBasis,
          proceeds: update.proceeds,
          realizedGainLoss: update.realizedGainLoss,
          realizedGainLossThb: update.realizedGainLossThb,
        };
        if (
          row.costBasis !== update.costBasis ||
          row.proceeds !== update.proceeds ||
          row.realizedGainLoss !== update.realizedGainLoss
        ) {
          changedCapitalRows.push({
            transactionId: row.transactionId,
            update,
          });
        }
      } else {
        // No computable basis
        const qty = row.quantity ? parseFloat(row.quantity) : 0;
        if (qty > 0) {
          metrics.missingCostBasis++;
        }
        continue;
      }
    }

    const validatedRow = toValidatedRow(effectiveRow);
    const [plan] = buildStatementJournalEntries([validatedRow]);

    if (!plan || plan.postingState === "SKIPPED") {
      const reason = plan?.reason ?? "";
      if (reason.toLowerCase().includes("oversell")) {
        metrics.oversell++;
      } else if (reason.toLowerCase().includes("cost basis")) {
        metrics.missingCostBasis++;
      } else if (reason.toLowerCase().includes("fx rate")) {
        metrics.missingFx++;
      } else if (
        isReferenceOnlySkip(reason) ||
        reason.toLowerCase().includes("monthly fee") ||
        reason.toLowerCase().includes("already posted")
      ) {
        metrics.referenceOnly++;
      } else if (
        reason.toLowerCase().includes("does not balance") ||
        reason.toLowerCase().includes("unbalanced")
      ) {
        metrics.unbalanced++;
      }
      continue;
    }

    // The row produces a balanced POSTED plan!
    const existing = entryBySourceTx.get(row.transactionId);
    if (existing && existing.postingState === "POSTED" && existing.status === "POSTED") {
      metrics.alreadyPosted++;
    } else {
      metrics.promotable++;
      rowsToPromote.push(effectiveRow);
    }
  }

  // 6. Apply if requested
  if (doApply) {
    // A. Update Capital_Transactions where basis/gain changed
    if (changedCapitalRows.length > 0) {
      await db.transaction(async (tx) => {
        for (const u of changedCapitalRows) {
          await tx
            .update(capitalTransactions)
            .set({
              costBasis: u.update.costBasis,
              proceeds: u.update.proceeds,
              realizedGainLoss: u.update.realizedGainLoss,
              realizedGainLossThb: u.update.realizedGainLossThb,
            })
            .where(
              and(
                eq(capitalTransactions.transactionId, u.transactionId),
                eq(capitalTransactions.userId, userId)
              )
            )
            .execute();
        }
      });
    }

    // B. Rebuild cost_basis_state cache
    await rebuildCostBasisStateFromLedger(userId);

    // C. Promote promotable rows
    const lookup = await loadAccountLookup(userId);
    const now = new Date().toISOString();

    for (const r of rowsToPromote) {
      try {
        const validatedRow = toValidatedRow(r);
        const [plan] = buildStatementJournalEntries([validatedRow]);
        if (!plan || plan.postingState !== "POSTED") continue;

        const resolved = resolveEntryAccountIds(plan.entry, lookup);
        if (!resolved.ok) {
          console.error(`[APPLY ERROR] Cannot resolve accounts for ${r.transactionId}: ${resolved.errors.join("; ")}`);
          continue;
        }

        const validated = validateJournalEntry({ ...plan.entry, lines: resolved.lines });
        if (!validated.ok) {
          console.error(`[APPLY ERROR] Cannot validate entry for ${r.transactionId}: ${validated.errors.join("; ")}`);
          continue;
        }

        const existing = entryBySourceTx.get(r.transactionId);

        await db.transaction(async (tx) => {
          if (existing) {
            // Update the existing SKIPPED journal entry in place (matching reconcileSkippedRoundingPostings)
            await tx
              .delete(journalEntryLines)
              .where(
                and(
                  eq(journalEntryLines.userId, userId),
                  eq(journalEntryLines.journalEntryId, existing.id)
                )
              )
              .execute();
            await tx
              .update(journalEntries)
              .set({
                postingState: "POSTED",
                status: "POSTED",
                skipReason: null,
                updatedAt: now,
              })
              .where(
                and(
                  eq(journalEntries.userId, userId),
                  eq(journalEntries.id, existing.id)
                )
              )
              .execute();
            for (const line of validated.entry.lines) {
              await tx
                .insert(journalEntryLines)
                .values({
                  id: randomUUID(),
                  userId,
                  journalEntryId: existing.id,
                  accountId: line.accountId,
                  currency: line.currency,
                  debitAmount: line.side === "DEBIT" ? line.amount : null,
                  creditAmount: line.side === "CREDIT" ? line.amount : null,
                  amountThb: line.amountThb,
                  fxRateEffective: line.fxRateEffective,
                  fxRateStatement: line.fxRateStatement,
                  fxRateProvider: line.fxRateProvider,
                  memo: line.memo,
                })
                .execute();
            }
          } else {
            // No previous journal entry at all: create fresh entry
            const created = await createJournalEntry(userId, plan.entry);
            if (!created.ok) {
              throw new Error(`Failed to create journal entry: ${created.errors.join("; ")}`);
            }
          }
        });

        metrics.promoted++;
      } catch (err) {
        console.error(`[APPLY ERROR] Failed promoting transaction ${r.transactionId}:`, err);
      }
    }
  }

  metrics.stillSkipped = metrics.scanned - metrics.alreadyPosted - metrics.promoted;
  return metrics;
}

async function main() {
  console.log(`\n===============================================================`);
  console.log(`STAX ACCOUNTING PIPELINE RECONCILIATION`);
  console.log(`Mode: ${apply ? "APPLY (writes enabled)" : "DRY RUN (zero writes)"}`);
  console.log(`===============================================================\n`);

  try {
    const userRows = filterUserId
      ? await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, filterUserId)).execute()
      : await db.select({ id: users.id, email: users.email }).from(users).execute();

    if (userRows.length === 0) {
      console.log("No users found to reconcile.");
      process.exit(0);
    }

    const allMetrics: ReconciliationMetrics[] = [];
    for (const u of userRows) {
      console.log(`Scanning user: ${u.email} (${u.id})...`);
      const m = await reconcileUser(u.id, u.email, apply);
      allMetrics.push(m);
      console.log(`  Scanned: ${m.scanned}`);
      console.log(`  Already Posted: ${m.alreadyPosted}`);
      console.log(`  Reference Only: ${m.referenceOnly}`);
      console.log(`  Promotable: ${m.promotable}`);
      console.log(`  Missing Cost Basis: ${m.missingCostBasis}`);
      console.log(`  Missing FX: ${m.missingFx}`);
      console.log(`  Oversell: ${m.oversell}`);
      console.log(`  Unbalanced: ${m.unbalanced}`);
      console.log(`  Promoted: ${m.promoted}`);
      console.log(`  Still Skipped: ${m.stillSkipped}\n`);
    }

    // Totals
    const totals = allMetrics.reduce(
      (acc, m) => {
        acc.scanned += m.scanned;
        acc.alreadyPosted += m.alreadyPosted;
        acc.referenceOnly += m.referenceOnly;
        acc.promotable += m.promotable;
        acc.missingCostBasis += m.missingCostBasis;
        acc.missingFx += m.missingFx;
        acc.oversell += m.oversell;
        acc.unbalanced += m.unbalanced;
        acc.promoted += m.promoted;
        acc.stillSkipped += m.stillSkipped;
        return acc;
      },
      {
        scanned: 0,
        alreadyPosted: 0,
        referenceOnly: 0,
        promotable: 0,
        missingCostBasis: 0,
        missingFx: 0,
        oversell: 0,
        unbalanced: 0,
        promoted: 0,
        stillSkipped: 0,
      }
    );

    console.log(`======================= TOTAL SUMMARY =======================`);
    console.log(`Total Users Processed:  ${allMetrics.length}`);
    console.log(`Total Scanned:          ${totals.scanned}`);
    console.log(`Total Already Posted:   ${totals.alreadyPosted}`);
    console.log(`Total Reference Only:   ${totals.referenceOnly}`);
    console.log(`Total Promotable:       ${totals.promotable}`);
    console.log(`Total Missing Basis:    ${totals.missingCostBasis}`);
    console.log(`Total Missing FX:       ${totals.missingFx}`);
    console.log(`Total Oversell:         ${totals.oversell}`);
    console.log(`Total Unbalanced:       ${totals.unbalanced}`);
    console.log(`Total Promoted:         ${totals.promoted}`);
    console.log(`Total Still Skipped:    ${totals.stillSkipped}`);
    console.log(`=============================================================\n`);

    if (!apply && totals.promotable > 0) {
      console.log(`[NOTE] ${totals.promotable} promotable entries detected. Run with --apply to commit updates.\n`);
    }

    process.exit(0);
  } catch (error) {
    console.error("Reconciliation failed:", error);
    process.exit(1);
  }
}

void main();
