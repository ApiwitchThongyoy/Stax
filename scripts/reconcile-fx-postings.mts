// One-shot reconcile: re-posts previously-SKIPPED STATEMENT currency-exchange
// rows now that confirmed FX conversions post through the REAL engine with a
// THB 5020 FX-variance leg (รายได้/ค่าใช้จ่าย - จากอัตราแลกเปลี่ยน).
//
// Context: production holds FX_CONVERSION rows (category asset, side null)
// whose statement FX gives the two cash legs slightly different THB reporting
// bases (e.g. 5000 THB -> 158.60 USD @ 31.5457: USD base 5003.15 vs source
// 5000.00 = +3.15), so earlier imports recorded them as SKIPPED journal entries
// with zero lines and reason "THB does not balance". The posting engine now
// posts such exchanges with a THB variance leg that absorbs exactly that
// difference, but the rows already persisted as SKIPPED are NOT retroactively
// re-posted by the import path.
//
// This script replays those rows through the REAL engine — postCapitalRow /
// buildStatementJournalEntries — against the user's current chart of accounts
// (5020 THB is a default; seeded first on apply, never on a dry run). Every
// entry that now passes validateJournalEntry + resolveEntryAccountIds +
// currencyMismatchErrors is reported; with --apply it is promoted to POSTED
// with its real lines (same journal id / entry_no, source links preserved).
// Source Capital_Transactions values are never mutated. Deterministic +
// idempotent: a second --apply reports promoted=0.
//
// DEFAULT IS A DRY RUN: zero database writes. Pass --apply to actually promote.
//
// Run:  npx tsx scripts/reconcile-fx-postings.mts [userId] [--apply]
import "dotenv/config";
import { db } from "../app/lib/drizzle-db";
import { users } from "../app/db/schema";
import { reconcileSkippedFxPostings } from "../app/lib/ledger-service";

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
      const result = await reconcileSkippedFxPostings(id, { apply });
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
        const variance =
          e.varianceThb != null
            ? ` variance=${e.varianceThb} ${e.varianceSide}`
            : " variance=none (balances natively)";
        console.log(
          `    ${e.transactionDate} ${e.from ?? "?"}->${e.to ?? "?"} ` +
            `${e.sentAmount}->${e.receivedAmount} lines=${e.lineCount}` +
            ` THB dr=${e.debitThb} cr=${e.creditThb}${variance}` +
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