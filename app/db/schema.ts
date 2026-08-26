import { pgTable, text, numeric, integer, index, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("User", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("USER"),
  status: text("status").notNull().default("ACTIVE"),
});

export const capitalTransactions = pgTable(
  "Capital_Transactions",
  {
    transactionId: text("transaction_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    amountForeign: numeric("amount_foreign").notNull(),
    currency: text("currency").notNull(),
    transactionDate: text("transaction_date").notNull(),
    fxRateBot: numeric("fx_rate_bot").notNull(),
    amountThb: numeric("amount_thb").notNull(),
    type: text("type").notNull(),
    sourceType: text("source_type").notNull(),
  },
  (table) => [index("Capital_Transactions_user_id_idx").on(table.userId)]
);

export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    originalName: text("original_name").notNull(),
    filePath: text("file_path").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("documents_user_id_idx").on(table.userId)]
);
