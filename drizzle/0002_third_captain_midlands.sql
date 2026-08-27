CREATE TABLE "exchange_rate_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"rate_date" text NOT NULL,
	"currency" text NOT NULL,
	"rate" numeric NOT NULL,
	"source" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rate_cache_date_currency_idx" ON "exchange_rate_cache" USING btree ("rate_date","currency");--> statement-breakpoint
CREATE INDEX "exchange_rate_cache_rate_date_idx" ON "exchange_rate_cache" USING btree ("rate_date");--> statement-breakpoint
CREATE INDEX "exchange_rate_cache_currency_idx" ON "exchange_rate_cache" USING btree ("currency");