ALTER TABLE `registration_submissions` ADD `payment_status` text DEFAULT 'unpaid' NOT NULL;--> statement-breakpoint
ALTER TABLE `registration_submissions` ADD `payment_note` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `registration_submissions` ADD `reminder_5d_sent_at` text;--> statement-breakpoint
ALTER TABLE `registration_submissions` ADD `reminder_1d_sent_at` text;