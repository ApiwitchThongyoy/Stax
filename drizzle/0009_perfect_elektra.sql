CREATE TABLE "cost_basis_state" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"symbol" text NOT NULL,
	"quantity" numeric NOT NULL,
	"avg_cost" numeric NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ALTER COLUMN "fx_rate_bot" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ADD COLUMN "symbol" text;--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ADD COLUMN "side" text;--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ADD COLUMN "quantity" numeric;--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ADD COLUMN "unit_price" numeric;--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ADD COLUMN "gross_amount" numeric;--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ADD COLUMN "fees" numeric;--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ADD COLUMN "proceeds" numeric;--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ADD COLUMN "cost_basis" numeric;--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ADD COLUMN "realized_gain_loss" numeric;--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ADD COLUMN "realized_gain_loss_thb" numeric;--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ADD COLUMN "fx_rate_statement" numeric;--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ADD COLUMN "fx_rate_effective" numeric;--> statement-breakpoint
ALTER TABLE "cost_basis_state" ADD CONSTRAINT "cost_basis_state_user_id_User_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_basis_state_user_id_idx" ON "cost_basis_state" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_basis_state_user_symbol_idx" ON "cost_basis_state" USING btree ("user_id","symbol");--> statement-breakpoint
CREATE INDEX "Capital_Transactions_symbol_idx" ON "Capital_Transactions" USING btree ("symbol");