CREATE TABLE "anime_language_status" (
	"id" serial PRIMARY KEY NOT NULL,
	"anime_id" integer NOT NULL,
	"language_code" text NOT NULL,
	"media_type" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"is_manual_override" boolean DEFAULT false NOT NULL,
	"notes" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anime_language_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"anime_id" integer NOT NULL,
	"language_code" text NOT NULL,
	"media_type" text NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"evidence_type" text NOT NULL,
	"value" text NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episode_language_status" (
	"id" serial PRIMARY KEY NOT NULL,
	"anime_id" integer NOT NULL,
	"episode_number" integer NOT NULL,
	"language_code" text NOT NULL,
	"media_type" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"provider" text DEFAULT 'manual' NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anime_language_status" ADD CONSTRAINT "anime_language_status_anime_id_anime_id_fk" FOREIGN KEY ("anime_id") REFERENCES "public"."anime"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "anime_language_evidence" ADD CONSTRAINT "anime_language_evidence_anime_id_anime_id_fk" FOREIGN KEY ("anime_id") REFERENCES "public"."anime"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "episode_language_status" ADD CONSTRAINT "episode_language_status_anime_id_anime_id_fk" FOREIGN KEY ("anime_id") REFERENCES "public"."anime"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "episode_language_status" (
	"anime_id",
	"episode_number",
	"language_code",
	"media_type",
	"status",
	"provider",
	"confidence",
	"checked_at",
	"created_at",
	"updated_at"
)
SELECT DISTINCT ON (
	e."anime_id",
	e."number",
	lower(eas."locale"),
	eas."source_provider"
)
	e."anime_id",
	e."number",
	lower(eas."locale") AS "language_code",
	'audio' AS "media_type",
	CASE eas."status"
		WHEN 'unavailable' THEN 'missing'
		WHEN 'available' THEN 'available'
		WHEN 'partial' THEN 'partial'
		ELSE 'unknown'
	END AS "status",
	eas."source_provider" AS "provider",
	CASE
		WHEN eas."source_provider" = 'manual' THEN 100
		WHEN eas."status" = 'unknown' THEN 0
		ELSE 75
	END AS "confidence",
	eas."checked_at",
	eas."created_at",
	eas."updated_at"
FROM "episode_audio_status" eas
INNER JOIN "episodes" e ON e."id" = eas."episode_id"
ORDER BY
	e."anime_id",
	e."number",
	lower(eas."locale"),
	eas."source_provider",
	CASE eas."status"
		WHEN 'available' THEN 4
		WHEN 'partial' THEN 3
		WHEN 'unavailable' THEN 2
		ELSE 1
	END DESC,
	eas."checked_at" DESC;
--> statement-breakpoint
DROP TABLE "episode_audio_status";
--> statement-breakpoint
CREATE UNIQUE INDEX "anime_language_status_anime_language_media_idx" ON "anime_language_status" USING btree ("anime_id","language_code","media_type");
--> statement-breakpoint
CREATE INDEX "anime_language_status_review_queue_idx" ON "anime_language_status" USING btree ("status","confidence","is_manual_override");
--> statement-breakpoint
CREATE INDEX "anime_language_evidence_anime_language_media_idx" ON "anime_language_evidence" USING btree ("anime_id","language_code","media_type");
--> statement-breakpoint
CREATE INDEX "anime_language_evidence_source_idx" ON "anime_language_evidence" USING btree ("source");
--> statement-breakpoint
CREATE INDEX "anime_language_evidence_confidence_idx" ON "anime_language_evidence" USING btree ("confidence");
--> statement-breakpoint
CREATE UNIQUE INDEX "episode_language_status_anime_episode_language_media_idx" ON "episode_language_status" USING btree ("anime_id","episode_number","language_code","media_type","provider");
--> statement-breakpoint
CREATE INDEX "episode_language_status_status_idx" ON "episode_language_status" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "episode_language_status_provider_idx" ON "episode_language_status" USING btree ("provider");
