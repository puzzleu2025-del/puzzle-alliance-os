ALTER TABLE `participant_sessions` ADD `consent_epoch` integer;
--> statement-breakpoint
CREATE TABLE `participant_terms` (
  `version` text PRIMARY KEY NOT NULL,
  `content` text NOT NULL,
  CONSTRAINT `participant_terms_version_nonempty` CHECK (length(trim(`version`)) > 0),
  CONSTRAINT `participant_terms_content_nonempty` CHECK (length(trim(`content`)) > 0)
);
--> statement-breakpoint
CREATE TRIGGER `participant_terms_no_update` BEFORE UPDATE ON `participant_terms`
BEGIN
  SELECT RAISE(ABORT, 'participant terms are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `participant_terms_no_replace` BEFORE INSERT ON `participant_terms`
WHEN EXISTS (SELECT 1 FROM `participant_terms` WHERE `version` = NEW.`version`)
BEGIN
  SELECT RAISE(ABORT, 'participant terms are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `participant_terms_no_delete` BEFORE DELETE ON `participant_terms`
BEGIN
  SELECT RAISE(ABORT, 'participant terms are immutable');
END;
--> statement-breakpoint
CREATE TABLE `participant_terms_current` (
  `id` integer PRIMARY KEY NOT NULL,
  `version` text NOT NULL REFERENCES `participant_terms`(`version`),
  CONSTRAINT `participant_terms_current_singleton` CHECK (`id` = 1)
);
--> statement-breakpoint
CREATE TRIGGER `participant_terms_current_no_replace` BEFORE INSERT ON `participant_terms_current`
WHEN EXISTS (SELECT 1 FROM `participant_terms_current` WHERE `id` = NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'participant current terms cannot be replaced');
END;
--> statement-breakpoint
CREATE TRIGGER `participant_terms_current_no_delete` BEFORE DELETE ON `participant_terms_current`
BEGIN
  SELECT RAISE(ABORT, 'participant current terms cannot be deleted');
END;
--> statement-breakpoint
CREATE TABLE `participant_consent_state` (
  `participant_id` text PRIMARY KEY NOT NULL REFERENCES `participants`(`id`),
  `status` text NOT NULL,
  `epoch` integer NOT NULL,
  `terms_version` text NOT NULL REFERENCES `participant_terms`(`version`),
  CONSTRAINT `participant_consent_state_status` CHECK (`status` IN ('active', 'revoked')),
  CONSTRAINT `participant_consent_state_epoch` CHECK (`epoch` >= 1)
);
--> statement-breakpoint
CREATE TRIGGER `participant_terms_change_invalidate` AFTER UPDATE OF `version` ON `participant_terms_current`
WHEN OLD.`version` <> NEW.`version`
BEGIN
  UPDATE `participant_consent_state` SET `status` = 'revoked', `epoch` = `epoch` + 1 WHERE `status` = 'active';
END;
--> statement-breakpoint
CREATE TABLE `participant_pending_identities` (
  `token_hash` text PRIMARY KEY NOT NULL,
  `google_sub` text NOT NULL,
  `email` text NOT NULL,
  `display_name` text NOT NULL,
  `terms_version` text NOT NULL REFERENCES `participant_terms`(`version`),
  `expires_at` integer NOT NULL,
  `claim` text
);
--> statement-breakpoint
CREATE INDEX `participant_pending_identities_expiry_idx` ON `participant_pending_identities` (`expires_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `participant_pending_identities_claim_unique` ON `participant_pending_identities` (`claim`) WHERE `claim` IS NOT NULL;
