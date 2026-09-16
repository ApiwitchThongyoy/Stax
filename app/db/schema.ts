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
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable(
  "User",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("USER"),
    status: text("status").notNull().default("ACTIVE"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }),
  }
);

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
    // Parser transaction category ("income" | "expense" | "equity" | "asset").
    // Persisted so the general-ledger posting engine can classify each row into
    // the right set of journal accounts without re-parsing. Nullable for legacy
    // rows created before this column existed; the posting engine then falls
    // back to side/type heuristics.
    category: text("category"),
    // Parser section label (e.g. "เงินปันผล:goog", "ค่าธรรมเนียม",
    // "ภาษีหัก ณ ที่จ่าย", "ดอกเบี้ย"). Persisted so the general-ledger posting
    // engine can pick the correct income/expense account deterministically.
    section: text("section"),
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
    // Broker-authoritative net cash for this single trade (the statement's "Net
    // Amount" = gross - fees). Persisted for EVERY trade row so realized
    // gain/loss can be recomputed later even when a SELL was frozen as
    // non-computable at import time (e.g. its supporting BUY arrived in a later
    // statement). Null for rows imported before this column existed; the
    // backfill then reconstructs net = gross_amount - fees.
    netAmount: numeric("net_amount"),
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
    // ---- Currency-exchange FROM side + printed rate (migration 0021) ----
    // That the statement's CURRENCY EXCHANGE RECORDS line printed: "from Ccy
    // fromAmt -> to Ccy toAmt (rate)". The to-side is stored in the existing
    // currency/amount columns; these make the FROM side and the bank's printed
    // rate readable for the cash page. CURRENCY-EXCHANGE rows only; null for
    // every other row (never fabricated).
    exchangeFromCurrency: text("exchange_from_currency"),
    exchangeFromAmount: numeric("exchange_from_amount"),
    exchangeRate: numeric("exchange_rate"),
  },
  (table) => [
    index("Capital_Transactions_user_id_idx").on(table.userId),
    index("Capital_Transactions_source_document_id_idx").on(
      table.sourceDocumentId
    ),
    index("Capital_Transactions_symbol_idx").on(table.symbol),
  ]
);

// Server-authoritative Webull Average-Cost cost basis per (user, symbol).
// The deterministic statement pipeline maintains this across imports, mirroring
// the parser's Webull Average-Cost algorithm; `cum_quantity`/`cum_cost` are the
// lifetime accumulator (every BUY adds price×qty; SELL only reduces `quantity`)
// that makes `avg_cost = cum_cost / cum_quantity` and SELL realized gain/loss
// computable. Additive-only; historical data is preserved.
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
    cumQuantity: numeric("cum_quantity").notNull(),
    cumCost: numeric("cum_cost").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("cost_basis_state_user_id_idx").on(table.userId),
    uniqueIndex("cost_basis_state_user_symbol_idx").on(table.userId, table.symbol),
  ]
);

// Corporate actions (split / reverse-split / spin-off / rename) that adjust a
// symbol's share count and per-share average cost WITHOUT touching the cash
// ledger. They are replayed chronologically with Capital_Transactions when the
// derived cost_basis_state cache is rebuilt — mirroring the statement parser's
// running-average math — so a SELL after a split computes realized gain/loss
// against the post-split cost basis. Additive-only; the parser is untouched.
export const corporateActions = pgTable(
  "corporate_actions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    // Uppercase ticker the action applies to (e.g. "BBAI").
    symbol: text("symbol").notNull(),
    // SPLIT | REVERSE_SPLIT | SPIN_OFF | RENAME
    actionType: text("action_type").notNull(),
    // ISO date (yyyy-mm-dd) of the corporate action event.
    transactionDate: text("transaction_date").notNull(),
    // Split-like ratio, expressed old:new (e.g. ratio 1:10 => quantity ×10 and
    // per-share cost ÷10; ratio 10:1 => the reverse). ratioOld defaults to 1.
    ratioOld: numeric("ratio_old"),
    ratioNew: numeric("ratio_new"),
    // RENAME / SPIN_OFF: the resulting symbol.
    newSymbol: text("new_symbol"),
    // SPIN_OFF: new-symbol shares received and their per-share value.
    sharesOut: numeric("shares_out"),
    priceOut: numeric("price_out"),
    // SPIN_OFF FMV pair for cost-basis allocation (parent -> child), in the
    // symbol's trade currency per share. Nullable = legacy rows (pre-0023):
    // those keep the old behaviour (child at price_out, parent untouched).
    parentFmvPerShare: numeric("parent_fmv_per_share"),
    childFmvPerShare: numeric("child_fmv_per_share"),
    // Fractional-share payout for split-like actions (informational; total cost
    // is preserved regardless), in the symbol's trade currency.
    cashInLieu: numeric("cash_in_lieu"),
    description: text("description"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("corporate_actions_user_id_idx").on(table.userId),
    uniqueIndex("corporate_actions_user_symbol_date_idx").on(
      table.userId,
      table.symbol,
      table.transactionDate
    ),
    // Data-integrity closed set (migration 0025), matches
    // corporate-action-service.ts VALID_ACTION_TYPES.
    check(
      "chk_corporate_actions_action_type",
      sql`${table.actionType} IN ('SPLIT', 'REVERSE_SPLIT', 'SPIN_OFF', 'RENAME')`
    ),
  ]
);

