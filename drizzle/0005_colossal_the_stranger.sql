CREATE TABLE `password_reset_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`requested_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `members`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `members` ADD `username` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `members` SET `username` = CASE WHEN `role` = 'admin' AND `status` = 'active' THEN 'kao19950411' ELSE 'member-' || lower(hex(randomblob(8))) END WHERE `username` = '';--> statement-breakpoint
CREATE UNIQUE INDEX `members_username_unique` ON `members` (`username`);--> statement-breakpoint
INSERT INTO `members` (`user_id`,`username`,`email`,`display_name`,`role`,`status`,`created_at`)
SELECT 'admin-kao19950411','kao19950411','','嘉駿','admin','active',datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM `members` WHERE `role`='admin' AND `status`='active');--> statement-breakpoint
UPDATE `members` SET `username`='kao19950411',`display_name`='嘉駿' WHERE `role`='admin' AND `status`='active';--> statement-breakpoint
DELETE FROM `admin_sessions` WHERE `user_id` IN (SELECT `user_id` FROM `members` WHERE `role`='admin' AND `status`='active');--> statement-breakpoint
INSERT OR REPLACE INTO `admin_credentials` (`user_id`,`password_hash`,`salt`,`updated_at`)
SELECT `user_id`,'17b9cf9d33be1c7a4ff34fcea251ada400cea6ed5cb0c47c4274f41ff4d644ef','puzzle-default-admin-2026-v1',CAST(strftime('%s','now') AS INTEGER)*1000
FROM `members` WHERE `role`='admin' AND `status`='active' LIMIT 1;
