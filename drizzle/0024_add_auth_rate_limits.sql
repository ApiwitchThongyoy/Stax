-- PostgreSQL-backed rate limiting for auth routes (login + register).
-- One row per rate-limit key (e.g. "login-ip:127.0.0.1" or
-- "register-ip:127.0.0.1:user@example.com"). Atomic INSERT ... ON CONFLICT
-- DO UPDATE keeps the counter correct under concurrent requests. Fail-open:
-- if the table doesn't exist (pre-migration deployment) or a query errors, the
-- request is allowed through (observability, never a user-facing 500).
CREATE TABLE IF NOT EXISTS "auth_rate_limits" (
  "key"             text PRIMARY KEY,
  "attempts"        integer NOT NULL DEFAULT 0,
  "window_started_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_rate_limits_updated_at_idx"
  ON "auth_rate_limits" ("updated_at");
