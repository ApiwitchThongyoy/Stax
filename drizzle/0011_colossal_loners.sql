CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"currency" text DEFAULT 'THB' NOT NULL,
	"parent_id" text,
	"opening_balance" numeric,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"entry_no" integer NOT NULL,
	"entry_date" text NOT NULL,
	"description" text NOT NULL,
	"source_type" text DEFAULT 'MANUAL' NOT NULL,
	"source_document_id" text,
	"source_transaction_id" text,
	"status" text DEFAULT 'POSTED' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entry_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"journal_entry_id" text NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"currency" text NOT NULL,
	"debit_amount" numeric,
	"credit_amount" numeric,
	"amount_thb" numeric NOT NULL,
	"fx_rate_effective" numeric NOT NULL,
	"fx_rate_statement" numeric,
	"fx_rate_provider" numeric,
	"memo" text,
	CONSTRAINT "journal_entry_lines_single_leg" CHECK ((debit_amount IS NULL) <> (credit_amount IS NULL))
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_User_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_user_id_User_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_user_id_User_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_user_id_code_idx" ON "accounts" USING btree ("user_id","code");--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "accounts_parent_id_idx" ON "accounts" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_user_entry_no_idx" ON "journal_entries" USING btree ("user_id","entry_no");--> statement-breakpoint
CREATE INDEX "journal_entries_user_id_idx" ON "journal_entries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "journal_entries_entry_date_idx" ON "journal_entries" USING btree ("entry_date");--> statement-breakpoint
CREATE INDEX "journal_entries_source_document_id_idx" ON "journal_entries" USING btree ("source_document_id");--> statement-breakpoint
CREATE INDEX "journal_entry_lines_journal_entry_id_idx" ON "journal_entry_lines" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "journal_entry_lines_user_id_idx" ON "journal_entry_lines" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "journal_entry_lines_account_id_idx" ON "journal_entry_lines" USING btree ("account_id");