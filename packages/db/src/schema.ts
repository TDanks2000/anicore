import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	pgTable,
	real,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const anime = pgTable(
	"anime",
	{
		id: serial("id").primaryKey(),

		slug: text("slug"),

		titleRomaji: text("title_romaji").notNull(),
		titleEnglish: text("title_english"),
		titleNative: text("title_native"),
		titleUserPreferred: text("title_user_preferred"),

		description: text("description"),

		format: text("format"),
		status: text("status"),
		source: text("source"),

		season: text("season"),
		seasonYear: integer("season_year"),
		startDate: text("start_date"),
		endDate: text("end_date"),

		episodeCount: integer("episode_count"),
		durationMinutes: integer("duration_minutes"),

		countryOfOrigin: text("country_of_origin"),
		isAdult: boolean("is_adult").notNull().default(false),

		genresJson: text("genres_json").notNull().default("[]"),
		synonymsJson: text("synonyms_json").notNull().default("[]"),

		averageScore: integer("average_score"),
		meanScore: integer("mean_score"),
		popularity: integer("popularity"),
		favourites: integer("favourites"),
		trending: integer("trending"),

		coverImage: text("cover_image"),
		coverImageColor: text("cover_image_color"),
		bannerImage: text("banner_image"),

		trailerVideoId: text("trailer_video_id"),
		trailerSite: text("trailer_site"),
		trailerThumbnail: text("trailer_thumbnail"),

		nextEpisodeNumber: integer("next_episode_number"),
		nextEpisodeAirsAt: integer("next_episode_airs_at"),

		hashtag: text("hashtag"),

		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		slugIdx: uniqueIndex("anime_slug_idx").on(table.slug),
		titleRomajiIdx: index("anime_title_romaji_idx").on(table.titleRomaji),
		titleEnglishIdx: index("anime_title_english_idx").on(table.titleEnglish),
		seasonIdx: index("anime_season_idx").on(table.seasonYear, table.season),
		formatIdx: index("anime_format_idx").on(table.format),
		statusIdx: index("anime_status_idx").on(table.status),
		sourceIdx: index("anime_source_idx").on(table.source),
		startDateIdx: index("anime_start_date_idx").on(table.startDate),
		trendingIdx: index("anime_trending_idx").on(table.trending),
		meanScoreIdx: index("anime_mean_score_idx").on(table.meanScore),
	}),
);

export const animeMappings = pgTable(
	"anime_mappings",
	{
		id: serial("id").primaryKey(),

		animeId: integer("anime_id")
			.notNull()
			.references(() => anime.id, { onDelete: "cascade" }),

		provider: text("provider", {
			enum: [
				"anilist",
				"kitsu",
				"thetvdb",
				"mal",
				"tmdb",
				"simkl",
				"anisearch",
				"animeplanet",
				"animeschedule",
				"other",
			],
		}).notNull(),

		providerId: text("provider_id").notNull(),
		providerSlug: text("provider_slug"),
		providerUrl: text("provider_url"),

		confidence: integer("confidence").notNull().default(100),

		source: text("source", {
			enum: ["manual", "api", "import", "fuzzy", "system"],
		})
			.notNull()
			.default("manual"),

		isPrimary: boolean("is_primary").notNull().default(false),

		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		providerIdIdx: uniqueIndex("anime_mappings_provider_id_idx").on(
			table.provider,
			table.providerId,
		),

		animeProviderIdIdx: uniqueIndex("anime_mappings_anime_provider_id_idx").on(
			table.animeId,
			table.provider,
			table.providerId,
		),

		animeProviderIdx: index("anime_mappings_anime_provider_idx").on(
			table.animeId,
			table.provider,
		),

		providerSlugIdx: index("anime_mappings_provider_slug_idx").on(
			table.provider,
			table.providerSlug,
		),
	}),
);

export const animeRelationLinks = pgTable(
	"anime_relation_links",
	{
		id: serial("id").primaryKey(),

		animeId: integer("anime_id")
			.notNull()
			.references(() => anime.id, { onDelete: "cascade" }),

		relatedAnimeId: integer("related_anime_id")
			.notNull()
			.references(() => anime.id, { onDelete: "cascade" }),

		relationType: text("relation_type").notNull(),

		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		pairIdx: uniqueIndex("anime_relation_links_pair_idx").on(
			table.animeId,
			table.relatedAnimeId,
		),
		relatedIdx: index("anime_relation_links_related_idx").on(
			table.relatedAnimeId,
		),
		typeIdx: index("anime_relation_links_type_idx").on(table.relationType),
	}),
);

