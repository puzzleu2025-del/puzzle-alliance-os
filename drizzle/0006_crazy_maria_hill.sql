ALTER TABLE `members` ADD `phone` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `organization` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `position` text DEFAULT '' NOT NULL;--> statement-breakpoint
INSERT INTO `members` (`user_id`,`username`,`email`,`display_name`,`phone`,`organization`,`position`,`role`,`status`,`created_at`)
SELECT 'admin-kao19950411','kao19950411','','嘉駿','','','','admin','active',strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE NOT EXISTS (SELECT 1 FROM `members` WHERE `role`='admin' AND `status`='active');
