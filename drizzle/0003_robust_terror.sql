CREATE TABLE `registration_forms` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`schema_json` text NOT NULL,
	`privacy_notice` text NOT NULL,
	`version` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `members`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registration_forms_activity_unique` ON `registration_forms` (`activity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `registration_forms_slug_unique` ON `registration_forms` (`slug`);--> statement-breakpoint
CREATE TABLE `registration_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`form_version` integer NOT NULL,
	`schema_json` text NOT NULL,
	`answers_json` text NOT NULL,
	`consent` integer NOT NULL,
	`idempotency_hash` text NOT NULL,
	`source_hash` text NOT NULL,
	`submitted_at` text NOT NULL,
	FOREIGN KEY (`form_id`) REFERENCES `registration_forms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `registration_submissions_form_idx` ON `registration_submissions` (`form_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `registration_submissions_idempotency_unique` ON `registration_submissions` (`form_id`,`idempotency_hash`);