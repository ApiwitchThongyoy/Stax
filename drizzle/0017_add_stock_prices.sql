CREATE TABLE "stock_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"price_date" text NOT NULL,
	"close_price" numeric NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"source" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "stock_prices_symbol_date_idx" ON "stock_prices" USING btree ("symbol","price_date");--> statement-breakpoint
CREATE INDEX "stock_prices_price_date_idx" ON "stock_prices" USING btree ("price_date");--> statement-breakpoint
CREATE INDEX "stock_prices_symbol_idx" ON "stock_prices" USING btree ("symbol");