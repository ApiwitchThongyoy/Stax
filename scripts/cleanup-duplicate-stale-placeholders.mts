/**
 * Safe cleanup script for stale duplicate journal entry placeholders.
 *
 * When the accounting pipeline promoted 24 previously SKIPPED statement transactions
 * to POSTED, valid POSTED entries with full debit/credit lines were created.
 * However, the legacy 0-line SKIPPED placeholders remained in the table.
 *
 * This script identifies and safely cleans up ONLY these duplicate stale placeholders.
 *
 * Eligibility for deletion requires ALL of the following strict conditions:
 *   1. The same source_transaction_id has another journal with posting_state='POSTED'
 *   2. The candidate stale row has posting_state='SKIPPED'
 *   3. The stale row has ZERO journal_entry_lines
 *   4. The stale row is clearly a legacy statement placeholder (sourceType='STATEMENT')
 *   5. The valid POSTED journal has >= 1 journal_entry_lines and remains UNTOUCHED.
 *
 * DEFAULT MODE IS DRY RUN (zero database writes).
 * To execute actual deletion, run with the explicit flag: --apply
 *
 * Usage:
 *   node ./node_modules/tsx/dist/cli.mjs scripts/cleanup-duplicate-stale-placeholders.mts
 *   node ./node_modules/tsx/dist/cli.mjs scripts/cleanup-duplicate-stale-placeholders.mts --apply
 */

import "dotenv/config";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../app/lib/drizzle-db";
import { journalEntries, journalEntryLines } from "../app/db/schema";

export interface StalePlaceholderCandidate {
  sourceTransactionId: string;
  userId: string;
  staleJournalId: string;
  staleEntryNo: number;
  stalePostingState: string;
  staleLineCount: number;
  validJournalId: string;
  validEntryNo: number;
  validPostingState: string;
  validLineCount: number;
  skipReason: string | null;
}

export interface CleanupResult {
  dryRun: boolean;
  totalCandidates: number;
  deletedCount: number;
  candidates: StalePlaceholderCandidate[];
}

export interface RawJournalRecord {
  id: string;
  userId: string;
  entryNo: number;
  sourceType: string;
  sourceTransactionId: string | null;
  status: string;
  postingState: string;
  skipReason: string | null;
  lineCount: number;
}

export function identifyStaleDuplicatesPure(
  entries: RawJournalRecord[]
): StalePlaceholderCandidate[] {
  const entriesBySource = new Map<string, RawJournalRecord[]>();
  for (const entry of entries) {
    if (!entry.sourceTransactionId) continue;
    const key = `${entry.userId}:${entry.sourceTransactionId}`;
    const list = entriesBySource.get(key) ?? [];
    list.push(entry);
    entriesBySource.set(key, list);
  }

  const candidates: StalePlaceholderCandidate[] = [];

  for (const [_, group] of entriesBySource) {
    // Condition 1: Must have exactly one journal with posting_state = 'POSTED' and status = 'POSTED'
    const postedEntries = group.filter(
      (e) => e.postingState === "POSTED" && e.status === "POSTED"
    );

    // Condition 2: Candidate must have posting_state = 'SKIPPED'
    const skippedEntries = group.filter((e) => e.postingState === "SKIPPED");

    if (postedEntries.length !== 1 || skippedEntries.length === 0) {
      continue;
    }

    const validPosted = postedEntries[0];

    // Condition 5: Valid POSTED journal must have lines (not empty)
    if (validPosted.lineCount === 0) {
      continue;
    }

    for (const stale of skippedEntries) {
      // Condition 3: Candidate stale row must have EXACTLY ZERO lines
      if (stale.lineCount !== 0) {
        continue;
      }

      // Condition 4: Stale row is clearly a legacy statement placeholder
      if (stale.sourceType !== "STATEMENT") {
        continue;
      }

      candidates.push({
        sourceTransactionId: stale.sourceTransactionId!,
        userId: stale.userId,
        staleJournalId: stale.id,
        staleEntryNo: stale.entryNo,
        stalePostingState: stale.postingState,
        staleLineCount: 0,
        validJournalId: validPosted.id,
        validEntryNo: validPosted.entryNo,
        validPostingState: validPosted.postingState,
        validLineCount: validPosted.lineCount,
        skipReason: stale.skipReason,
      });
    }
  }

  return candidates;
}

