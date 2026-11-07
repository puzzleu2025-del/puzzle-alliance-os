CREATE UNIQUE INDEX `registration_submissions_id_form_unique` ON `registration_submissions` (`id`, `form_id`);
--> statement-breakpoint
CREATE TABLE `participants` (
  `id` text PRIMARY KEY NOT NULL,
  `google_sub` text NOT NULL,
  `email` text NOT NULL,
  `display_name` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participants_google_sub_unique` ON `participants` (`google_sub`);
--> statement-breakpoint
CREATE TABLE `participant_sessions` (
  `token_hash` text PRIMARY KEY NOT NULL,
  `participant_id` text NOT NULL REFERENCES `participants`(`id`),
  `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `participant_sessions_participant_idx` ON `participant_sessions` (`participant_id`);
--> statement-breakpoint
CREATE TABLE `participant_consents` (
  `id` text PRIMARY KEY NOT NULL,
  `participant_id` text NOT NULL REFERENCES `participants`(`id`),
  `version` text NOT NULL,
  `accepted_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `participant_consents_participant_idx` ON `participant_consents` (`participant_id`);
--> statement-breakpoint
CREATE TABLE `registration_identities` (
  `submission_id` text PRIMARY KEY NOT NULL,
  `form_id` text NOT NULL,
  `member_id` text REFERENCES `members`(`user_id`),
  `participant_id` text REFERENCES `participants`(`id`),
  `status` text DEFAULT 'active' NOT NULL,
  CONSTRAINT `registration_identities_submission_form_fk` FOREIGN KEY (`submission_id`, `form_id`) REFERENCES `registration_submissions`(`id`, `form_id`),
  CONSTRAINT `registration_identities_one_identity` CHECK ((`member_id` IS NOT NULL) <> (`participant_id` IS NOT NULL)),
  CONSTRAINT `registration_identities_valid_status` CHECK (`status` IN ('active', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registration_identities_form_member_unique` ON `registration_identities` (`form_id`, `member_id`) WHERE `member_id` IS NOT NULL AND `status` = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX `registration_identities_form_participant_unique` ON `registration_identities` (`form_id`, `participant_id`) WHERE `participant_id` IS NOT NULL AND `status` = 'active';
