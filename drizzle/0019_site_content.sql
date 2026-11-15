CREATE TABLE `site_content` (
	`id` integer PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	CONSTRAINT "site_content_singleton" CHECK("site_content"."id" = 1),
	CONSTRAINT "site_content_json_valid" CHECK(json_valid("site_content"."content"))
);
