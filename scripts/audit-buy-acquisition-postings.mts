// Read-only audit for historical STATEMENT BUY postings created before the
// fee-inclusive acquisition-cost policy. It intentionally has no --apply path.
// Run only against a throwaway clone/database via TEST_DATABASE_URL.
import "./_load-env.mjs";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
if (!databaseUrl) {
  console.error("TEST_DATABASE_URL is required; refusing to inspect DATABASE_URL");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });
try {
  const candidates = await sql`
    SELECT
      je.user_id,
      je.id AS journal_entry_id,
      je.entry_no,
      je.source_transaction_id,
      ct.symbol,
      ct.net_amount,
      ct.amount_foreign,
      COUNT(jel.id)::int AS line_count,
      COUNT(*) FILTER (WHERE accounts.code = '5010')::int AS fee_line_count
    FROM journal_entries je
    JOIN "Capital_Transactions" ct
      ON ct.transaction_id = je.source_transaction_id
     AND ct.user_id = je.user_id
    LEFT JOIN journal_entry_lines jel
      ON jel.journal_entry_id = je.id
     AND jel.user_id = je.user_id
    LEFT JOIN accounts
      ON accounts.id = jel.account_id
     AND accounts.user_id = je.user_id
    WHERE je.source_type = 'STATEMENT'
      AND je.posting_state = 'POSTED'
      AND je.side = 'BUY'
    GROUP BY
      je.user_id, je.id, je.entry_no, je.source_transaction_id,
      ct.symbol, ct.net_amount, ct.amount_foreign
    HAVING COUNT(*) FILTER (WHERE accounts.code = '5010') > 0
    ORDER BY je.user_id, je.entry_no
  `;

  console.log("=== BUY ACQUISITION POSTING AUDIT (DRY RUN ONLY) ===");
  console.log(`Candidates requiring historical review: ${candidates.length}`);
  for (const row of candidates) {
    console.log(JSON.stringify(row));
  }
  console.log("No writes performed; no --apply mode exists in this audit.");
} finally {
  await sql.end({ timeout: 5 });
}
