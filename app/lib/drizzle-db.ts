import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";

// Runtime database selection.
//
// Normal `npm run dev` / production builds use DATABASE_URL. A shell-exported
// TEST_DATABASE_URL must NEVER silently redirect the application to a throwaway
// database. Tests opt in explicitly by setting USE_TEST_DATABASE=1; their
// isolated harness (scripts/run-tests.mts) already refuses to run when
// TEST_DATABASE_URL is missing.
const useTestDatabase =
  process.env.USE_TEST_DATABASE === "1" ||
  process.env.NODE_ENV === "test";

const databaseUrl = useTestDatabase
  ? process.env.TEST_DATABASE_URL
  : process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "No database connection string is set. Please configure " +
      (useTestDatabase ? "TEST_DATABASE_URL (for tests)" : "DATABASE_URL (for production)") +
      "."
  );
}

// SSL decision. Local/test Postgres (no TLS) must stay unencrypted, while
// hosted/pooled databases (Supabase) require TLS. Detection covers the common
// Supabase host patterns, an explicit sslmode=require in the URL, and a manual
// DATABASE_SSL=require override. Never guess TLS on/off based on the URL host
// alone: a shared pooler must speak TLS or the connection fails outright.
function sslRequiredFor(databaseUrl: string): boolean {
  if (process.env.DATABASE_SSL === "require") return true;
  if (/(?:[?&]sslmode=require)/i.test(databaseUrl)) return true;
  const hostname = (databaseUrl.replace(/^[^@]+@/, "").split("/")[0] ?? "").toLowerCase();
  return /(^|\.)(supabase\.co|pooler\.supabase\.com)(:\d+)?$/.test(hostname);
}

// Connection options tuned for serverless/pooled Postgres (Supabase, pgBouncer):
//  - max: 1 — a single multiplexed connection (the app is a single process;
//    the runtime does not need a loose pool, and the pooler caps it anyway).
//  - prepare: false — disables named prepared statements. Under a transaction
//    pooler, prepared statements are scoped to a backend connection; when the
//    pooler recycles connections mid-flow the next EXECUTE fails with
//    `26000: prepared statement "..." does not exist`, surfacing as a
//    committed-but-empty import. Re-parsing instead of re-preparing makes every
//    statement session-independent.
//  - ssl: "require" — only when hosted/pooled; local test SQLite-style Postgres
//    stays plain.
const client = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  ...(sslRequiredFor(databaseUrl) ? { ssl: "require" } : {}),
});

export const db = drizzle(client, { schema });
