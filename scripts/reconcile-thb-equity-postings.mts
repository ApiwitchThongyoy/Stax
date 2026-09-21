// One-shot reconcile: re-posts previously-SKIPPED STATEMENT equity rows now
// that the THB owner-capital account (3020) exists in the default chart of
// accounts.
//
// Context: before 3020, THB owner deposits/withdrawals could never be
// double-entry posted (the equity leg would have hit the USD 3010 account, a
// currency mismatch), so imports recorded them as SKIPPED journal entries with
// zero lines and reason "no compatible THB account for 3010". The posting
// engine now maps THB equity rows to 3020 (Dr 1010 / Cr 3020), but the rows
// already persisted as SKIPPED are NOT retroactively re-posted by the import
// path.
//
// This script replays those rows through the REAL engine — postCapitalRow /
// buildStatementPostings — against the user's current chart of accounts (3020
// is seeded first, idempotently). Every entry that now passes
// validateJournalEntry + resolveEntryAccountIds + currencyMismatchErrors is
// promoted to POSTED with its real lines; a re-import of the same statement
// produces the identical entry. Source Capital_Transactions values are never
// mutated. Deterministic + idempotent: already-POSTED rows are no-ops and a
// re-run reports promoted=0.
//
// Run:  npx tsx scripts/reconcile-thb-equity-postings.mts [userId] [--apply]
// DRY RUN BY DEFAULT: without --apply it only reports what WOULD be promoted.
import "dotenv/config";
import { db } from "../app/lib/drizzle-db";
import { users } from "../app/db/schema";
import { reconcileSkippedEquityPostings } from "../app/lib/ledger-service";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const filterUserId = args.find((a) => !a.startsWith("--"));

  const rows = filterUserId
    ? [{ id: filterUserId }]
    : await db.select({ id: users.id }).from(users).execute();

  const summary = {
    scanned: 0,
    promotable: 0,
    promoted: 0,
    stillSkipped: 0,
  };

  console.log(
    apply
      ? "[reconcile] MODE: APPLY (rows WILL be promoted)"
      : "[reconcile] MODE: DRY RUN (report only, NO writes — use --apply to promote)"
  );

  for (const { id } of rows) {
    try {
      const result = await reconcileSkippedEquityPostings(id, { apply });
      summary.scanned += result.scanned;
      summary.promotable += result.promotable;
      summary.promoted += result.promoted;
      summary.stillSkipped += result.stillSkipped.length;
      console.log(
        `[reconcile] user=${id} scanned=${result.scanned} promotable=${result.promotable} promoted=${result.promoted} stillSkipped=${result.stillSkipped.length} (dryRun=${result.dryRun})`
      );
      for (const s of result.stillSkipped) {
        console.log(`    still SKIPPED ${s.transactionId}: ${s.reason}`);
      }
    } catch (error) {
      console.error(`[reconcile] user=${id} FAILED`, error);
    }
  }

  console.log(
    `\n[reconcile] done. scanned=${summary.scanned} promotable=${summary.promotable} promoted=${summary.promoted} stillSkipped=${summary.stillSkipped}`
  );
  process.exit(0);
}

void main();