import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("User", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("USER"),
});

export const capitalTransactions = sqliteTable(
  "Capital_Transactions",
  {
    transactionId: text("transaction_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    amountForeign: text("amount_foreign").notNull(),
    currency: text("currency").notNull(),
    transactionDate: text("transaction_date").notNull(),
    fxRateBot: text("fx_rate_bot").notNull(),
    amountThb: text("amount_thb").notNull(),
    type: text("type").notNull(),
    sourceType: text("source_type").notNull(),
  },
  (table) => [index("Capital_Transactions_user_id_idx").on(table.userId)]
);