export async function findStaleDuplicatePlaceholders(): Promise<StalePlaceholderCandidate[]> {
  // 1. Fetch all statement journal entries that have a source_transaction_id
  const statementEntries = await db
    .select({
      id: journalEntries.id,
      userId: journalEntries.userId,
      entryNo: journalEntries.entryNo,
      sourceType: journalEntries.sourceType,
      sourceTransactionId: journalEntries.sourceTransactionId,
      status: journalEntries.status,
      postingState: journalEntries.postingState,
      skipReason: journalEntries.skipReason,
      createdAt: journalEntries.createdAt,
    })
    .from(journalEntries)
    .where(and(eq(journalEntries.sourceType, "STATEMENT")))
    .execute();

  // Group by (userId, sourceTransactionId)
  const entriesBySource = new Map<string, typeof statementEntries>();
  for (const entry of statementEntries) {
    if (!entry.sourceTransactionId) continue;
    const key = `${entry.userId}:${entry.sourceTransactionId}`;
    const list = entriesBySource.get(key) ?? [];
    list.push(entry);
    entriesBySource.set(key, list);
  }

  // Filter to groups with > 1 entry
  const duplicateGroups = [...entriesBySource.entries()].filter(([_, list]) => list.length > 1);

  if (duplicateGroups.length === 0) {
    return [];
  }

  // Collect all entry IDs in duplicate groups to query line counts in batch
  const allEntryIds = duplicateGroups.flatMap(([_, list]) => list.map((e) => e.id));
  const lineCountsRaw = await db
    .select({
      journalEntryId: journalEntryLines.journalEntryId,
      count: sql<number>`count(*)::int`,
    })
    .from(journalEntryLines)
    .where(inArray(journalEntryLines.journalEntryId, allEntryIds))
    .groupBy(journalEntryLines.journalEntryId)
    .execute();

  const lineCountMap = new Map<string, number>();
  for (const row of lineCountsRaw) {
    lineCountMap.set(row.journalEntryId, Number(row.count));
  }

  const rawRecords: RawJournalRecord[] = statementEntries.map((e) => ({
    id: e.id,
    userId: e.userId,
    entryNo: e.entryNo,
    sourceType: e.sourceType,
    sourceTransactionId: e.sourceTransactionId,
    status: e.status,
    postingState: e.postingState,
    skipReason: e.skipReason,
    lineCount: lineCountMap.get(e.id) ?? 0,
  }));

  return identifyStaleDuplicatesPure(rawRecords);
}

export async function runDuplicateCleanup(opts: { apply?: boolean } = {}): Promise<CleanupResult> {
  const isApply = opts.apply === true;
  const candidates = await findStaleDuplicatePlaceholders();

  if (!isApply) {
    return {
      dryRun: true,
      totalCandidates: candidates.length,
      deletedCount: 0,
      candidates,
    };
  }

  // Execute deletion strictly in an atomic transaction
  let deletedCount = 0;
  await db.transaction(async (tx) => {
    for (const cand of candidates) {
      // Extra safety assert: verify zero lines exist before deleting
      const [lineCheck] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(journalEntryLines)
        .where(eq(journalEntryLines.journalEntryId, cand.staleJournalId))
        .execute();

      if (Number(lineCheck?.count ?? 0) !== 0) {
        throw new Error(
          `Safety violation: journal ${cand.staleJournalId} has ${lineCheck?.count} lines! Aborting cleanup.`
        );
      }

      // Verify the valid POSTED journal still exists and has lines
      const [validCheck] = await tx
        .select({
          postingState: journalEntries.postingState,
          status: journalEntries.status,
        })
        .from(journalEntries)
        .where(eq(journalEntries.id, cand.validJournalId))
        .execute();

      if (!validCheck || validCheck.postingState !== "POSTED") {
        throw new Error(
          `Safety violation: valid journal ${cand.validJournalId} is missing or not POSTED! Aborting.`
        );
      }

      // Safe to delete the stale 0-line placeholder
      await tx
        .delete(journalEntries)
        .where(
          and(
            eq(journalEntries.id, cand.staleJournalId),
            eq(journalEntries.userId, cand.userId),
            eq(journalEntries.postingState, "SKIPPED")
          )
        )
        .execute();

      deletedCount++;
    }
  });

  return {
    dryRun: false,
    totalCandidates: candidates.length,
    deletedCount,
    candidates,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");

  console.log("===============================================================");
  console.log("STAX DUPLICATE STALE PLACEHOLDER CLEANUP");
  console.log(`Mode: ${apply ? "APPLY (writes will be committed)" : "DRY RUN (zero writes)"}`);
  console.log("===============================================================\n");

  const result = await runDuplicateCleanup({ apply });

  console.log(`Found ${result.totalCandidates} stale duplicate candidate(s):\n`);

  for (let i = 0; i < result.candidates.length; i++) {
    const c = result.candidates[i];
    console.log(
      `[Candidate #${i + 1}] Source Tx: ${c.sourceTransactionId}\n` +
      `  Stale Journal ID: ${c.staleJournalId} (entryNo #${c.staleEntryNo}, ${c.stalePostingState}, lines: ${c.staleLineCount})\n` +
      `  Valid Journal ID: ${c.validJournalId} (entryNo #${c.validEntryNo}, ${c.validPostingState}, lines: ${c.validLineCount})\n` +
      `  Skip Reason: ${c.skipReason ?? "none"}\n`
    );
  }

  console.log("======================= SUMMARY ===============================");
  console.log(`Total Candidates Identified: ${result.totalCandidates}`);
  console.log(`Total Deleted:               ${result.deletedCount}`);
  console.log(`Mode:                        ${result.dryRun ? "DRY RUN (no rows modified)" : "APPLIED"}`);
  console.log("===============================================================");

  if (!apply && result.totalCandidates > 0) {
    console.log("\nTo apply deletion of these stale placeholders, re-run with --apply:");
    console.log("  node ./node_modules/tsx/dist/cli.mjs scripts/cleanup-duplicate-stale-placeholders.mts --apply");
  }

  process.exit(0);
}

if (process.argv[1]?.endsWith("cleanup-duplicate-stale-placeholders.mts")) {
  main().catch((err) => {
    console.error("Cleanup failed:", err);
    process.exit(1);
  });
}
