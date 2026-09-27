-- Long-lived refresh sessions + one-time passwords (registration verification
-- and password reset).
--
-- This migration adds refresh/OTP tables and updates the existing audit action
-- constraint. It does not rewrite existing application rows.
--
-- SECURITY MODEL (see app/lib/refresh-session.ts and app/lib/otp.ts):
--   * The browser only ever holds an OPAQUE random token in an HttpOnly cookie.
--     "token_hash" stores nothing but its SHA-256 digest, so a database dump
--     cannot be replayed as a live session.
--   * "family_id" groups one login's rotation chain. Every renewal inserts a new
--     row in the same family and revokes its predecessor, so presenting an
--     already-rotated token is detectable and revokes the entire family.
--   * A 6-digit OTP has only 1,000,000 possible values, so "code_hash" is a
--     PEPPERED sha256 bound to email + purpose (pepper = server-only
--     OTP_PEPPER, falling back to JWT_SECRET — see otpPepper() in
--     app/lib/otp.ts).
--     A dump alone therefore reveals no usable code. Plaintext codes are never
--     persisted and never logged.

CREATE TABLE IF NOT EXISTS "refresh_sessions" (
  "id"             text PRIMARY KEY,
  "user_id"        text NOT NULL REFERENCES "public"."User"("id") ON DELETE CASCADE,
  "token_hash"     text NOT NULL,
  "family_id"      text NOT NULL,
  "expires_at"     timestamptz NOT NULL,
  "revoked_at"     timestamptz,
  "revoked_reason" text,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "last_used_at"   timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

-- UNIQUE: the lookup path for every refresh, and it makes storing the same
-- secret twice impossible.
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_sessions_token_hash_unique"
  ON "refresh_sessions" ("token_hash");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "refresh_sessions_user_id_idx"
  ON "refresh_sessions" ("user_id");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "refresh_sessions_family_id_idx"
  ON "refresh_sessions" ("family_id");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "refresh_sessions_expires_at_idx"
  ON "refresh_sessions" ("expires_at");

--> statement-breakpoint

-- Data-integrity closed set: only the reasons app/lib/refresh-session.ts writes.
-- A NULL revoked_reason means "not revoked".
ALTER TABLE "refresh_sessions"
  ADD CONSTRAINT "chk_refresh_sessions_revoked_reason"
  CHECK ("revoked_reason" IS NULL OR "revoked_reason" IN (
    'rotated', 'logout', 'reuse_detected', 'password_reset',
    'account_suspended', 'expired'
  ));

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "email_otp" (
  "id"           text PRIMARY KEY,
  -- NULL while a registration is still pending (the account does not exist yet).
  "user_id"      text REFERENCES "public"."User"("id") ON DELETE CASCADE,
  "purpose"      text NOT NULL,
  "email"        text NOT NULL,
  "code_hash"    text NOT NULL,
  "expires_at"   timestamptz NOT NULL,
  "consumed_at"  timestamptz,

  -- sha256 hex of the reset ticket this code was exchanged for, or NULL.
  --
  -- Password reset spends the code at VERIFY time (consumed_at), so a captured
  -- code can never mint a second ticket. That alone is not enough: nothing would
  -- mark the ticket as unused, so /forgot-password/reset would accept a replayed
  -- ticket and let it set a different password. This hash is the ticket's own
  -- single-use claim - verify stores it, reset clears it with a conditional
  -- UPDATE, so a second holder of the same ticket updates 0 rows and is refused.
  -- NULL for REGISTER rows, which have no ticket.
  "reset_ticket_hash" text,

  "attempts"     integer NOT NULL DEFAULT 0,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "last_sent_at" timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "email_otp_email_purpose_idx"
  ON "email_otp" ("email", "purpose");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "email_otp_user_id_idx"
  ON "email_otp" ("user_id");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "email_otp_expires_at_idx"
  ON "email_otp" ("expires_at");

--> statement-breakpoint

ALTER TABLE "email_otp"
  ADD CONSTRAINT "chk_email_otp_purpose"
  CHECK ("purpose" IN ('REGISTER', 'PASSWORD_RESET'));

--> statement-breakpoint

ALTER TABLE "email_otp"
  ADD CONSTRAINT "chk_email_otp_attempts_non_negative"
  CHECK ("attempts" >= 0);

--> statement-breakpoint

-- A peppered sha256 hex digest is always 64 characters.
ALTER TABLE "email_otp"
  ADD CONSTRAINT "chk_email_otp_code_hash_length"
  CHECK (length("code_hash") = 64);

--> statement-breakpoint

-- NULL, or a peppered sha256 hex digest.
ALTER TABLE "email_otp"
  ADD CONSTRAINT "chk_email_otp_reset_ticket_hash"
  CHECK ("reset_ticket_hash" IS NULL OR length("reset_ticket_hash") = 64);

--> statement-breakpoint

-- Extend the audit action closed set for the new session + OTP events.
-- chk_audit_logs_action is defined by 0025 as NOT VALID (audit history spans
-- pre-repo deployments whose historical actions are unprovable); the new
-- constraint keeps that tier so historical rows stay untouched. The 6 added
-- actions must stay in sync with app/lib/audit-log.ts AuditAction and the
-- app/db/schema.ts mirror - scripts/test-audit-actions-sync.mts fails loudly if
-- the three ever drift.
ALTER TABLE "audit_logs"
  DROP CONSTRAINT IF EXISTS "chk_audit_logs_action";

--> statement-breakpoint

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "chk_audit_logs_action"
  CHECK ("action" IN (
    'REGISTER_SUCCESS', 'REGISTER_FAILED', 'LOGIN_SUCCESS', 'LOGIN_FAILED',
    'STATEMENT_UPLOAD', 'STATEMENT_IMPORT', 'STATEMENT_DELETE',
    'GEMINI_PARSE', 'GEMINI_PARSE_FAILED',
    'CAPITAL_TRANSACTION_CREATE', 'CAPITAL_TRANSACTION_UPDATE', 'CAPITAL_TRANSACTION_DELETE',
    'ADMIN_LOGIN_SUCCESS', 'ADMIN_USER_LIST_VIEW', 'ADMIN_USER_STATUS_UPDATE', 'ADMIN_UNAUTHORIZED_ACCESS',
    'SETTINGS_UPDATE',
    'NOTIFICATION_LIST_VIEW', 'NOTIFICATION_MARK_READ', 'NOTIFICATION_READ_ALL',
    'ACCOUNT_CREATE', 'JOURNAL_ENTRY_CREATE', 'JOURNAL_ENTRY_REVERSE',
    'CORPORATE_ACTION_CREATE', 'CORPORATE_ACTION_DELETE',
    'SESSION_REFRESH', 'SESSION_REFRESH_REJECTED', 'SESSION_REVOKED',
    'OTP_REQUESTED', 'OTP_VERIFY_FAILED', 'PASSWORD_RESET_SUCCESS'
  )) NOT VALID;