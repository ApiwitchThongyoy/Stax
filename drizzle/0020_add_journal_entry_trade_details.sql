-- Journal-as-SSOT: carry the FULL source-row trade detail on every journal
-- entry so the journal is a complete record of the PDF import (and later the
-- read path for every screen). All columns nullable — they exist only for
-- STATEMENT postings (manual entries keep them null, never fabricated).
-- posting_state marks every row of an import as either double-entry POSTED or
-- SKIPPED (currency-exchange-only / duplicate capital-gain rows are recorded
-- in the journal but carry no posting lines).
ALTER TABLE "journal_entries" ADD COLUMN "category" text;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "section" text;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "symbol" text;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "side" text;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "exchange" text;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "quantity" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "unit_price" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "gross_amount" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "fees" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "net_amount" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "proceeds" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "cost_basis" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "realized_gain_loss" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "realized_gain_loss_thb" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "average_cost" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "currency" text;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "amount" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "amount_thb" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "fx_rate_effective" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "fx_rate_statement" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "is_fx_conversion" boolean NOT NULL DEFAULT 'false';
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "posting_state" text NOT NULL DEFAULT 'POSTED';
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "skip_reason" text;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "type" text;
--> statement-breakpoint
CREATE INDEX "journal_entries_symbol_idx" ON "journal_entries" ("symbol");
--> statement-breakpoint
CREATE INDEX "journal_entries_source_transaction_id_idx" ON "journal_entries" ("source_transaction_id");