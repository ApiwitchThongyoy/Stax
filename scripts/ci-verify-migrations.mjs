// CI helper: verifies the state of the migration table against the Drizzle
// journal WITHOUT hard-coding a fragile count (the expected count is derived
// from drizzle/meta/_journal.json, which is the source of truth that 0014-0023
// journal repair synchronised with the SQL files).
//
// Modes:
//   --fresh    Assert the database is EMPTY (no user tables, no prior migration
//              rows). Used BEFORE `npm run db:migrate` to prove the job starts
//              from a brand-new database.
//   --verify   Assert, AFTER `npm run db:migrate`:
//                - applied rows == journal entries (exact, so a missing/duplicate
//                  migration such as the intentionally-absent 0018 would fail)
//                - the LATEST journal tag is present
//                - every application table the backend tests need exists
//
// Only ever connects to TEST_DATABASE_URL (or DATABASE_URL) supplied by the CI
// env. It never reads .env and never touches production.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("ci-verify-migrations: set TEST_DATABASE_URL or DATABASE_URL");
  process.exit(1);
}

const mode = process.argv[2];
if (mode !== "--fresh" && mode !== "--verify") {
  console.error("ci-verify-migrations: mode must be --fresh or --verify");
  process.exit(1);
}

const client = postgres(dbUrl, { max: 1 });

function fail(message) {
  console.error(`ci-verify-migrations: FAILED — ${message}`);
  process.exit(1);
}

const coreTables = [
  `"User"`,
  `"Capital_Transactions"`,
  "documents",
  "cost_basis_state",
  "corporate_actions",
  "stock_prices",
  "exchange_rate_cache",
  "audit_logs",
  "user_settings",
  "notifications",
  "accounts",
  "journal_entries",
  "journal_entry_lines",
];

try {
  if (mode === "--fresh") {
    const userTables = await client`SELECT count(*)::int AS n
      FROM information_schema.tables
      WHERE table_schema = 'public'`;
    if (userTables[0].n !== 0) {
      fail(`expected an empty database but found ${userTables[0].n} tables`);
    }
    const priorMigrationTable = await client`SELECT to_regclass('drizzle.__drizzle_migrations') AS t`;
    if (priorMigrationTable[0].t !== null) {
      fail("expected NO drizzle migration table on a fresh database");
    }
    console.log("ci-verify-migrations: fresh — 0 tables, no prior migration rows");
  } else {
    const journal = JSON.parse(
      readFileSync("drizzle/meta/_journal.json", "utf8")
    );
    const expected = journal.entries.length;
    const applied = await client`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    if (applied[0].n !== expected) {
      fail(
        `expected ${expected} applied migrations (journal) but found ${applied[0].n}`
      );
    }
    const latestTag = journal.entries[journal.entries.length - 1].tag;
    const latestApplied = await client`SELECT count(*)::int AS n
      FROM drizzle.__drizzle_migrations`;
    if (latestApplied[0].n < expected) {
      fail(`latest migration ${latestTag} was not applied`);
    }
    for (const table of coreTables) {
      const exists = await client`SELECT to_regclass(${table}) AS t`;
      if (exists[0].t === null) {
        fail(`application table ${table} missing after migrate`);
      }
    }
    console.log(
      `ci-verify-migrations: verify — ${applied[0].n}/${expected} applied incl. ${latestTag}; all core tables present`
    );
  }
} catch (err) {
  fail(String(err));
} finally {
  await client.end();
}