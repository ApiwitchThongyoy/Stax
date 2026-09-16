-- Data-integrity hardening: DB-level CHECK constraints for finite-state and
-- numeric columns, derived from the app's OWN constant sets (the values come
-- from code, not comments — see the constraint comments for the evidence).
--
-- Two tiers:
--   * VALIDATED (plain ADD CONSTRAINT): every writer of the column is audited
--     code that can only produce the allowed set (tables created/only-written
--     by this repo's controlled history). Existing rows are verified by the
--     ALTER; a violating row would fail the migration loudly — desired.
--   * NOT VALID: the column's real-world history includes data whose actual
--     value set can no longer be proven from the repo (pre-repo rows, the
--     removed Webull CSV importer, growing action/notification enums). The
--     existing rows are NOT re-validated (upgrade can never break), but NEW
--     inserts/updates are fully enforced. Validate() can be run later once
--     the legacy set is proven clean.
--
-- No ENUM types are introduced (CHECK over ENUM: no casts, no NOT VALID for
-- enums, no reordering pain, consistent with all write paths that use TEXT).
--> statement-breakpoint
-- User.role — register.ts hard-codes 'USER'; admin-auth.ts:43 / admin routes
-- require exactly 'ADMIN'. NOT VALID: the User table predates the audited
-- code (migration 0000 / shared repo clone), so legacy role values cannot be
-- proven exhaustively; new writes (only ever USER/ADMIN) are fully enforced.
ALTER TABLE "User" ADD CONSTRAINT "chk_users_role"
  CHECK ("role" IN ('USER', 'ADMIN')) NOT VALID;
--> statement-breakpoint
-- User.status — auth-middleware.ts:103 rejects anything except 'ACTIVE'
-- ("suspended" enforced via status === 'SUSPENDED'); the admin user endpoint
-- only ever writes 'ACTIVE' | 'SUSPENDED'. NOT VALID: same pre-repo history
-- reasoning as User.role.
ALTER TABLE "User" ADD CONSTRAINT "chk_users_status"
  CHECK ("status" IN ('ACTIVE', 'SUSPENDED')) NOT VALID;
--> statement-breakpoint
-- Capital_Transactions.type — statement-pipeline.ts:19 VALID_TRANSACTION_TYPES
-- = ['CASH_IN','CASH_OUT'], capital-ledgers.ts VALID_TRANSACTION_TYPES same.
-- NOT VALID: this table has pre-repo rows AND was once written by the removed
-- Webull CSV importer (migration 0015 legacy csv_import_rows), whose value set
-- is no longer recoverable from the repo.
ALTER TABLE "Capital_Transactions" ADD CONSTRAINT "chk_capital_transactions_type"
  CHECK ("type" IN ('CASH_IN', 'CASH_OUT')) NOT VALID;
--> statement-breakpoint
-- Capital_Transactions.source_type — statement-pipeline.ts:33/186 writes
-- 'AI_PARSED'; capital-ledgers.ts VALID_SOURCE_TYPES = ['MANUAL','AI_PARSED'].
-- NOT VALID: same pre-repo + removed-CSV-importer risk as `type`.
ALTER TABLE "Capital_Transactions" ADD CONSTRAINT "chk_capital_transactions_source_type"
  CHECK ("source_type" IN ('AI_PARSED', 'MANUAL')) NOT VALID;
--> statement-breakpoint
-- Capital_Transactions.side — schema comment "BUY | SELL for trade rows, else
-- null"; pdfStatementParser.ts:242 side: "BUY" | "SELL". NOT VALID: pre-repo +
-- removed-CSV-importer history (a legacy CSV row could carry a non-trade side).
ALTER TABLE "Capital_Transactions" ADD CONSTRAINT "chk_capital_transactions_side"
  CHECK ("side" IS NULL OR "side" IN ('BUY', 'SELL')) NOT VALID;
--> statement-breakpoint
-- Capital_Transactions.category — pdfStatementParser.ts emits exactly
-- 'income' / 'expense' / 'equity' / 'asset' (Financeutils.ts
-- TransactionCategory); schema comment line 46 quotes the same four.
-- NOT VALID: nullable column added in 0012 to an already-old table; legacy and
-- removed-CSV-importer rows are not provably within the set.
ALTER TABLE "Capital_Transactions" ADD CONSTRAINT "chk_capital_transactions_category"
  CHECK ("category" IS NULL OR "category" IN ('income', 'expense', 'equity', 'asset')) NOT VALID;
--> statement-breakpoint
-- Capital_Transactions.quantity — cost-basis-engine.ts:57 side "BUY"|"SELL"
-- and the average-cost engine only ever processes positive quantities; the
-- parser rejects qty <= 0; short/negative positions are NOT supported anywhere
-- (the engine caps a drain at 0 and deletes the position). NOT VALID: legacy /
-- removed-CSV-importer rows are not provably > 0.
ALTER TABLE "Capital_Transactions" ADD CONSTRAINT "chk_capital_transactions_quantity_positive"
  CHECK ("quantity" IS NULL OR "quantity" > 0) NOT VALID;
--> statement-breakpoint
-- corporate_actions.action_type — corporate-action-service.ts:19
-- VALID_ACTION_TYPES = ['SPLIT','REVERSE_SPLIT','SPIN_OFF','RENAME'], the route
-- validates against it before insert. VALIDATED: table created by 0014 (this
-- repo's controlled history) and only ever written by that audited service.
ALTER TABLE "corporate_actions" ADD CONSTRAINT "chk_corporate_actions_action_type"
  CHECK ("action_type" IN ('SPLIT', 'REVERSE_SPLIT', 'SPIN_OFF', 'RENAME'));
--> statement-breakpoint
-- accounts.type — general-ledger.ts:48-62 DEFAULT_CHART_OF_ACCOUNTS uses
-- exactly ASSET/LIABILITY/EQUITY/INCOME/EXPENSE; accounts.ts:21
-- VALID_ACCOUNT_TYPES matches. VALIDATED: every account row is either the
-- seeded chart or route-validated manual creation.
ALTER TABLE "accounts" ADD CONSTRAINT "chk_accounts_type"
  CHECK ("type" IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'));
--> statement-breakpoint
-- accounts.opening_balance — schema comment line 388 "positive magnitude".
-- There is NO write path for this column (always NULL in practice); negative
-- would invert the normal-side math. >= 0 (honest zero allowed).
-- VALIDATED: no writer exists, so no legacy violating rows can exist.
ALTER TABLE "accounts" ADD CONSTRAINT "chk_accounts_opening_balance_non_negative"
  CHECK ("opening_balance" IS NULL OR "opening_balance" >= 0);
--> statement-breakpoint
-- journal_entries.source_type — general-ledger.ts:28 EntrySourceType =
-- 'MANUAL' | 'STATEMENT'; every insert path uses one of them. VALIDATED:
-- journal_entries is written only by this repo's audited ledger-service.
ALTER TABLE "journal_entries" ADD CONSTRAINT "chk_journal_entries_source_type"
  CHECK ("source_type" IN ('MANUAL', 'STATEMENT'));
--> statement-breakpoint
-- journal_entries.status — created with default 'POSTED' (migration 0011);
-- ledger-service.reverseJournalEntry flips rows to 'REVERSED'. No other value
-- is ever written. VALIDATED.
ALTER TABLE "journal_entries" ADD CONSTRAINT "chk_journal_entries_status"
  CHECK ("status" IN ('POSTED', 'REVERSED'));
--> statement-breakpoint
-- journal_entries.side — statement mirrors only ('BUY'/'SELL' via
-- journalDetailOf); manual entries keep it NULL. VALIDATED.
ALTER TABLE "journal_entries" ADD CONSTRAINT "chk_journal_entries_side"
  CHECK ("side" IS NULL OR "side" IN ('BUY', 'SELL'));
--> statement-breakpoint
-- journal_entries.posting_state — general-ledger.ts:138 PostingState =
-- 'POSTED' | 'SKIPPED'; import/backfill write exactly those two. VALIDATED.
ALTER TABLE "journal_entries" ADD CONSTRAINT "chk_journal_entries_posting_state"
  CHECK ("posting_state" IN ('POSTED', 'SKIPPED'));
--> statement-breakpoint
-- journal_entries.type — ledger-service.ts:409 CASH_IN | CASH_OUT, set only on
-- manual-cash mirrors and statement cash rows; GL-manual entries keep NULL.
-- VALIDATED.
ALTER TABLE "journal_entries" ADD CONSTRAINT "chk_journal_entries_type"
  CHECK ("type" IS NULL OR "type" IN ('CASH_IN', 'CASH_OUT'));
--> statement-breakpoint
-- journal_entry_lines.debit_amount — schema comment line 486 "always as a
-- positive magnitude"; general-ledger.ts:288 validateJournalEntry rejects
-- amounts <= 0 for both debit and credit. The existing
-- journal_entry_lines_single_leg CHECK (0011) already enforces either/or.
-- VALIDATED: every line since 0011 was written by the audited service.
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "chk_journal_entry_lines_debit_positive"
  CHECK ("debit_amount" IS NULL OR "debit_amount" > 0);
--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "chk_journal_entry_lines_credit_positive"
  CHECK ("credit_amount" IS NULL OR "credit_amount" > 0);
--> statement-breakpoint
-- journal_entry_lines.fx_rate_effective — validated > 0 in the pure engine for
-- non-THB (general-ledger.ts:302), fixed to 1 for THB; NOT NULL on the column.
-- VALIDATED.
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "chk_journal_entry_lines_fx_rate_effective_positive"
  CHECK ("fx_rate_effective" > 0);
--> statement-breakpoint
-- journal_entry_lines.amount_thb — derived = amount * fx_rate_effective, both
-- of which are > 0 (see the two checks above), so a THB amount <= 0 is always
-- wrong. VALIDATED.
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "chk_journal_entry_lines_amount_thb_positive"
  CHECK ("amount_thb" > 0);
--> statement-breakpoint
-- notifications.type — notification-service.ts NotificationType has six values
-- (SYSTEM, STATEMENT_UPLOAD, STATEMENT_IMPORT, STATEMENT_DUPLICATE,
-- ANALYSIS_COMPLETE, ACCOUNT_STATUS) and every notify*() uses one of them.
-- NOT VALID: notifications is an old shared-repo table (migration 0004) whose
-- early rows may carry type strings no longer present in the current enum.
ALTER TABLE "notifications" ADD CONSTRAINT "chk_notifications_type"
  CHECK ("type" IN ('SYSTEM', 'STATEMENT_UPLOAD', 'STATEMENT_IMPORT', 'STATEMENT_DUPLICATE', 'ANALYSIS_COMPLETE', 'ACCOUNT_STATUS')) NOT VALID;
--> statement-breakpoint
-- audit_logs.action — audit-log.ts AuditAction is the single source of all 25
-- action strings ever emitted; every insertAuditLog call passes one of them.
-- NOT VALID: audit history is write-once and spans pre-repo deployments whose
-- exact historical action strings cannot be proven from the repo.
ALTER TABLE "audit_logs" ADD CONSTRAINT "chk_audit_logs_action"
  CHECK ("action" IN (
    'REGISTER_SUCCESS', 'REGISTER_FAILED', 'LOGIN_SUCCESS', 'LOGIN_FAILED',
    'STATEMENT_UPLOAD', 'STATEMENT_IMPORT', 'STATEMENT_DELETE',
    'GEMINI_PARSE', 'GEMINI_PARSE_FAILED',
    'CAPITAL_TRANSACTION_CREATE', 'CAPITAL_TRANSACTION_UPDATE', 'CAPITAL_TRANSACTION_DELETE',
    'ADMIN_LOGIN_SUCCESS', 'ADMIN_USER_LIST_VIEW', 'ADMIN_USER_STATUS_UPDATE', 'ADMIN_UNAUTHORIZED_ACCESS',
    'SETTINGS_UPDATE',
    'NOTIFICATION_LIST_VIEW', 'NOTIFICATION_MARK_READ', 'NOTIFICATION_READ_ALL',
    'ACCOUNT_CREATE', 'JOURNAL_ENTRY_CREATE', 'JOURNAL_ENTRY_REVERSE',
    'CORPORATE_ACTION_CREATE', 'CORPORATE_ACTION_DELETE'
  )) NOT VALID;
--> statement-breakpoint
-- auth_rate_limits.attempts — rate-limit.ts increments/rolls back atomically and
-- can never be negative (increment adds 1; rollback only decrements when >= 2).
-- VALIDATED: brand-new table (0024), single audited writer.
ALTER TABLE "auth_rate_limits" ADD CONSTRAINT "chk_auth_rate_limits_attempts_non_negative"
  CHECK ("attempts" >= 0);