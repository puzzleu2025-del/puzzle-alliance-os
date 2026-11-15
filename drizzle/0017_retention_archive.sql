CREATE TABLE `data_retention_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`retention_years` integer NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	CONSTRAINT "data_retention_settings_singleton" CHECK("data_retention_settings"."id" = 1),
	CONSTRAINT "data_retention_settings_years_valid" CHECK("data_retention_settings"."retention_years" BETWEEN 1 AND 10)
);
--> statement-breakpoint
ALTER TABLE `registration_submissions` ADD `archived_at` text;
--> statement-breakpoint
INSERT INTO `data_retention_settings` (`id`,`retention_years`,`updated_at`,`updated_by`) VALUES (1,3,'2026-11-15T00:00:00.000Z','system');