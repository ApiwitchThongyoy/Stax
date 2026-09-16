-- Data-integrity hardening: DB-level CHECK constraints for finite-state and
-- numeric columns, derived from the app's OWN constant sets (the values come
-- from code, not comments — see the constraint comments for the evidence).
--
-- Tier layout (final, after upgrade-safety review):
--   * VALIDATED (plain ADD CONSTRAINT): every writer of the column is audited
--     code that can only produce the allowed set (tables created/only-written
--     by this repo's controlled history). Existing rows are verified by the
--     ALTER; a violating row would fail the migration loudly — desired.
--   * NOT VALID: kept ONLY for audit_logs.action. append-only: proven by
--     code review (zero UPDATE/DELETE statements in the repo). NOT VALID
--     means existing pre-repo action strings are not re-validated, and since
--     audit rows are never updated, the CHECK re-evaluation on UPDATE (a
--     PostgreSQL rule: any UPDATE of a row re-checks ALL its row-level CHECK
--     constraints) can never break a legacy audit row.
--
-- DEFERRED (the other 8 formerly-NOT-VALID constraints) — proven DANGEROUS
-- by live PostgreSQL 17 testing: NOT VALID skips validation at ADD-time only;
-- an UPDATE of ANY column re-checks every row-level CHECK on that row. The 8
-- tables have real UPDATE paths (User heartbeats/logins/status, capital-ledger
-- PUT edits, notification mark-read), so a legacy row with one out-of-domain
-- value would break on ANY unrelated UPDATE (SQLSTATE 23514) — the upgrade
-- would "succeed" but leave affected rows frozen. Service-layer validation
-- (the same constant sets listed above) already blocks NEW invalid writes, so
-- deferring these costs nothing while guaranteeing zero legacy breakage.
--
-- No ENUM types are introduced (CHECK over ENUM: no casts, no NOT VALID for
-- enums, no reordering pain, consistent with all write paths that use TEXT).
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
-- DEFERRED (was NOT VALID): proved dangerous by live PG17 testing — a legacy
-- row with a non-set type makes notifications.$id.read.ts:50 (mark-read)
-- fail with 23514. Service-layer notify*() already blocks new invalid values.
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