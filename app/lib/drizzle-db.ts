import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL environment variable is not set. Please configure your PostgreSQL connection string."
  );
}

const client = postgres(databaseUrl);

export const db = drizzle(client, { schema });