export const studios = pgTable(
	"studios",
	{
		id: serial("id").primaryKey(),
		name: text("name").notNull(),
		normalizedName: text("normalized_name").notNull(),
		isAnimationStudio: boolean("is_animation_studio").notNull().default(false),
		anilistStudioId: integer("anilist_studio_id"),
	},
	(table) => ({
		normalizedNameIdx: uniqueIndex("studios_normalized_name_idx").on(
			table.normalizedName,
		),
		nameIdx: index("studios_name_idx").on(table.name),
		anilistIdIdx: uniqueIndex("studios_anilist_id_idx").on(
			table.anilistStudioId,
		),
	}),
);

export const animeStudioLinks = pgTable(
	"anime_studio_links",
	{
		id: serial("id").primaryKey(),

		animeId: integer("anime_id")
			.notNull()
			.references(() => anime.id, { onDelete: "cascade" }),

		studioId: integer("studio_id")
			.notNull()
			.references(() => studios.id, { onDelete: "cascade" }),

		isMain: boolean("is_main").notNull().default(false),
	},
	(table) => ({
		animeStudioIdx: uniqueIndex("anime_studio_links_anime_studio_idx").on(
			table.animeId,
			table.studioId,
		),
		animeIdx: index("anime_studio_links_anime_idx").on(table.animeId),
		studioIdx: index("anime_studio_links_studio_idx").on(table.studioId),
	}),
);

export const tags = pgTable(
	"tags",
	{
		id: serial("id").primaryKey(),
		name: text("name").notNull(),
		normalizedName: text("normalized_name").notNull(),
		category: text("category"),
		isGeneralSpoiler: boolean("is_general_spoiler").notNull().default(false),
		isMediaSpoiler: boolean("is_media_spoiler").notNull().default(false),
		isAdult: boolean("is_adult").notNull().default(false),
	},
	(table) => ({
		normalizedNameIdx: uniqueIndex("tags_normalized_name_idx").on(
			table.normalizedName,
		),
		nameIdx: index("tags_name_idx").on(table.name),
		categoryIdx: index("tags_category_idx").on(table.category),
	}),
);

export const animeTagLinks = pgTable(
	"anime_tag_links",
	{
		id: serial("id").primaryKey(),

		animeId: integer("anime_id")
			.notNull()
			.references(() => anime.id, { onDelete: "cascade" }),

		tagId: integer("tag_id")
			.notNull()
			.references(() => tags.id, { onDelete: "cascade" }),

		rank: integer("rank"),
	},
	(table) => ({
		animeTagIdx: uniqueIndex("anime_tag_links_anime_tag_idx").on(
			table.animeId,
			table.tagId,
		),
		animeIdx: index("anime_tag_links_anime_idx").on(table.animeId),
		tagIdx: index("anime_tag_links_tag_idx").on(table.tagId),
		animeRankIdx: index("anime_tag_links_anime_rank_idx").on(
			table.animeId,
			table.rank,
		),
	}),
);

export const animeExternalLinks = pgTable(
	"anime_external_links",
	{
		id: serial("id").primaryKey(),

		animeId: integer("anime_id")
			.notNull()
			.references(() => anime.id, { onDelete: "cascade" }),

		site: text("site").notNull(),
		url: text("url").notNull(),
		type: text("type"),
		language: text("language"),
		color: text("color"),
		icon: text("icon"),
	},
	(table) => ({
		animeUrlIdx: uniqueIndex("anime_external_links_anime_url_idx").on(
			table.animeId,
			table.url,
		),
		animeTypeIdx: index("anime_external_links_anime_type_idx").on(
			table.animeId,
			table.type,
		),
		siteIdx: index("anime_external_links_site_idx").on(table.site),
	}),
);

