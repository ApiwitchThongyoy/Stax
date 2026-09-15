-- Currency exchange FROM side + the rate the bank printed for the conversion.
-- The statement currency-exchange block reads "from Ccy amount -> to Ccy amount
-- (rate)" and the parser ALREADY captures fromCcy/fromAmt/rate, but the import
-- pipeline only persisted the TO side (currency/amount). These columns make the
-- full exchange readable on the cash page without re-parsing. Nullable: only
-- CURRENCY-EXCHANGE rows carry values (every other row stays null, never
-- fabricated).
ALTER TABLE "Capital_Transactions" ADD COLUMN "exchange_from_currency" text;
--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ADD COLUMN "exchange_from_amount" numeric;
--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ADD COLUMN "exchange_rate" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "exchange_from_currency" text;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "exchange_from_amount" numeric;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "exchange_rate" numeric;