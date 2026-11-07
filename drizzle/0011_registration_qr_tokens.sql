CREATE TABLE `registration_qr_tokens` (
  `token_hash` text PRIMARY KEY NOT NULL,
  `submission_id` text NOT NULL REFERENCES `registration_submissions`(`id`),
  `issued_at` integer NOT NULL,
  `revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `registration_qr_tokens_submission_idx` ON `registration_qr_tokens` (`submission_id`);
