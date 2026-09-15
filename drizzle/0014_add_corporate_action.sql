CREATE TABLE "corporate_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"symbol" text NOT NULL,
	"action_type" text NOT NULL,
	"transaction_date" text NOT NULL,
	"ratio_old" numeric,
	"ratio_new" numeric,
	"new_symbol" text,
	"shares_out" numeric,
	"price_out" numeric,
	"cash_in_lieu" numeric,
	"description" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_user_id_User_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "corporate_actions_user_id_idx" ON "corporate_actions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "corporate_actions_user_symbol_date_idx" ON "corporate_actions" USING btree ("user_id","symbol","transaction_date");