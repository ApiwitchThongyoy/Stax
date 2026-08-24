CREATE TABLE `Capital_Transactions` (
	`transaction_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`amount_foreign` text NOT NULL,
	`currency` text NOT NULL,
	`transaction_date` text NOT NULL,
	`fx_rate_bot` text NOT NULL,
	`amount_thb` text NOT NULL,
	`type` text NOT NULL,
	`source_type` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `Capital_Transactions_user_id_idx` ON `Capital_Transactions` (`user_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`original_name` text NOT NULL,
	`file_path` text NOT NULL,
	`mime_type` text NOT NULL,
	`file_size` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `documents_user_id_idx` ON `documents` (`user_id`);--> statement-breakpoint
CREATE TABLE `User` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'USER' NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `User_email_unique` ON `User` (`email`);