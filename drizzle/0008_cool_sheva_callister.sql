ALTER TABLE "notifications" ADD COLUMN "entity_id" text;--> statement-breakpoint
CREATE INDEX "notifications_dedup_idx" ON "notifications" USING btree ("user_id","type","entity_id");