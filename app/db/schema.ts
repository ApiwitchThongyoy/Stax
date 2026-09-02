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
import { sql } from "drizzle-orm";

export const users = pgTable("User", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("USER"),
  status: text("status").notNull().default("ACTIVE"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }),
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
    // FX rate column (legacy, kept for data compatibility). The statement
    // importer NEVER writes to it (statement/provider rates go elsewhere); the
    // manual capital-ledger form may store a user-entered rate here. Nullable so
    // historical/imported rows migrate cleanly. Deprecated: not used as an FX
    // source by either the importer or the tax core.
    fxRateBot: numeric("fx_rate_bot"),
    amountThb: numeric("amount_thb").notNull(),
    type: text("type").notNull(),
    sourceType: text("source_type").notNull(),
    sourceDocumentId: text("source_document_id"),
    // ---- Trade detail (realized capital gains, migration 0009) ----
    // Symbol/ticker of the traded asset when this row originates from a
    // statement TRADE RECORDS line (BUY/SELL). Null for deposits, dividends,
    // fees, currency exchanges and other non-trade rows.
    symbol: text("symbol"),
    // "BUY" | "SELL" for trade rows, else null.
    side: text("side"),
    // Quantity traded, in units of the symbol (may be fractional).
    quantity: numeric("quantity"),
    // Per-unit execution price, in the transaction currency.
    unitPrice: numeric("unit_price"),
    // Principal of the trade = unit_price * quantity, in transaction currency.
    grossAmount: numeric("gross_amount"),
    // Broker commission + VAT for this single trade, in transaction currency.
    fees: numeric("fees"),
    // Gross sale proceeds = unit_price * quantity (SELL rows only).
    proceeds: numeric("proceeds"),
    // Acquisition cost of the sold quantity = running average cost * quantity
    // (SELL rows only). Computed deterministically server-side.
    costBasis: numeric("cost_basis"),
    // Realized gain/loss = proceeds - cost_basis, in transaction currency
    // (SELL rows only). null explicitly = not computable (no prior history).
    realizedGainLoss: numeric("realized_gain_loss"),
    // Same realized gain/loss converted to THB using fx_rate_effective. This is
    // the authoritative input for the tax core engine.
    realizedGainLossThb: numeric("realized_gain_loss_thb"),
    // FX rate to THB as PROVIDED BY THE SOURCE STATEMENT (its "XXX/THB = N"
    // header), when the statement states one. Never a provider/guessed rate.
    fxRateStatement: numeric("fx_rate_statement"),
    // The FX rate actually used for THB conversion of this row
    // (fxRateStatement, else a historical provider fallback, else 1 for THB /
    // base fallback). Manual ledger rows mirror the user-entered rate. Consumers
    // display this; the legacy fx_rate_bot column is not an FX source.
    fxRateEffective: numeric("fx_rate_effective"),
    // Stock exchange where the trade executed (e.g. NASDAQ, NYSE, NYSEARCA).
    // Trade rows only; null for non-trade rows.
    exchange: text("exchange"),
  },
  (table) => [
    index("Capital_Transactions_user_id_idx").on(table.userId),
    index("Capital_Transactions_source_document_id_idx").on(
      table.sourceDocumentId
    ),
    index("Capital_Transactions_symbol_idx").on(table.symbol),
  ]
);

// Server-authoritative running average cost basis per (user, symbol).
// The deterministic statement pipeline maintains this across imports, mirroring
// the parser's average-cost algorithm; it is what makes SELL realized
// gain/loss computable. Additive-only; historical data is preserved.
export const costBasisState = pgTable(
  "cost_basis_state",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    symbol: text("symbol").notNull(),
    quantity: numeric("quantity").notNull(),
    avgCost: numeric("avg_cost").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("cost_basis_state_user_id_idx").on(table.userId),
    uniqueIndex("cost_basis_state_user_symbol_idx").on(table.userId, table.symbol),
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
    // SHA-256 of the uploaded file bytes, used for user-scoped duplicate
    // detection. Nullable so existing historical rows (created before this
    // column existed) migrate cleanly and never fail a UNIQUE/backfill step.
    // New uploads always set it. See statement-storage.ts and the upload route.
    contentHash: text("content_hash"),
    filePath: text("file_path").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("documents_user_id_idx").on(table.userId),
    // Partial UNIQUE index: enforces one document per (user, content hash) for
    // hashed rows only. Existing historical rows carry a NULL hash (excluded,
    // so the migration never fails on pre-existing duplicates), while new
    // imports get a hard DB-level guarantee against concurrent duplicate
    // inserts. The WHERE clause keeps it safe to add without cleaning data.
    uniqueIndex("documents_user_content_hash_key")
      .on(table.userId, table.contentHash)
      .where(sql`${table.contentHash} IS NOT NULL`),
  ]
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
    entityId: text("entity_id"),
    isRead: boolean("is_read").notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("notifications_user_id_idx").on(table.userId),
    index("notifications_user_read_idx").on(table.userId, table.isRead),
    index("notifications_dedup_idx").on(table.userId, table.type, table.entityId),
  ]
);
