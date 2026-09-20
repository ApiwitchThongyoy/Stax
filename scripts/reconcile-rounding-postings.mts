// One-shot reconcile: re-posts previously-SKIPPED STATEMENT rows whose journal
// entry was rejected for a THB reporting-base imbalance ("THB does not balance")
// now that the posting engine auto-applies the exact <= 0.01 THB rounding-
// adjustment leg (รอบการปัดเศษ 0.01 - บาท) to otherwise-valid single-currency
// non-THB entries.
//
// Context: production holds SKIPPED journal entries with skip_reason "invalid
// entry: THB does not balance: ..." whose source rows were otherwise keepable.
// The posting engine now derives per-leg THB through moneyInThb and posts a
// THB 5020 rounding-adjustment leg (memo "THB rounding adjustment") for the
// exact <= 0.01 reporting-base difference, so a fresh import of the same
// statement would POST them. The rows already persisted as SKIPPED are NOT
// retroactively re-posted by the import path.
//
// This script replays those rows through the REAL engine — postCapitalRow /
// buildStatementJournalEntries — against the user's current chart of accounts
// (5020 THB is a default; seeded first on apply, never on a dry run). Every
// entry that now passes validateJournalEntry + resolveEntryAccountIds +
// currencyMismatchErrors is reported; with --apply it is promoted to POSTED
// with its real lines (same journal id / entry_no, source links preserved).
// Source Capital_Transactions values are never mutated. Deterministic +
// idempotent: a second --apply reports promoted=0. Currency-exchange rows
// (FX_CONVERSION) are excluded on purpose — use reconcile-fx-postings.mts.
//
// DEFAULT IS A DRY RUN: zero database writes. Pass --apply to actually promote.
//
// Run:  npx tsx scripts/reconcile-rounding-postings.mts [userId] [--apply]
import "dotenv/config";
import { db } from "../app/lib/drizzle-db";
import { users } from "../app/db/schema";
import { reconcileSkippedRoundingPostings } from "../app/lib/ledger-service";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const filterUserId = args.find((a) => !a.startsWith("--")) ?? undefined;

  const rows = filterUserId
    ? [{ id: filterUserId }]
    : await db.select({ id: users.id }).from(users).execute();

  const summary = { scanned: 0, promotable: 0, promoted: 0, stillSkipped: 0, entries: 0 };

  if (!apply) {
    console.log("[reconcile] DRY RUN (no writes). Pass --apply to promote to POSTED.\n");
  }

  for (const { id } of rows) {
    try {
      const result = await reconcileSkippedRoundingPostings(id, { apply });
      summary.scanned += result.scanned;
      summary.promotable += result.promotable;
      summary.promoted += result.promoted;
      summary.stillSkipped += result.stillSkipped.length;
      summary.entries += result.entries.length;
      console.log(
        `[reconcile] user=${id} dryRun=${result.dryRun} scanned=${result.scanned} ` +
          `promotable=${result.promotable} promoted=${result.promoted} stillSkipped=${result.stillSkipped.length}`
      );
      for (const e of result.entries) {
        const adjustment =
          e.adjustmentThb != null
            ? ` adjustment=${e.adjustmentThb} ${e.adjustmentSide}`
            : " adjustment=none (reporting base already balances)";
        console.log(
          `    ${e.transactionDate} tx=${e.transactionId} lines=${e.lineCount}` +
            ` THB dr=${e.debitThb} cr=${e.creditThb}${adjustment}` +
            (e.oldSkipReason ? ` (was: ${e.oldSkipReason})` : "")
        );
      }
      for (const s of result.stillSkipped) {
        console.log(`    still SKIPPED ${s.transactionId}: ${s.reason}`);
      }
    } catch (error) {
      console.error(`[reconcile] user=${id} FAILED`, error);
    }
  }

  console.log(
    `\n[reconcile] done. dryRun=${!apply} scanned=${summary.scanned} ` +
      `promotable=${summary.promotable} promoted=${summary.promoted} ` +
      `stillSkipped=${summary.stillSkipped}`
  );
  process.exit(0);
}

void main();