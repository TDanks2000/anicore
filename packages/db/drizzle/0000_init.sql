CREATE TABLE `anime` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text,
	`title_romaji` text NOT NULL,
	`title_english` text,
	`title_native` text,
	`title_user_preferred` text,
	`description` text,
	`format` text,
	`status` text,
	`source` text,
	`season` text,
	`season_year` integer,
	`start_date` text,
	`end_date` text,
	`episode_count` integer,
	`duration_minutes` integer,
	`country_of_origin` text,
	`is_adult` integer DEFAULT false NOT NULL,
	`genres_json` text DEFAULT '[]' NOT NULL,
	`synonyms_json` text DEFAULT '[]' NOT NULL,
	`average_score` integer,
	`mean_score` integer,
	`popularity` integer,
	`favourites` integer,
	`trending` integer,
	`cover_image` text,
	`cover_image_color` text,
	`banner_image` text,
	`trailer_video_id` text,
	`trailer_site` text,
	`trailer_thumbnail` text,
	`next_episode_number` integer,
	`next_episode_airs_at` integer,
	`hashtag` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anime_slug_idx` ON `anime` (`slug`);--> statement-breakpoint
CREATE INDEX `anime_title_romaji_idx` ON `anime` (`title_romaji`);--> statement-breakpoint
CREATE INDEX `anime_title_english_idx` ON `anime` (`title_english`);--> statement-breakpoint
CREATE INDEX `anime_season_idx` ON `anime` (`season_year`,`season`);--> statement-breakpoint
CREATE INDEX `anime_format_idx` ON `anime` (`format`);--> statement-breakpoint
CREATE INDEX `anime_status_idx` ON `anime` (`status`);--> statement-breakpoint
CREATE INDEX `anime_source_idx` ON `anime` (`source`);--> statement-breakpoint
CREATE INDEX `anime_start_date_idx` ON `anime` (`start_date`);--> statement-breakpoint
CREATE INDEX `anime_trending_idx` ON `anime` (`trending`);--> statement-breakpoint
CREATE INDEX `anime_mean_score_idx` ON `anime` (`mean_score`);--> statement-breakpoint
CREATE TABLE `anime_external_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anime_id` integer NOT NULL,
	`site` text NOT NULL,
	`url` text NOT NULL,
	`type` text,
	`language` text,
	`color` text,
	`icon` text,
	FOREIGN KEY (`anime_id`) REFERENCES `anime`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anime_external_links_anime_url_idx` ON `anime_external_links` (`anime_id`,`url`);--> statement-breakpoint
CREATE INDEX `anime_external_links_anime_type_idx` ON `anime_external_links` (`anime_id`,`type`);--> statement-breakpoint
CREATE INDEX `anime_external_links_site_idx` ON `anime_external_links` (`site`);--> statement-breakpoint
CREATE TABLE `anime_language_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anime_id` integer NOT NULL,
	`language_code` text NOT NULL,
	`media_type` text NOT NULL,
	`source` text NOT NULL,
	`source_url` text,
	`evidence_type` text NOT NULL,
	`value` text NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`anime_id`) REFERENCES `anime`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `anime_language_evidence_anime_language_media_idx` ON `anime_language_evidence` (`anime_id`,`language_code`,`media_type`);--> statement-breakpoint
CREATE INDEX `anime_language_evidence_source_idx` ON `anime_language_evidence` (`source`);--> statement-breakpoint
CREATE INDEX `anime_language_evidence_confidence_idx` ON `anime_language_evidence` (`confidence`);--> statement-breakpoint
CREATE TABLE `anime_language_status` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anime_id` integer NOT NULL,
	`language_code` text NOT NULL,
	`media_type` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`is_manual_override` integer DEFAULT false NOT NULL,
	`notes` text,
	`checked_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`anime_id`) REFERENCES `anime`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anime_language_status_anime_language_media_idx` ON `anime_language_status` (`anime_id`,`language_code`,`media_type`);--> statement-breakpoint
CREATE INDEX `anime_language_status_review_queue_idx` ON `anime_language_status` (`status`,`confidence`,`is_manual_override`);--> statement-breakpoint
CREATE TABLE `anime_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anime_id` integer NOT NULL,
	`provider` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_slug` text,
	`provider_url` text,
	`confidence` integer DEFAULT 100 NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`anime_id`) REFERENCES `anime`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anime_mappings_provider_id_idx` ON `anime_mappings` (`provider`,`provider_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `anime_mappings_anime_provider_id_idx` ON `anime_mappings` (`anime_id`,`provider`,`provider_id`);--> statement-breakpoint
