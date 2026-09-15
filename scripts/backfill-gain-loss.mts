// One-shot gain/loss backfill for existing ledgers.
//
// Points at whatever DATABASE_URL is set (currently the local dev Postgres on
// :55432). Heals FROZEN AI_PARSED SELL rows — rows whose realized gain/loss was
// left NULL because the supporting BUY was imported in a later statement — by
// replaying the full ledger chronologically and filling ONLY the holes (never
// overwrites values, never touches MANUAL rows, uses only stored FX).
//
// Safe to re-run: after the first run the filled rows carry a value, so the
// second run is a no-op (skippedAlready).
//
// Run:  npx tsx scripts/backfill-gain-loss.mts [userId]
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../app/lib/drizzle-db";
import { users } from "../app/db/schema";
import { backfillComputedGainLoss } from "../app/lib/statement-pipeline";

async function main() {
  const filterUserId = process.argv[2];

  const rows = filterUserId
    ? [{ id: filterUserId }]
    : await db.select({ id: users.id }).from(users).execute();

  let totalFilled = 0;
  for (const { id } of rows) {
    try {
      const stats = await backfillComputedGainLoss(id);
      totalFilled += stats.filled;
      console.log(
        `[backfill] user=${id} filled=${stats.filled} ` +
          `skippedAlready=${stats.skippedAlready} skippedManual=${stats.skippedManual} ` +
          `stillNonComputable=${stats.stillNonComputable}`
      );
    } catch (error) {
      console.error(`[backfill] user=${id} FAILED`, error);
    }
  }
  console.log(`\n[backfill] done. Total rows filled: ${totalFilled}`);
  // postgres.js keeps its socket open; exit explicitly so the CLI terminates.
  process.exit(totalFilled > 0 ? 0 : 0);
}

void main();