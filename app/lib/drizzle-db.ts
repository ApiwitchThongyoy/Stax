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

const client = postgres(databaseUrl);

export const db = drizzle(client, { schema });