CREATE INDEX `anime_mappings_anime_provider_idx` ON `anime_mappings` (`anime_id`,`provider`);--> statement-breakpoint
CREATE UNIQUE INDEX `anime_mappings_anime_provider_primary_idx` ON `anime_mappings` (`anime_id`,`provider`) WHERE "anime_mappings"."is_primary";--> statement-breakpoint
CREATE INDEX `anime_mappings_provider_slug_idx` ON `anime_mappings` (`provider`,`provider_slug`);--> statement-breakpoint
CREATE TABLE `anime_relation_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anime_id` integer NOT NULL,
	`related_anime_id` integer NOT NULL,
	`relation_type` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`anime_id`) REFERENCES `anime`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`related_anime_id`) REFERENCES `anime`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anime_relation_links_pair_idx` ON `anime_relation_links` (`anime_id`,`related_anime_id`);--> statement-breakpoint
CREATE INDEX `anime_relation_links_related_idx` ON `anime_relation_links` (`related_anime_id`);--> statement-breakpoint
CREATE INDEX `anime_relation_links_type_idx` ON `anime_relation_links` (`relation_type`);--> statement-breakpoint
CREATE TABLE `anime_studio_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anime_id` integer NOT NULL,
	`studio_id` integer NOT NULL,
	`is_main` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`anime_id`) REFERENCES `anime`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`studio_id`) REFERENCES `studios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anime_studio_links_anime_studio_idx` ON `anime_studio_links` (`anime_id`,`studio_id`);--> statement-breakpoint
CREATE INDEX `anime_studio_links_anime_idx` ON `anime_studio_links` (`anime_id`);--> statement-breakpoint
CREATE INDEX `anime_studio_links_studio_idx` ON `anime_studio_links` (`studio_id`);--> statement-breakpoint
CREATE TABLE `anime_tag_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anime_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	`rank` integer,
	FOREIGN KEY (`anime_id`) REFERENCES `anime`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anime_tag_links_anime_tag_idx` ON `anime_tag_links` (`anime_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `anime_tag_links_anime_idx` ON `anime_tag_links` (`anime_id`);--> statement-breakpoint
CREATE INDEX `anime_tag_links_tag_idx` ON `anime_tag_links` (`tag_id`);--> statement-breakpoint
CREATE INDEX `anime_tag_links_anime_rank_idx` ON `anime_tag_links` (`anime_id`,`rank`);--> statement-breakpoint
CREATE TABLE `episode_language_status` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anime_id` integer NOT NULL,
	`episode_number` integer NOT NULL,
	`language_code` text NOT NULL,
	`media_type` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`provider` text DEFAULT 'manual' NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`checked_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`anime_id`) REFERENCES `anime`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episode_language_status_anime_episode_language_media_idx` ON `episode_language_status` (`anime_id`,`episode_number`,`language_code`,`media_type`,`provider`);--> statement-breakpoint
CREATE INDEX `episode_language_status_status_idx` ON `episode_language_status` (`status`);--> statement-breakpoint
CREATE INDEX `episode_language_status_provider_idx` ON `episode_language_status` (`provider`);--> statement-breakpoint
CREATE TABLE `episode_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`episode_id` integer NOT NULL,
	`provider` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_slug` text,
	`provider_url` text,
	`provider_episode_number` text,
	`confidence` integer DEFAULT 100 NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episode_mappings_provider_episode_id_idx` ON `episode_mappings` (`provider`,`provider_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `episode_mappings_episode_provider_id_idx` ON `episode_mappings` (`episode_id`,`provider`,`provider_id`);--> statement-breakpoint
CREATE INDEX `episode_mappings_episode_provider_idx` ON `episode_mappings` (`episode_id`,`provider`);--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anime_id` integer NOT NULL,
	`number` integer NOT NULL,
	`display_number` text,
	`sort_number` real NOT NULL,
	`season_number` integer,
	`absolute_number` integer,
	`title` text,
	`title_romaji` text,
	`title_english` text,
	`title_native` text,
	`synopsis` text,
	`air_date` text,
	`thumbnail` text,
	`length_minutes` integer,
	`kind` text DEFAULT 'normal' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`anime_id`) REFERENCES `anime`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_anime_number_kind_idx` ON `episodes` (`anime_id`,`number`,`kind`);--> statement-breakpoint
CREATE INDEX `episodes_anime_sort_idx` ON `episodes` (`anime_id`,`sort_number`);--> statement-breakpoint
CREATE INDEX `episodes_air_date_idx` ON `episodes` (`air_date`);--> statement-breakpoint
CREATE TABLE `studios` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`is_animation_studio` integer DEFAULT false NOT NULL,
	`anilist_studio_id` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `studios_normalized_name_idx` ON `studios` (`normalized_name`);--> statement-breakpoint
CREATE INDEX `studios_name_idx` ON `studios` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `studios_anilist_id_idx` ON `studios` (`anilist_studio_id`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`finished_at` integer,
	`items_scanned` integer DEFAULT 0 NOT NULL,
	`items_created` integer DEFAULT 0 NOT NULL,
	`items_updated` integer DEFAULT 0 NOT NULL,
	`items_failed` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`metadata_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_runs_provider_kind_idx` ON `sync_runs` (`provider`,`kind`);--> statement-breakpoint
CREATE INDEX `sync_runs_status_idx` ON `sync_runs` (`status`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`category` text,
	`is_general_spoiler` integer DEFAULT false NOT NULL,
	`is_media_spoiler` integer DEFAULT false NOT NULL,
	`is_adult` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_normalized_name_idx` ON `tags` (`normalized_name`);--> statement-breakpoint
