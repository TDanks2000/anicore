CREATE TABLE `season_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anime_id` integer NOT NULL,
	`provider` text NOT NULL,
	`provider_series_id` text NOT NULL,
	`season_number` integer NOT NULL,
	`part_number` integer DEFAULT 1 NOT NULL,
	`confidence` integer DEFAULT 100 NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`anime_id`) REFERENCES `anime`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "season_mappings_season_check" CHECK("season_mappings"."season_number" >= 0),
	CONSTRAINT "season_mappings_part_check" CHECK("season_mappings"."part_number" > 0),
	CONSTRAINT "season_mappings_confidence_check" CHECK("season_mappings"."confidence" between 0 and 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `season_mappings_series_season_part_idx` ON `season_mappings` (`provider`,`provider_series_id`,`season_number`,`part_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `season_mappings_anime_series_season_idx` ON `season_mappings` (`anime_id`,`provider`,`provider_series_id`,`season_number`);--> statement-breakpoint
CREATE INDEX `season_mappings_anime_idx` ON `season_mappings` (`anime_id`);