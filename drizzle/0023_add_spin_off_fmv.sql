-- Spin-off FMV pair for cost-basis allocation (parent -> child).
-- Both columns are NULLABLE: rows created before this migration (legacy
-- spin-offs recorded with shares_out/price_out only) keep the old behaviour
-- (child position at price_out, parent untouched) and are surfaced with a
-- derived needsReview flag instead of a guessed backfill. New spin-offs may
-- carry parent_fmv_per_share + child_fmv_per_share (both required together,
-- both positive) to split the parent's cumCost pro-rata by FMV.
ALTER TABLE "corporate_actions" ADD COLUMN IF NOT EXISTS "parent_fmv_per_share" numeric;
--> statement-breakpoint
ALTER TABLE "corporate_actions" ADD COLUMN IF NOT EXISTS "child_fmv_per_share" numeric;
