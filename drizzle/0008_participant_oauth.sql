CREATE TABLE `participant_oauth_transactions` (
  `state_hash` text PRIMARY KEY NOT NULL,
  `binding_hash` text NOT NULL,
  `nonce` text NOT NULL,
  `code_verifier` text NOT NULL,
  `return_path` text NOT NULL,
  `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `participant_oauth_transactions_expiry_idx` ON `participant_oauth_transactions` (`expires_at`);
