CREATE TABLE `participant_member_links` (
	`participant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`linked_at` text NOT NULL,
	`linked_by` text NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_by`) REFERENCES `members`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participant_member_links_pair_unique` ON `participant_member_links` (`participant_id`,`member_id`);