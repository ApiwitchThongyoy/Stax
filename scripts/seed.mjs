import "dotenv/config";
import postgres from "postgres";
import bcrypt from "bcryptjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Error: DATABASE_URL environment variable is not set.");
  process.exit(1);
}

const client = postgres(databaseUrl);

const SEED_ACCOUNTS = [
  {
    email: "w1admin@test.local",
    password: "W1Admin!234",
    role: "ADMIN",
    status: "ACTIVE",
  },
  {
    email: "w1user@test.local",
    password: "W1User!234",
    role: "USER",
    status: "ACTIVE",
  },
];

const BCRYPT_ROUNDS = 10;

async function seed() {
  console.log("Seeding database...");

  for (const account of SEED_ACCOUNTS) {
    const existing = await client`SELECT id FROM "User" WHERE email = ${account.email} LIMIT 1`;

    if (existing.length > 0) {
      console.log(`  User ${account.email} already exists, skipping.`);
      continue;
    }

    const passwordHash = await bcrypt.hash(account.password, BCRYPT_ROUNDS);
    const id = crypto.randomUUID();

    await client`INSERT INTO "User" (id, email, password_hash, role, status) VALUES (${id}, ${account.email}, ${passwordHash}, ${account.role}, ${account.status})`;

    console.log(`  Created ${account.role}: ${account.email}`);
  }

  console.log("Seeding complete.");
  await client.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
