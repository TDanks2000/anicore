CREATE TABLE "anime_provider_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"anime_id" integer NOT NULL,
	"provider_entity_id" integer NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anime_provider_mappings_confidence_check" CHECK ("anime_provider_mappings"."confidence" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "anime_provider_segments" (
	"id" serial PRIMARY KEY NOT NULL,
	"anime_provider_mapping_id" integer NOT NULL,
	"provider_episode_start" integer NOT NULL,
	"provider_episode_end" integer NOT NULL,
	"local_episode_start" integer NOT NULL,
	"local_episode_end" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anime_provider_segments_provider_start_positive_check" CHECK ("anime_provider_segments"."provider_episode_start" > 0),
	CONSTRAINT "anime_provider_segments_local_start_positive_check" CHECK ("anime_provider_segments"."local_episode_start" > 0),
	CONSTRAINT "anime_provider_segments_provider_range_check" CHECK ("anime_provider_segments"."provider_episode_end" >= "anime_provider_segments"."provider_episode_start"),
	CONSTRAINT "anime_provider_segments_local_range_check" CHECK ("anime_provider_segments"."local_episode_end" >= "anime_provider_segments"."local_episode_start"),
	CONSTRAINT "anime_provider_segments_equal_span_check" CHECK ("anime_provider_segments"."provider_episode_end" - "anime_provider_segments"."provider_episode_start" = "anime_provider_segments"."local_episode_end" - "anime_provider_segments"."local_episode_start")
);
--> statement-breakpoint
CREATE TABLE "provider_entities" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_slug" text,
	"provider_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anime_provider_mappings" ADD CONSTRAINT "anime_provider_mappings_anime_id_anime_id_fk" FOREIGN KEY ("anime_id") REFERENCES "public"."anime"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_provider_mappings" ADD CONSTRAINT "anime_provider_mappings_provider_entity_id_provider_entities_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_provider_segments" ADD CONSTRAINT "anime_provider_segments_anime_provider_mapping_id_anime_provider_mappings_id_fk" FOREIGN KEY ("anime_provider_mapping_id") REFERENCES "public"."anime_provider_mappings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "anime_provider_mappings_anime_entity_idx" ON "anime_provider_mappings" USING btree ("anime_id","provider_entity_id");--> statement-breakpoint
CREATE INDEX "anime_provider_mappings_anime_idx" ON "anime_provider_mappings" USING btree ("anime_id");--> statement-breakpoint
CREATE INDEX "anime_provider_mappings_entity_idx" ON "anime_provider_mappings" USING btree ("provider_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "anime_provider_segments_range_idx" ON "anime_provider_segments" USING btree ("anime_provider_mapping_id","provider_episode_start","provider_episode_end","local_episode_start","local_episode_end");--> statement-breakpoint
CREATE INDEX "anime_provider_segments_mapping_idx" ON "anime_provider_segments" USING btree ("anime_provider_mapping_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_entities_provider_id_idx" ON "provider_entities" USING btree ("provider","provider_id");--> statement-breakpoint
CREATE INDEX "provider_entities_provider_slug_idx" ON "provider_entities" USING btree ("provider","provider_slug");