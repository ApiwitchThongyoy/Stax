CREATE TABLE "Capital_Transactions" (
	"transaction_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"amount_foreign" numeric NOT NULL,
	"currency" text NOT NULL,
	"transaction_date" text NOT NULL,
	"fx_rate_bot" numeric NOT NULL,
	"amount_thb" numeric NOT NULL,
	"type" text NOT NULL,
	"source_type" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"original_name" text NOT NULL,
	"file_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "User" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'USER' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	CONSTRAINT "User_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "Capital_Transactions" ADD CONSTRAINT "Capital_Transactions_user_id_User_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_User_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Capital_Transactions_user_id_idx" ON "Capital_Transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "documents_user_id_idx" ON "documents" USING btree ("user_id");