// Reference-market daily-close stock prices, keyed by symbol + trade date.
//
// Unlike every other table in this schema this is intentionally NOT user-scoped:
// share prices are public market data shared by all users, so a single row per
// (symbol, price_date) serves every account. It is maintained by the stock-price
// provider (Yahoo Finance, keyless) via a daily cron + lazy refresh; the
// Dashboard "การถือครองหุ้น" card reads it for display-only current price,
// market value and unrealized P&L. NEVER an input to the tax engine or the
// general ledger.
export const stockPrices = pgTable(
  "stock_prices",
  {
    id: text("id").primaryKey(),
    // Uppercase ticker, e.g. "NVDA".
    symbol: text("symbol").notNull(),
    // ISO trade date (yyyy-mm-dd) the close belongs to.
    priceDate: text("price_date").notNull(),
    // Daily close per share, in `currency`.
    closePrice: numeric("close_price").notNull(),
    // Quote currency returned by the provider (e.g. USD for US-listed tickers).
    currency: text("currency").notNull().default("USD"),
    // Provider label, e.g. "yahoo-finance".
    source: text("source"),
    createdAt: text("created_at").notNull(),
    // Last fetch/update time (used for the 1-day staleness check).
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("stock_prices_symbol_date_idx").on(table.symbol, table.priceDate),
    index("stock_prices_price_date_idx").on(table.priceDate),
    index("stock_prices_symbol_idx").on(table.symbol),
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
    // Data-integrity closed set (migration 0025), matches audit-log.ts
    // AuditAction (all 25 actions). NOT VALID in the DB: audit history spans
    // pre-repo deployments whose exact historical actions are unprovable.
    check(
      "chk_audit_logs_action",
      sql`${table.action} IN (
        'REGISTER_SUCCESS', 'REGISTER_FAILED', 'LOGIN_SUCCESS', 'LOGIN_FAILED',
        'STATEMENT_UPLOAD', 'STATEMENT_IMPORT', 'STATEMENT_DELETE',
        'GEMINI_PARSE', 'GEMINI_PARSE_FAILED',
        'CAPITAL_TRANSACTION_CREATE', 'CAPITAL_TRANSACTION_UPDATE', 'CAPITAL_TRANSACTION_DELETE',
        'ADMIN_LOGIN_SUCCESS', 'ADMIN_USER_LIST_VIEW', 'ADMIN_USER_STATUS_UPDATE', 'ADMIN_UNAUTHORIZED_ACCESS',
        'SETTINGS_UPDATE',
        'NOTIFICATION_LIST_VIEW', 'NOTIFICATION_MARK_READ', 'NOTIFICATION_READ_ALL',
        'ACCOUNT_CREATE', 'JOURNAL_ENTRY_CREATE', 'JOURNAL_ENTRY_REVERSE',
        'CORPORATE_ACTION_CREATE', 'CORPORATE_ACTION_DELETE'
      )`
    ),
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

// PostgreSQL-backed rate limiting for the auth routes (login + register).
// One row per rate-limit key (e.g. "login-ip:127.0.0.1" or
// "register-ip:127.0.0.1:user@example.com"). The counter and the window are
// bumped atomically (INSERT ... ON CONFLICT DO UPDATE) so concurrent requests
// cannot bypass a limit. Fail-open by design: if a query errors (table missing
// pre-migration, DB hiccup) the request is allowed through — rate limiting is
// mitigation, never a user-facing 500. See app/lib/rate-limit.ts.
export const authRateLimits = pgTable(
  "auth_rate_limits",
  {
    key: text("key").primaryKey(),
    attempts: integer("attempts").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("auth_rate_limits_updated_at_idx").on(table.updatedAt),
    // Data-integrity magnitude guard (migration 0025): the atomic increment can
    // never go negative (rollback only decrements when attempts >= 2).
    check(
      "chk_auth_rate_limits_attempts_non_negative",
      sql`${table.attempts} >= 0`
    ),
  ]
);

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

// ---------------------------------------------------------------------------
// Double-entry general ledger (บัญชีแยกประเภท) — foreign investment pivot.
//
// Every journal_entries row balances debits == credits PER CURRENCY. That rule
// is enforced in the service layer + the pure engine (general-ledger.ts) — a
// Postgres trigger would be needed for a hard DB-level guarantee, which this
// codebase deliberately avoids (all invariants live in tested application
// code). The per-line CHECK below is the DB safety net for the most common
// defect: a line that is simultaneously a debit and a credit, or neither.
// ---------------------------------------------------------------------------

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    // Chart-of-accounts code, e.g. 1020, 1110. Unique per user.
    code: text("code").notNull(),
    name: text("name").notNull(),
    // ASSET | LIABILITY | EQUITY | INCOME | EXPENSE
    type: text("type").notNull(),
    // Base currency for this account — USD for foreign broker/investment
    // accounts, THB default. Journal lines posted to it must match.
    currency: text("currency").notNull().default("THB"),
    // Parent account code id (sub-accounts). Kept nullable/loose.
    parentId: text("parent_id"),
    // Opening balance in account currency (positive magnitude; normal side is
    // derived from `type`).
    openingBalance: numeric("opening_balance"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("accounts_user_id_code_idx").on(table.userId, table.code),
    index("accounts_user_id_idx").on(table.userId),
    index("accounts_parent_id_idx").on(table.parentId),
    // Data-integrity closed set + magnitude (migration 0025): account type must
    // be one of the five GAAP categories the engine understands; opening balance
    // is a positive magnitude (no write path exists today).
    check(
      "chk_accounts_type",
      sql`${table.type} IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')`
    ),
    check(
      "chk_accounts_opening_balance_non_negative",
      sql`${table.openingBalance} IS NULL OR ${table.openingBalance} >= 0`
    ),
  ]
);

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    // Per-user running number (monotonic int) shown to the user.
    entryNo: integer("entry_no").notNull(),
    // ISO date (yyyy-mm-dd) of the economic event.
    entryDate: text("entry_date").notNull(),
    description: text("description").notNull(),
    // MANUAL | STATEMENT
    sourceType: text("source_type").notNull().default("MANUAL"),
    // documents.id when posted from a statement import.
    sourceDocumentId: text("source_document_id"),
    // Capital_Transactions.transaction_id when posted from a statement row.
    sourceTransactionId: text("source_transaction_id"),
    // POSTED | REVERSED
    status: text("status").notNull().default("POSTED"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    // ---- Trade-detail columns (statement imports; manual entries keep null) ----
    category: text("category"),
    section: text("section"),
    symbol: text("symbol"),
    side: text("side"),
    exchange: text("exchange"),
    quantity: numeric("quantity"),
    unitPrice: numeric("unit_price"),
    grossAmount: numeric("gross_amount"),
    fees: numeric("fees"),
    netAmount: numeric("net_amount"),
    proceeds: numeric("proceeds"),
    costBasis: numeric("cost_basis"),
    realizedGainLoss: numeric("realized_gain_loss"),
    realizedGainLossThb: numeric("realized_gain_loss_thb"),
    averageCost: numeric("average_cost"),
    currency: text("currency"),
    amount: numeric("amount"),
    amountThb: numeric("amount_thb"),
    fxRateEffective: numeric("fx_rate_effective"),
    fxRateStatement: numeric("fx_rate_statement"),
    exchangeFromCurrency: text("exchange_from_currency"),
    exchangeFromAmount: numeric("exchange_from_amount"),
    exchangeRate: numeric("exchange_rate"),
    isFxConversion: boolean("is_fx_conversion").notNull().default(false),
    // POSTED (lines exist + balanced) | SKIPPED (recorded but not double-entry).
    postingState: text("posting_state").notNull().default("POSTED"),
    skipReason: text("skip_reason"),
    // The source-row capital type ("CASH_IN" | "CASH_OUT") — part of the
    // journal-as-SSOT record so the journal can serve every screen that today
    // reads Capital_Transactions (cash summary, ledger list, portfolio, ...).
    // Manual/statement entries carry it; general GL journal entries keep null.
    type: text("type"),
    // Investor's own note on this entry (trading-journal "จดบันทึก").
    // Nullable free text, written ONLY via the journal note endpoint —
    // never by imports, postings, backfills or reversals.
    note: text("note"),
  },
  (table) => [
    uniqueIndex("journal_entries_user_entry_no_idx").on(table.userId, table.entryNo),
    index("journal_entries_user_id_idx").on(table.userId),
    index("journal_entries_entry_date_idx").on(table.entryDate),
    index("journal_entries_source_document_id_idx").on(table.sourceDocumentId),
    index("journal_entries_symbol_idx").on(table.symbol),
    index("journal_entries_source_transaction_id_idx").on(table.sourceTransactionId),
    // Data-integrity closed sets (migration 0025), matching the audited
    // ledger-service insert paths.
    check(
      "chk_journal_entries_source_type",
      sql`${table.sourceType} IN ('MANUAL', 'STATEMENT')`
    ),
    check(
      "chk_journal_entries_status",
      sql`${table.status} IN ('POSTED', 'REVERSED')`
    ),
    check(
      "chk_journal_entries_side",
      sql`${table.side} IS NULL OR ${table.side} IN ('BUY', 'SELL')`
    ),
    check(
      "chk_journal_entries_posting_state",
      sql`${table.postingState} IN ('POSTED', 'SKIPPED')`
    ),
    check(
      "chk_journal_entries_type",
      sql`${table.type} IS NULL OR ${table.type} IN ('CASH_IN', 'CASH_OUT')`
    ),
  ]
);

