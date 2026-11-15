CREATE TABLE `activity_fees` (
	`activity_id` text PRIMARY KEY NOT NULL,
	`amount` integer NOT NULL,
	`revision` integer NOT NULL,
	CONSTRAINT "activity_fees_amount_valid" CHECK("activity_fees"."amount" >= 0 AND "activity_fees"."amount" <= 9007199254740991),
	CONSTRAINT "activity_fees_revision_valid" CHECK("activity_fees"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE `registration_submissions` ADD `fee_followup` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `registration_submissions` ADD `fee_recheck_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `registration_submissions` ADD `reconciliation_nonce` text;