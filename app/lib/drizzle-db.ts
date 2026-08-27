import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = testDatabaseUrl || process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "No database connection string is set. Please configure TEST_DATABASE_URL (for tests) or DATABASE_URL (for production)."
  );
}

const client = postgres(databaseUrl);

export const db = drizzle(client, { schema });