export const journalEntryLines = pgTable(
  "journal_entry_lines",
  {
    id: text("id").primaryKey(),
    journalEntryId: text("journal_entry_id")
      .notNull()
      .references(() => journalEntries.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    currency: text("currency").notNull(),
    // Exactly ONE of these is set, always as a positive magnitude.
    debitAmount: numeric("debit_amount"),
    creditAmount: numeric("credit_amount"),
    // THB reporting base derived from fxRateEffective.
    amountThb: numeric("amount_thb").notNull(),
    fxRateEffective: numeric("fx_rate_effective").notNull(),
    fxRateStatement: numeric("fx_rate_statement"),
    fxRateProvider: numeric("fx_rate_provider"),
    memo: text("memo"),
  },
  (table) => [
    index("journal_entry_lines_journal_entry_id_idx").on(table.journalEntryId),
    index("journal_entry_lines_user_id_idx").on(table.userId),
    index("journal_entry_lines_account_id_idx").on(table.accountId),
    // DB safety net: a line is either a debit or a credit, never both/neither.
    check(
      "journal_entry_lines_single_leg",
      sql`(debit_amount IS NULL) <> (credit_amount IS NULL)`
    ),
    // Data-integrity magnitude guards (migration 0025): a leg is always a
    // positive magnitude, fx is always > 0 (THB pinned at 1), and the derived
    // THB base is always > 0.
    check(
      "chk_journal_entry_lines_debit_positive",
      sql`${table.debitAmount} IS NULL OR ${table.debitAmount} > 0`
    ),
    check(
      "chk_journal_entry_lines_credit_positive",
      sql`${table.creditAmount} IS NULL OR ${table.creditAmount} > 0`
    ),
    check(
      "chk_journal_entry_lines_fx_rate_effective_positive",
      sql`${table.fxRateEffective} > 0`
    ),
    check(
      "chk_journal_entry_lines_amount_thb_positive",
      sql`${table.amountThb} > 0`
    ),
  ]
);
