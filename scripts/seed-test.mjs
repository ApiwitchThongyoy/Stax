// W2-9 test seed — runs ONLY against TEST_DATABASE_URL.
// Never points at the production DATABASE_URL. Exits with a clear message if
// TEST_DATABASE_URL is not set. Idempotent: safe to re-run without creating
// duplicate users, transactions, or documents.
import "dotenv/config";
import postgres from "postgres";
import bcrypt from "bcryptjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "\n[ABORT] TEST_DATABASE_URL is not set. Aborting test seed.\n" +
      "Set TEST_DATABASE_URL to a throwaway database (never production) and re-run.\n"
  );
  process.exit(1);
}

const client = postgres(databaseUrl, { max: 1 });
const BCRYPT_ROUNDS = 10;

// Reuse the existing project test-account convention (test.local). USER A
// reuses the existing w1user account, ADMIN reuses w1admin. USER B is a second
// distinct USER account used for isolation tests.
const ACCOUNTS = [
  {
    key: "ADMIN",
    email: "w1admin@test.local",
    password: "W1Admin!234",
    role: "ADMIN",
    status: "ACTIVE",
  },
  {
    key: "USER_A",
    email: "w1user@test.local",
    password: "W1User!234",
    role: "USER",
    status: "ACTIVE",
  },
  {
    key: "USER_B",
    email: "w2userb@test.local",
    password: "W2UserB!234",
    role: "USER",
    status: "ACTIVE",
  },
];

// Deterministic sample transactions for USER A only (matching the real schema).
const USER_A_TRANSACTIONS = [
  {
    transactionId: "00000000-0000-0000-0000-0000000000a1",
    amountForeign: "1000.00",
    currency: "USD",
    transactionDate: "2026-01-05",
    fxRateBot: "35.4200",
    amountThb: "35420.00",
    type: "CASH_IN",
    // source_document_id set below to the seeded document for USER A.
  },
  {
    transactionId: "00000000-0000-0000-0000-0000000000a2",
    amountForeign: "500.00",
    currency: "USD",
    transactionDate: "2026-01-20",
    fxRateBot: "35.1000",
    amountThb: "17550.00",
    type: "CASH_OUT",
  },
];

async function ensureUser(account) {
  const existing = await client`SELECT id FROM "User" WHERE email = ${account.email} LIMIT 1`;
  if (existing.length > 0) {
    const id = existing[0].id;
    await client`UPDATE "User" SET role = ${account.role}, status = ${account.status} WHERE id = ${id}`;
    console.log(
      `  [${account.key}] ${account.email} already exists, ensured role=${account.role} status=${account.status}.`
    );
    return { id, created: false };
  }

  const passwordHash = await bcrypt.hash(account.password, BCRYPT_ROUNDS);
  const id = crypto.randomUUID();
  await client`INSERT INTO "User" (id, email, password_hash, role, status) VALUES (${id}, ${account.email}, ${passwordHash}, ${account.role}, ${account.status})`;
  console.log(`  [${account.key}] created ${account.email} (${account.role}).`);
  return { id, created: true };
}

async function seed() {
  console.log("Seeding TEST database...\n");

  const ids = {};
  for (const account of ACCOUNTS) {
    ids[account.key] = await ensureUser(account);
  }

  // Sample document metadata for USER A (overwrite a stale previous run if any).
  const docId = "00000000-0000-0000-0000-0000000000d1";
  await client`DELETE FROM documents WHERE id = ${docId}`;
  await client`INSERT INTO documents (id, user_id, original_name, file_path, mime_type, file_size, created_at, updated_at)
               VALUES (${docId}, ${ids.USER_A.id}, 'statement_W2_9_sample.pdf', 'storage/test/statement_W2_9_sample.pdf', 'application/pdf', 12345, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  console.log("  [USER_A] seeded sample document.");

  // Deterministic sample transactions for USER A (only if not already present).
  for (const t of USER_A_TRANSACTIONS) {
    const exists = await client`SELECT transaction_id FROM "Capital_Transactions" WHERE transaction_id = ${t.transactionId} LIMIT 1`;
    if (exists.length > 0) {
      console.log(`  [USER_A] transaction ${t.transactionId} already exists.`);
      continue;
    }
    await client`INSERT INTO "Capital_Transactions"
                 (transaction_id, user_id, amount_foreign, currency, transaction_date, fx_rate_bot, amount_thb, type, source_type, source_document_id)
                 VALUES (${t.transactionId}, ${ids.USER_A.id}, ${t.amountForeign}, ${t.currency}, ${t.transactionDate}, ${t.fxRateBot}, ${t.amountThb}, ${t.type}, 'MANUAL', ${docId})`;
    console.log(`  [USER_A] seeded transaction ${t.transactionId}.`);
  }

  console.log("\nTest seed complete.");
  await client.end();
}

seed().catch(async (err) => {
  console.error("Test seed failed:", err);
  await client.end();
  process.exit(1);
});