export const episodes = pgTable(
	"episodes",
	{
		id: serial("id").primaryKey(),

		animeId: integer("anime_id")
			.notNull()
			.references(() => anime.id, { onDelete: "cascade" }),

		number: integer("number").notNull(),

		displayNumber: text("display_number"),

		sortNumber: real("sort_number").notNull(),

		seasonNumber: integer("season_number"),
		absoluteNumber: integer("absolute_number"),

		title: text("title"),
		titleRomaji: text("title_romaji"),
		titleEnglish: text("title_english"),
		titleNative: text("title_native"),

		synopsis: text("synopsis"),

		airDate: text("air_date"),
		thumbnail: text("thumbnail"),

		lengthMinutes: integer("length_minutes"),

		kind: text("kind", {
			enum: ["normal", "special", "ova", "recap", "trailer", "extra", "other"],
		})
			.notNull()
			.default("normal"),

		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		animeNumberKindIdx: uniqueIndex("episodes_anime_number_kind_idx").on(
			table.animeId,
			table.number,
			table.kind,
		),

		animeSortIdx: index("episodes_anime_sort_idx").on(
			table.animeId,
			table.sortNumber,
		),

		airDateIdx: index("episodes_air_date_idx").on(table.airDate),
	}),
);

export const episodeMappings = pgTable(
	"episode_mappings",
	{
		id: serial("id").primaryKey(),

		episodeId: integer("episode_id")
			.notNull()
			.references(() => episodes.id, { onDelete: "cascade" }),

		provider: text("provider", {
			enum: [
				"anilist",
				"kitsu",
				"thetvdb",
				"mal",
				"tmdb",
				"simkl",
				"anisearch",
				"animeplanet",
				"animeschedule",
				"other",
			],
		}).notNull(),

		providerId: text("provider_id").notNull(),
		providerSlug: text("provider_slug"),
		providerUrl: text("provider_url"),

		providerEpisodeNumber: text("provider_episode_number"),

		confidence: integer("confidence").notNull().default(100),

		source: text("source", {
			enum: ["manual", "api", "import", "fuzzy", "system"],
		})
			.notNull()
			.default("manual"),

		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		providerEpisodeIdIdx: uniqueIndex(
			"episode_mappings_provider_episode_id_idx",
		).on(table.provider, table.providerId),

		episodeProviderIdIdx: uniqueIndex(
			"episode_mappings_episode_provider_id_idx",
		).on(table.episodeId, table.provider, table.providerId),

		episodeProviderIdx: index("episode_mappings_episode_provider_idx").on(
			table.episodeId,
			table.provider,
		),
	}),
);

export const episodeAudioStatus = pgTable(
	"episode_audio_status",
	{
		id: serial("id").primaryKey(),

		episodeId: integer("episode_id")
			.notNull()
			.references(() => episodes.id, { onDelete: "cascade" }),

		audioMode: text("audio_mode", {
			enum: ["original", "sub", "dub"],
		}).notNull(),

		locale: text("locale").notNull().default("en"),

		status: text("status", {
			enum: ["unknown", "unavailable", "available", "partial"],
		})
			.notNull()
			.default("unknown"),

		sourceProvider: text("source_provider").notNull().default("manual"),

		notes: text("notes"),

		checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),

		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		episodeAudioLocaleSourceIdx: uniqueIndex(
			"episode_audio_status_episode_audio_locale_source_idx",
		).on(table.episodeId, table.audioMode, table.locale, table.sourceProvider),

		statusIdx: index("episode_audio_status_status_idx").on(table.status),

		sourceProviderIdx: index("episode_audio_status_source_provider_idx").on(
			table.sourceProvider,
		),
	}),
);

export const syncRuns = pgTable(
	"sync_runs",
	{
		id: serial("id").primaryKey(),

		provider: text("provider", {
			enum: [
				"anilist",
				"kitsu",
				"mal",
				"tmdb",
				"simkl",
				"anisearch",
				"animeplanet",
				"animeschedule",
				"other",
			],
		}).notNull(),

		kind: text("kind", {
			enum: ["anime", "episodes", "mappings", "audio_status", "full"],
		}).notNull(),

		status: text("status", {
			enum: ["running", "success", "failed", "partial"],
		})
			.notNull()
			.default("running"),

		startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),

		finishedAt: timestamp("finished_at", { withTimezone: true }),

		itemsScanned: integer("items_scanned").notNull().default(0),
		itemsCreated: integer("items_created").notNull().default(0),
		itemsUpdated: integer("items_updated").notNull().default(0),
		itemsFailed: integer("items_failed").notNull().default(0),

		errorMessage: text("error_message"),
		metadataJson: text("metadata_json").notNull().default("{}"),
	},
	(table) => ({
		providerKindIdx: index("sync_runs_provider_kind_idx").on(
			table.provider,
			table.kind,
		),

		statusIdx: index("sync_runs_status_idx").on(table.status),
	}),
);

// Drizzle ORM relation definitions

