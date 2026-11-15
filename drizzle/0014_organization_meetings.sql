PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text,
	`position` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_meetings`("id", "activity_id", "position", "data") SELECT "id", "activity_id", "position", "data" FROM `meetings`;--> statement-breakpoint
DROP TABLE `meetings`;--> statement-breakpoint
ALTER TABLE `__new_meetings` RENAME TO `meetings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `meetings_activity_idx` ON `meetings` (`activity_id`);