CREATE INDEX `tags_name_idx` ON `tags` (`name`);--> statement-breakpoint
CREATE INDEX `tags_category_idx` ON `tags` (`category`);--> statement-breakpoint
CREATE TABLE `anime_provider_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anime_id` integer NOT NULL,
	`provider_entity_id` integer NOT NULL,
	`confidence` integer DEFAULT 100 NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`anime_id`) REFERENCES `anime`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_entity_id`) REFERENCES `provider_entities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "anime_provider_mappings_confidence_check" CHECK("anime_provider_mappings"."confidence" between 0 and 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anime_provider_mappings_anime_entity_idx` ON `anime_provider_mappings` (`anime_id`,`provider_entity_id`);--> statement-breakpoint
CREATE INDEX `anime_provider_mappings_anime_idx` ON `anime_provider_mappings` (`anime_id`);--> statement-breakpoint
CREATE INDEX `anime_provider_mappings_entity_idx` ON `anime_provider_mappings` (`provider_entity_id`);--> statement-breakpoint
CREATE TABLE `anime_provider_segments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anime_provider_mapping_id` integer NOT NULL,
	`provider_episode_start` integer NOT NULL,
	`provider_episode_end` integer NOT NULL,
	`local_episode_start` integer NOT NULL,
	`local_episode_end` integer NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`anime_provider_mapping_id`) REFERENCES `anime_provider_mappings`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "anime_provider_segments_provider_start_positive_check" CHECK("anime_provider_segments"."provider_episode_start" > 0),
	CONSTRAINT "anime_provider_segments_local_start_positive_check" CHECK("anime_provider_segments"."local_episode_start" > 0),
	CONSTRAINT "anime_provider_segments_provider_range_check" CHECK("anime_provider_segments"."provider_episode_end" >= "anime_provider_segments"."provider_episode_start"),
	CONSTRAINT "anime_provider_segments_local_range_check" CHECK("anime_provider_segments"."local_episode_end" >= "anime_provider_segments"."local_episode_start"),
	CONSTRAINT "anime_provider_segments_equal_span_check" CHECK("anime_provider_segments"."provider_episode_end" - "anime_provider_segments"."provider_episode_start" = "anime_provider_segments"."local_episode_end" - "anime_provider_segments"."local_episode_start")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anime_provider_segments_range_idx` ON `anime_provider_segments` (`anime_provider_mapping_id`,`provider_episode_start`,`provider_episode_end`,`local_episode_start`,`local_episode_end`);--> statement-breakpoint
CREATE INDEX `anime_provider_segments_mapping_idx` ON `anime_provider_segments` (`anime_provider_mapping_id`);--> statement-breakpoint
CREATE TABLE `provider_entities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_slug` text,
	`provider_url` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_entities_provider_id_idx` ON `provider_entities` (`provider`,`provider_id`);--> statement-breakpoint
CREATE INDEX `provider_entities_provider_slug_idx` ON `provider_entities` (`provider`,`provider_slug`);