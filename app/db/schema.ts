import {
  pgTable,
  text,
  numeric,
  integer,
  boolean,
  index,
  uniqueIndex,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const users = pgTable("User", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("USER"),
  status: text("status").notNull().default("ACTIVE"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
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
    sourceDocumentId: text("source_document_id"),
  },
  (table) => [
    index("Capital_Transactions_user_id_idx").on(table.userId),
    index("Capital_Transactions_source_document_id_idx").on(
      table.sourceDocumentId
    ),
  ]
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

export const dailyTaxSummaries = pgTable(
  "daily_tax_summaries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    summaryDate: text("summary_date").notNull(),
    totalAmountThb: numeric("total_amount_thb").notNull(),
    totalTaxAmount: numeric("total_tax_amount"),
    transactionCount: integer("transaction_count").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("daily_tax_summaries_user_id_idx").on(table.userId),
    index("daily_tax_summaries_summary_date_idx").on(table.summaryDate),
    uniqueIndex("daily_tax_summaries_user_date_idx").on(
      table.userId,
      table.summaryDate
    ),
  ]
);

export const exchangeRateCache = pgTable(
  "exchange_rate_cache",
  {
    id: text("id").primaryKey(),
    rateDate: text("rate_date").notNull(),
    currency: text("currency").notNull(),
    rate: numeric("rate").notNull(),
    source: text("source"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("exchange_rate_cache_date_currency_idx").on(
      table.rateDate,
      table.currency
    ),
    index("exchange_rate_cache_rate_date_idx").on(table.rateDate),
    index("exchange_rate_cache_currency_idx").on(table.currency),
  ]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    details: jsonb("details"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("audit_logs_user_id_idx").on(table.userId),
    index("audit_logs_created_at_idx").on(table.createdAt),
    index("audit_logs_action_idx").on(table.action),
  ]
);

export const userSettings = pgTable("user_settings", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  notificationEnabled: boolean("notification_enabled")
    .notNull()
    .default(true),
  emailNotificationEnabled: boolean("email_notification_enabled")
    .notNull()
    .default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    message: text("message").notNull(),
    type: text("type").notNull().default("SYSTEM"),
    isRead: boolean("is_read").notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("notifications_user_id_idx").on(table.userId),
    index("notifications_user_read_idx").on(table.userId, table.isRead),
  ]
);
