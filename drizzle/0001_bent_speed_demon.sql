CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"details" jsonb,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_tax_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"summary_date" text NOT NULL,
	"total_amount_thb" numeric NOT NULL,
	"total_tax_amount" numeric,
	"transaction_count" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_User_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_tax_summaries" ADD CONSTRAINT "daily_tax_summaries_user_id_User_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "daily_tax_summaries_user_id_idx" ON "daily_tax_summaries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "daily_tax_summaries_summary_date_idx" ON "daily_tax_summaries" USING btree ("summary_date");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_tax_summaries_user_date_idx" ON "daily_tax_summaries" USING btree ("user_id","summary_date");