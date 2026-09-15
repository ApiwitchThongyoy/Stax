// Restore the ORIGINAL pre-correction 4020 (dividend) STATEMENT entries that were
// deleted by cleanup-ledger-4020.mts.
//
// Context: before the revenue-category corrections, the statement parser emitted
// — for EVERY computable SELL — BOTH the asset SELL row (gain -> 4010) AND a
// duplicate income row (section "กำไรจากการขายหุ้น") that was posted to the
// DIVIDEND account (4020). The revenue-categories fix stopped new postings and
// cleanups DELETED those 33 historical entries (28 with a surviving source row
// + 5 orphaned for one user whose source rows were also deleted). The user
// decided to go back to the pre-correction baseline before making a new plan,
// so this script recreates the 28 that are reconstructable.
//
// Income row -> Dr cash (1020, USD) / Cr 4020, amount = source amount_foreign,
// fx = source fx_rate_effective, fxRateStatement = source fx_rate_statement,
// date = source transaction_date, description "กำไรจากการขายหุ้น",
// sourceType STATEMENT, sourceTransactionId = source transaction_id,
// sourceDocumentId = source source_document_id, memo NULL (the original parser
// had no symbol memo then).
//
// Idempotent: an existing STATEMENT entry with the same source transaction id
// and a 4020 line is skipped. Nothing is deleted.
//
// Run:  npx tsx scripts/restore-ledger-4020-original.mts [userId] [--dry-run]
import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { db } from "../app/lib/drizzle-db";
import { users, capitalTransactions, journalEntries, journalEntryLines } from "../app/db/schema";
import { createJournalEntry, getAccounts } from "../app/lib/ledger-service";
import type { JournalLineInput } from "../app/lib/general-ledger";

const CASH_USD = "1020";
const DIVIDEND_ACCOUNT = "4020";
const KEEP_SECTION = "กำไรจากการขายหุ้น";

async function main() {
  const filterUserId = process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2]
    : undefined;
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("[restore-4020] DRY RUN — no changes written\n");

  const userRows = filterUserId
    ? [{ id: filterUserId }]
    : await db.select({ id: users.id }).from(users).execute();

  const report: string[] = [];
  let restoredTotal = 0;
  let skippedTotal = 0;

  for (const { id } of userRows) {
    try {
      const result = await restoreUser(id, dryRun);
      restoredTotal += result.restored;
      skippedTotal += result.skipped;
      if (result.restored > 0 || result.skipped > 0) {
        report.push(
          `user=${id}\n    restored=${result.restored} skippedAlreadyExists=${result.skipped}`
        );
      }
    } catch (error) {
      console.error(`[restore-4020] user=${id} FAILED`, error);
    }
  }

  if (report.length > 0) {
    console.log(report.join("\n"));
    console.log("");
  }

  console.log(
    `[restore-4020] done. users=${userRows.length} restored=${restoredTotal} ` +
      `skippedAlreadyExists=${skippedTotal} ${dryRun ? "[dry]" : ""}`
  );
  process.exit(0);
}

async function restoreUser(userId: string, dryRun: boolean) {
  const accounts = await getAccounts(userId);
  const cashId = accounts.find((a) => a.code === CASH_USD)?.id ?? null;
  const dividendId = accounts.find((a) => a.code === DIVIDEND_ACCOUNT)?.id ?? null;
  if (!cashId || !dividendId) {
    throw new Error(`missing ${CASH_USD}/${DIVIDEND_ACCOUNT} accounts for ${userId}`);
  }

  const sourceRows = await db
    .select()
    .from(capitalTransactions)
    .where(and(
      eq(capitalTransactions.userId, userId),
      eq(capitalTransactions.category, "income"),
      eq(capitalTransactions.section, KEEP_SECTION)
    ))
    .orderBy(capitalTransactions.transactionDate, capitalTransactions.transactionId)
    .execute();

  let restored = 0;
  let skipped = 0;

  for (const row of sourceRows) {
    if (!row.transactionId) continue;

    const existing = await db
      .select({ id: journalEntryLines.id })
      .from(journalEntryLines)
      .innerJoin(journalEntries, and(
        eq(journalEntryLines.journalEntryId, journalEntries.id),
        eq(journalEntryLines.userId, journalEntries.userId)
      ))
      .where(and(
        eq(journalEntries.userId, userId),
        eq(journalEntries.sourceType, "STATEMENT"),
        eq(journalEntries.sourceTransactionId, row.transactionId),
        eq(journalEntryLines.accountId, dividendId)
      ))
      .limit(1)
      .execute();
    if (existing.length > 0) {
      skipped++;
      continue;
    }

    const amount = row.amountForeign?.toString() ?? "";
    if (!amount || Number(amount) <= 0) {
      console.error(`    [skip] ${row.transactionId}: missing a valid amount — cannot restore`);
      continue;
    }
    // amount_thb is derived from fxRateEffective exactly like the ledger engine
    // does (validateJournalEntry: amountThb = amount * fxRateEffective), so no
    // manual THB figure is passed.
    const fxRateEffective = row.fxRateEffective ?? "1";
    const fxRateStatement = row.fxRateStatement ?? null;

    const lines: JournalLineInput[] = [
      {
        accountId: cashId,
        currency: row.currency ?? "USD",
        debit: amount,
        fxRateEffective,
        fxRateStatement,
      },
      {
        accountId: dividendId,
        currency: row.currency ?? "USD",
        credit: amount,
        fxRateEffective,
        fxRateStatement,
      },
    ];

    if (dryRun) {
      restored++;
      continue;
    }

    const result = await createJournalEntry(userId, {
      entryDate: row.transactionDate,
      description: KEEP_SECTION,
      sourceType: "STATEMENT" as const,
      sourceDocumentId: row.sourceDocumentId ?? null,
      sourceTransactionId: row.transactionId,
      lines,
    });
    if (result.ok) {
      restored++;
    } else {
      console.error(`    [FAIL] ${row.transactionId}: ${result.errors.join("; ")}`);
    }
  }

  return { restored, skipped };
}

void main();