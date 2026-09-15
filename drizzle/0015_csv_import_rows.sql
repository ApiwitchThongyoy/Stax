CREATE TABLE "csv_import_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"document_id" text NOT NULL,
	"row_hash" text NOT NULL,
	"source_type" text NOT NULL,
	"canonical_row" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "csv_import_rows" ADD CONSTRAINT "csv_import_rows_user_id_User_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_import_rows" ADD CONSTRAINT "csv_import_rows_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "csv_import_rows_user_id_idx" ON "csv_import_rows" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "csv_import_rows_document_id_idx" ON "csv_import_rows" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "csv_import_rows_user_row_hash_idx" ON "csv_import_rows" USING btree ("user_id","row_hash");