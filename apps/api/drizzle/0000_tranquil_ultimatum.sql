CREATE TABLE "anime" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text,
	"title_romaji" text NOT NULL,
	"title_english" text,
	"title_native" text,
	"title_user_preferred" text,
	"description" text,
	"format" text,
	"status" text,
	"source" text,
	"season" text,
	"season_year" integer,
	"start_date" text,
	"end_date" text,
	"episode_count" integer,
	"duration_minutes" integer,
	"country_of_origin" text,
	"is_adult" boolean DEFAULT false NOT NULL,
	"genres_json" text DEFAULT '[]' NOT NULL,
	"synonyms_json" text DEFAULT '[]' NOT NULL,
	"average_score" integer,
	"mean_score" integer,
	"popularity" integer,
	"favourites" integer,
	"trending" integer,
	"cover_image" text,
	"cover_image_color" text,
	"banner_image" text,
	"trailer_video_id" text,
	"trailer_site" text,
	"trailer_thumbnail" text,
	"next_episode_number" integer,
	"next_episode_airs_at" integer,
	"hashtag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anime_external_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"anime_id" integer NOT NULL,
	"site" text NOT NULL,
	"url" text NOT NULL,
	"type" text,
	"language" text,
	"color" text,
	"icon" text
);
--> statement-breakpoint
CREATE TABLE "anime_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"anime_id" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_slug" text,
	"provider_url" text,
	"confidence" integer DEFAULT 100 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anime_relation_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"anime_id" integer NOT NULL,
	"related_anime_id" integer NOT NULL,
	"relation_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anime_studio_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"anime_id" integer NOT NULL,
	"studio_id" integer NOT NULL,
	"is_main" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anime_tag_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"anime_id" integer NOT NULL,
	"tag_id" integer NOT NULL,
	"rank" integer
);
--> statement-breakpoint
CREATE TABLE "episode_audio_status" (
	"id" serial PRIMARY KEY NOT NULL,
	"episode_id" integer NOT NULL,
	"audio_mode" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"source_provider" text DEFAULT 'manual' NOT NULL,
	"notes" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episode_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"episode_id" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_slug" text,
	"provider_url" text,
	"provider_episode_number" text,
	"confidence" integer DEFAULT 100 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"anime_id" integer NOT NULL,
	"number" integer NOT NULL,
	"display_number" text,
	"sort_number" real NOT NULL,
	"season_number" integer,
	"absolute_number" integer,
	"title" text,
	"title_romaji" text,
	"title_english" text,
	"title_native" text,
	"synopsis" text,
	"air_date" text,
	"thumbnail" text,
	"length_minutes" integer,
	"kind" text DEFAULT 'normal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studios" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"is_animation_studio" boolean DEFAULT false NOT NULL,
	"anilist_studio_id" integer
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"items_scanned" integer DEFAULT 0 NOT NULL,
	"items_created" integer DEFAULT 0 NOT NULL,
	"items_updated" integer DEFAULT 0 NOT NULL,
	"items_failed" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"metadata_json" text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"category" text,
	"is_general_spoiler" boolean DEFAULT false NOT NULL,
	"is_media_spoiler" boolean DEFAULT false NOT NULL,
	"is_adult" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anime_external_links" ADD CONSTRAINT "anime_external_links_anime_id_anime_id_fk" FOREIGN KEY ("anime_id") REFERENCES "public"."anime"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_mappings" ADD CONSTRAINT "anime_mappings_anime_id_anime_id_fk" FOREIGN KEY ("anime_id") REFERENCES "public"."anime"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_relation_links" ADD CONSTRAINT "anime_relation_links_anime_id_anime_id_fk" FOREIGN KEY ("anime_id") REFERENCES "public"."anime"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_relation_links" ADD CONSTRAINT "anime_relation_links_related_anime_id_anime_id_fk" FOREIGN KEY ("related_anime_id") REFERENCES "public"."anime"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_studio_links" ADD CONSTRAINT "anime_studio_links_anime_id_anime_id_fk" FOREIGN KEY ("anime_id") REFERENCES "public"."anime"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_studio_links" ADD CONSTRAINT "anime_studio_links_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_tag_links" ADD CONSTRAINT "anime_tag_links_anime_id_anime_id_fk" FOREIGN KEY ("anime_id") REFERENCES "public"."anime"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_tag_links" ADD CONSTRAINT "anime_tag_links_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode_audio_status" ADD CONSTRAINT "episode_audio_status_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode_mappings" ADD CONSTRAINT "episode_mappings_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_anime_id_anime_id_fk" FOREIGN KEY ("anime_id") REFERENCES "public"."anime"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "anime_slug_idx" ON "anime" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "anime_title_romaji_idx" ON "anime" USING btree ("title_romaji");--> statement-breakpoint
CREATE INDEX "anime_title_english_idx" ON "anime" USING btree ("title_english");--> statement-breakpoint
CREATE INDEX "anime_season_idx" ON "anime" USING btree ("season_year","season");--> statement-breakpoint
CREATE INDEX "anime_format_idx" ON "anime" USING btree ("format");--> statement-breakpoint
CREATE INDEX "anime_status_idx" ON "anime" USING btree ("status");--> statement-breakpoint
CREATE INDEX "anime_source_idx" ON "anime" USING btree ("source");--> statement-breakpoint
CREATE INDEX "anime_start_date_idx" ON "anime" USING btree ("start_date");--> statement-breakpoint
CREATE INDEX "anime_trending_idx" ON "anime" USING btree ("trending");--> statement-breakpoint
CREATE INDEX "anime_mean_score_idx" ON "anime" USING btree ("mean_score");--> statement-breakpoint
CREATE UNIQUE INDEX "anime_external_links_anime_url_idx" ON "anime_external_links" USING btree ("anime_id","url");--> statement-breakpoint
CREATE INDEX "anime_external_links_anime_type_idx" ON "anime_external_links" USING btree ("anime_id","type");--> statement-breakpoint
CREATE INDEX "anime_external_links_site_idx" ON "anime_external_links" USING btree ("site");--> statement-breakpoint
CREATE UNIQUE INDEX "anime_mappings_provider_id_idx" ON "anime_mappings" USING btree ("provider","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "anime_mappings_anime_provider_id_idx" ON "anime_mappings" USING btree ("anime_id","provider","provider_id");--> statement-breakpoint
CREATE INDEX "anime_mappings_anime_provider_idx" ON "anime_mappings" USING btree ("anime_id","provider");--> statement-breakpoint
CREATE INDEX "anime_mappings_provider_slug_idx" ON "anime_mappings" USING btree ("provider","provider_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "anime_relation_links_pair_idx" ON "anime_relation_links" USING btree ("anime_id","related_anime_id");--> statement-breakpoint
CREATE INDEX "anime_relation_links_related_idx" ON "anime_relation_links" USING btree ("related_anime_id");--> statement-breakpoint
CREATE INDEX "anime_relation_links_type_idx" ON "anime_relation_links" USING btree ("relation_type");--> statement-breakpoint
CREATE UNIQUE INDEX "anime_studio_links_anime_studio_idx" ON "anime_studio_links" USING btree ("anime_id","studio_id");--> statement-breakpoint
CREATE INDEX "anime_studio_links_anime_idx" ON "anime_studio_links" USING btree ("anime_id");--> statement-breakpoint
CREATE INDEX "anime_studio_links_studio_idx" ON "anime_studio_links" USING btree ("studio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "anime_tag_links_anime_tag_idx" ON "anime_tag_links" USING btree ("anime_id","tag_id");--> statement-breakpoint
CREATE INDEX "anime_tag_links_anime_idx" ON "anime_tag_links" USING btree ("anime_id");--> statement-breakpoint
CREATE INDEX "anime_tag_links_tag_idx" ON "anime_tag_links" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "anime_tag_links_anime_rank_idx" ON "anime_tag_links" USING btree ("anime_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "episode_audio_status_episode_audio_locale_source_idx" ON "episode_audio_status" USING btree ("episode_id","audio_mode","locale","source_provider");--> statement-breakpoint
CREATE INDEX "episode_audio_status_status_idx" ON "episode_audio_status" USING btree ("status");--> statement-breakpoint
CREATE INDEX "episode_audio_status_source_provider_idx" ON "episode_audio_status" USING btree ("source_provider");--> statement-breakpoint
CREATE UNIQUE INDEX "episode_mappings_provider_episode_id_idx" ON "episode_mappings" USING btree ("provider","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "episode_mappings_episode_provider_id_idx" ON "episode_mappings" USING btree ("episode_id","provider","provider_id");--> statement-breakpoint
CREATE INDEX "episode_mappings_episode_provider_idx" ON "episode_mappings" USING btree ("episode_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_anime_number_kind_idx" ON "episodes" USING btree ("anime_id","number","kind");--> statement-breakpoint
CREATE INDEX "episodes_anime_sort_idx" ON "episodes" USING btree ("anime_id","sort_number");--> statement-breakpoint
CREATE INDEX "episodes_air_date_idx" ON "episodes" USING btree ("air_date");--> statement-breakpoint
CREATE UNIQUE INDEX "studios_normalized_name_idx" ON "studios" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "studios_name_idx" ON "studios" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "studios_anilist_id_idx" ON "studios" USING btree ("anilist_studio_id");--> statement-breakpoint
CREATE INDEX "sync_runs_provider_kind_idx" ON "sync_runs" USING btree ("provider","kind");--> statement-breakpoint
CREATE INDEX "sync_runs_status_idx" ON "sync_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_normalized_name_idx" ON "tags" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "tags_name_idx" ON "tags" USING btree ("name");--> statement-breakpoint
CREATE INDEX "tags_category_idx" ON "tags" USING btree ("category");