export const animeOrmRelations = relations(anime, ({ many }) => ({
	mappings: many(animeMappings),
	episodes: many(episodes),
	relationLinks: many(animeRelationLinks, { relationName: "animeSource" }),
	relatedToLinks: many(animeRelationLinks, { relationName: "animeRelated" }),
	studioLinks: many(animeStudioLinks),
	tagLinks: many(animeTagLinks),
	externalLinks: many(animeExternalLinks),
}));

export const animeMappingsRelations = relations(animeMappings, ({ one }) => ({
	anime: one(anime, {
		fields: [animeMappings.animeId],
		references: [anime.id],
	}),
}));

export const animeRelationLinksRelations = relations(
	animeRelationLinks,
	({ one }) => ({
		anime: one(anime, {
			fields: [animeRelationLinks.animeId],
			references: [anime.id],
			relationName: "animeSource",
		}),
		relatedAnime: one(anime, {
			fields: [animeRelationLinks.relatedAnimeId],
			references: [anime.id],
			relationName: "animeRelated",
		}),
	}),
);

export const studiosRelations = relations(studios, ({ many }) => ({
	animeLinks: many(animeStudioLinks),
}));

export const animeStudioLinksRelations = relations(
	animeStudioLinks,
	({ one }) => ({
		anime: one(anime, {
			fields: [animeStudioLinks.animeId],
			references: [anime.id],
		}),
		studio: one(studios, {
			fields: [animeStudioLinks.studioId],
			references: [studios.id],
		}),
	}),
);

export const tagsRelations = relations(tags, ({ many }) => ({
	animeLinks: many(animeTagLinks),
}));

export const animeTagLinksRelations = relations(animeTagLinks, ({ one }) => ({
	anime: one(anime, {
		fields: [animeTagLinks.animeId],
		references: [anime.id],
	}),
	tag: one(tags, {
		fields: [animeTagLinks.tagId],
		references: [tags.id],
	}),
}));

export const animeExternalLinksRelations = relations(
	animeExternalLinks,
	({ one }) => ({
		anime: one(anime, {
			fields: [animeExternalLinks.animeId],
			references: [anime.id],
		}),
	}),
);

export const episodesRelations = relations(episodes, ({ one, many }) => ({
	anime: one(anime, {
		fields: [episodes.animeId],
		references: [anime.id],
	}),
	mappings: many(episodeMappings),
	audioStatuses: many(episodeAudioStatus),
}));

export const episodeMappingsRelations = relations(
	episodeMappings,
	({ one }) => ({
		episode: one(episodes, {
			fields: [episodeMappings.episodeId],
			references: [episodes.id],
		}),
	}),
);

export const episodeAudioStatusRelations = relations(
	episodeAudioStatus,
	({ one }) => ({
		episode: one(episodes, {
			fields: [episodeAudioStatus.episodeId],
			references: [episodes.id],
		}),
	}),
);

export type Anime = typeof anime.$inferSelect;
export type NewAnime = typeof anime.$inferInsert;

export type AnimeMapping = typeof animeMappings.$inferSelect;
export type NewAnimeMapping = typeof animeMappings.$inferInsert;

export type AnimeRelationLink = typeof animeRelationLinks.$inferSelect;
export type NewAnimeRelationLink = typeof animeRelationLinks.$inferInsert;

export type Studio = typeof studios.$inferSelect;
export type NewStudio = typeof studios.$inferInsert;

export type AnimeStudioLink = typeof animeStudioLinks.$inferSelect;
export type NewAnimeStudioLink = typeof animeStudioLinks.$inferInsert;

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;

export type AnimeTagLink = typeof animeTagLinks.$inferSelect;
export type NewAnimeTagLink = typeof animeTagLinks.$inferInsert;

export type AnimeExternalLink = typeof animeExternalLinks.$inferSelect;
export type NewAnimeExternalLink = typeof animeExternalLinks.$inferInsert;

export type Episode = typeof episodes.$inferSelect;
export type NewEpisode = typeof episodes.$inferInsert;

export type EpisodeMapping = typeof episodeMappings.$inferSelect;
export type NewEpisodeMapping = typeof episodeMappings.$inferInsert;

export type EpisodeAudioStatus = typeof episodeAudioStatus.$inferSelect;
export type NewEpisodeAudioStatus = typeof episodeAudioStatus.$inferInsert;

export type SyncRun = typeof syncRuns.$inferSelect;
export type NewSyncRun = typeof syncRuns.$inferInsert;
