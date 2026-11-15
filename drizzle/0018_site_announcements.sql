CREATE TABLE `site_announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "site_announcements_title_valid" CHECK(length(trim("site_announcements"."title")) BETWEEN 1 AND 120),
	CONSTRAINT "site_announcements_body_valid" CHECK(length(trim("site_announcements"."body")) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE INDEX `site_announcements_published_idx` ON `site_announcements` (`published`,`updated_at`);