-- Refuse an unsafe legacy state rather than silently skipping meeting records.
-- This executes before schema changes so malformed input fails the migration.
SELECT json(CASE
  WHEN json_valid(data) = 0 THEN 'invalid'
  WHEN COALESCE(json_type(data, '$.meetings'), '') <> 'array' THEN 'invalid'
  WHEN EXISTS (SELECT 1 FROM json_each(data, '$.meetings') m
    WHERE m.type <> 'object' OR COALESCE(json_type(m.value, '$.id'), '') <> 'text'
      OR COALESCE(json_type(m.value, '$.activityId'), '') <> 'text') THEN 'invalid'
  WHEN EXISTS (SELECT 1 FROM json_each(data, '$.meetings') m
    GROUP BY json_extract(m.value, '$.id') HAVING count(*) > 1) THEN 'invalid'
  ELSE 'null' END) FROM workspace_states WHERE id = 1;
--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`position` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `meetings_activity_idx` ON `meetings` (`activity_id`);--> statement-breakpoint
ALTER TABLE `workspace_states` ADD `write_nonce` text;
--> statement-breakpoint
INSERT INTO `meetings` (`id`, `activity_id`, `position`, `data`)
SELECT json_extract(m.value, '$.id'), json_extract(m.value, '$.activityId'), m.key, m.value
FROM `workspace_states` w, json_each(w.data, '$.meetings') m WHERE w.id = 1;
