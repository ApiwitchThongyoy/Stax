// One-shot FULL recompute to the Webull Average-Cost method.
//
// Switches every existing user's cost basis (and all AI_PARSED SELL realized
// gain/loss — which drives the tax base and the general ledger) from the old
// "remaining-qty running average" to the Webull "Average Cost" method:
//   avg = cumulative price×qty of ALL BUYs / cumulative BUY quantity
//   (SELL reduces live quantity only; fees excluded; reset on full liquidation)
//
// What it does per user:
//   1. Replays the full ledger + corporate actions chronologically under the
//      Webull engine (recomputeAllGainLoss) and OVERWRITES every AI_PARSED SELL
//      row's costBasis/proceeds/realizedGainLoss/realizedGainLossThb. MANUAL
//      rows and cash rows are never written; non-computable stays a hole.
//   2. Rewrites cost_basis_state via rebuildCostBasisStateFromLedger (same math).
//   3. (default) Re-posts the general ledger for rows whose basis/realized
//      changed: reverses the previously POSTED STATEMENT entry and re-creates
//      it from the updated row (source_transaction_id links them). Best-effort.
//
// Safe to re-run: after a successful run the stored values already match the
// Webull result, so the second run changes nothing (GL is already re-posted and
// the reversal/impact is idempotent per row).
//
// Flags:  npx tsx scripts/recompute-cost-basis-webull.mts [userId] [--no-gl]
import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { db } from "../app/lib/drizzle-db";
import {
  users,
  capitalTransactions,
  corporateActions,
  journalEntries,
} from "../app/db/schema";
import {
  recomputeAllGainLoss,
  rebuildCostBasisStateFromLedger,
  type GainLossBackfillRow,
  type ValidatedCapitalRow,
} from "../app/lib/statement-pipeline";
import { buildStatementPostings } from "../app/lib/posting-engine";
import { insertPostings, reverseJournalEntry } from "../app/lib/ledger-service";

const args = process.argv.slice(2);
const filterUserId = args.find((a) => !a.startsWith("--")) || undefined;
const doGl = !args.includes("--no-gl");

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

async function loadActions(userId: string) {
  // corporate_actions is optional for the math and may not exist on every
  // deployment yet (0014 migration not always applied) — tolerate that.
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
    const inner = error && typeof error === "object" && "cause" in error && error.cause instanceof Error
      ? error.cause.message
      : "";
    const msg = `${error instanceof Error ? error.message : String(error)} ${inner}`;
    if (/does not exist/i.test(msg)) {
      console.warn(
        `    [recompute] user=${userId} corporate_actions not migrated — replaying trades only`
      );
      return [];
    }
    throw error;
  }
}

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

async function repostLedgerForRow(row: LedgerRow) {
  // Find any still-POSTED STATEMENT entry linked to this row.
  const entries = await db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.userId, row.userId),
        eq(journalEntries.sourceTransactionId, row.transactionId),
        eq(journalEntries.sourceType, "STATEMENT"),
        eq(journalEntries.status, "POSTED")
      )
    )
    .execute();

  let reversed = 0;
  for (const e of entries) {
    const result = await reverseJournalEntry(row.userId, e.id);
    if (result.ok) reversed++;
  }

  const { entries: newEntries, skipped } = buildStatementPostings([
    toValidatedRow(row),
  ]);
  if (newEntries.length === 0) {
    return { reversed, posted: 0, skipped: skipped.length };
  }
  const result = await insertPostings(row.userId, newEntries);
  return { reversed, posted: result.postedCount, skipped: skipped.length };
}

async function processUser(userId: string, includeGl: boolean) {
  const storedRows: LedgerRow[] = await db
    .select(CAPITAL_TX)
    .from(capitalTransactions)
    .where(eq(capitalTransactions.userId, userId))
    .orderBy(capitalTransactions.transactionDate, capitalTransactions.transactionId)
    .execute();

  const actions = await loadActions(userId);
  const { updates, stats } = recomputeAllGainLoss(storedRows, actions);

  // Only rows whose Webull value differs from what is stored need writing.
  const storedById = new Map(storedRows.map((r) => [r.transactionId, r]));
  const changed = updates.filter((u) => {
    const s = storedById.get(u.transactionId);
    if (!s) return true;
    return (
      s.costBasis !== u.update.costBasis ||
      s.proceeds !== u.update.proceeds ||
      s.realizedGainLoss !== u.update.realizedGainLoss ||
      s.realizedGainLossThb !== u.update.realizedGainLossThb
    );
  });

  if (changed.length > 0) {
    await db.transaction(async (tx) => {
      for (const u of changed) {
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

  // Rewrite the cost-basis cache under the Webull engine.
  await rebuildCostBasisStateFromLedger(userId);
  const holdings = await db
    .select({ symbol: capitalTransactions.symbol })
    .from(capitalTransactions)
    .where(eq(capitalTransactions.userId, userId))
    .limit(0)
    .execute();
  void holdings;

  // General-ledger re-posting for the changed SELL rows (best-effort).
  let gl = { reversed: 0, posted: 0, skipped: 0 };
  if (includeGl) {
    for (const u of changed) {
      const row = storedById.get(u.transactionId);
      if (!row) continue;
      try {
        // Use the NEW computed values for re-posting.
        const updatedRow: LedgerRow = {
          ...row,
          costBasis: u.update.costBasis,
          proceeds: u.update.proceeds,
          realizedGainLoss: u.update.realizedGainLoss,
          realizedGainLossThb: u.update.realizedGainLossThb,
        };
        const outcome = await repostLedgerForRow(updatedRow);
        gl.reversed += outcome.reversed;
        gl.posted += outcome.posted;
        gl.skipped += outcome.skipped;
      } catch (error) {
        console.error(`[recompute] user=${userId} GL re-post failed for ${row.transactionId}`, error);
      }
    }
  }

  console.log(
    `[recompute] user=${userId} recomputed=${stats.recomputed} changed=${changed.length} ` +
      `skippedManual=${stats.skippedManual} stillNonComputable=${stats.stillNonComputable} ` +
      `gl={reversed:${gl.reversed}, posted:${gl.posted}, skipped:${gl.skipped}}`
  );
  return { changed: changed.length, recomputed: stats.recomputed, gl };
}

async function main() {
  const rows = filterUserId
    ? [{ id: filterUserId }]
    : await db.select({ id: users.id }).from(users).execute();

  let totalChanged = 0;
  let totalRecomputed = 0;
  for (const { id } of rows) {
    try {
      const result = await processUser(id, doGl);
      totalChanged += result.changed;
      totalRecomputed += result.recomputed;
    } catch (error) {
      console.error(`[recompute] user=${id} FAILED`, error);
    }
  }
  console.log(
    `\n[recompute] done. totalRecomputed=${totalRecomputed} totalChanged=${totalChanged} (GL re-posting: ${doGl ? "ON" : "OFF"})`
  );
  process.exit(0);
}

void main();