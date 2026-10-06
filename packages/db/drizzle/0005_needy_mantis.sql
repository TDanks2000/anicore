CREATE TABLE `catalogue_revision` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_stage_state` (
	`key` text PRIMARY KEY NOT NULL,
	`anilist_id` integer NOT NULL,
	`stage` text NOT NULL,
	`success_at` integer,
	`next_due_at` integer,
	`attempted_at` integer NOT NULL,
	`retry_at` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`error` text,
	`payload_json` text
);
--> statement-breakpoint
CREATE INDEX `sync_stage_anilist_idx` ON `sync_stage_state` (`anilist_id`);