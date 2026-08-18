import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { anime } from "./schema";

const PROVIDERS = [
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
] as const;

const MAPPING_SOURCES = [
  "manual",
  "api",
  "import",
  "fuzzy",
  "system",
] as const;

/**
 * Canonical external-provider identity.
 *
 * A provider entity is deliberately independent from an AniCore anime row so
 * one real TVDB/TMDB season can be associated with multiple AniCore anime
 * entries without inventing synthetic provider IDs.
 */
export const providerEntities = pgTable(
  "provider_entities",
  {
    id: serial("id").primaryKey(),
    provider: text("provider", { enum: PROVIDERS }).notNull(),
    providerId: text("provider_id").notNull(),
    providerSlug: text("provider_slug"),
    providerUrl: text("provider_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    providerIdentityIdx: uniqueIndex("provider_entities_provider_id_idx").on(
      table.provider,
      table.providerId,
    ),
    providerSlugIdx: index("provider_entities_provider_slug_idx").on(
      table.provider,
      table.providerSlug,
    ),
  }),
);

/**
 * AniCore-anime association with a canonical provider entity.
 *
 * Unlike legacy anime_mappings, provider_entity_id is not globally unique in
 * this table. That many-to-many cardinality is required for split cours and
 * provider seasons that span multiple AniList entries.
 */
export const animeProviderMappings = pgTable(
  "anime_provider_mappings",
  {
    id: serial("id").primaryKey(),
    animeId: integer("anime_id")
      .notNull()
      .references(() => anime.id, { onDelete: "cascade" }),
    providerEntityId: integer("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "cascade" }),
    confidence: integer("confidence").notNull().default(100),
    source: text("source", { enum: MAPPING_SOURCES })
      .notNull()
      .default("manual"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    animeEntityIdx: uniqueIndex(
      "anime_provider_mappings_anime_entity_idx",
    ).on(table.animeId, table.providerEntityId),
    animeIdx: index("anime_provider_mappings_anime_idx").on(table.animeId),
    entityIdx: index("anime_provider_mappings_entity_idx").on(
      table.providerEntityId,
    ),
    confidenceCheck: check(
      "anime_provider_mappings_confidence_check",
      sql`${table.confidence} between 0 and 100`,
    ),
  }),
);

/**
 * Episode-number alignment for one anime/provider association.
 *
 * A mapping with no segment rows means no explicit transform has been
 * declared yet. Segment-aware consumers must not guess an offset in that
 * case. Each segment maps an inclusive provider range to an equally sized
 * inclusive local range, e.g. provider 13-24 -> local 1-12.
 */
export const animeProviderSegments = pgTable(
  "anime_provider_segments",
  {
    id: serial("id").primaryKey(),
    animeProviderMappingId: integer("anime_provider_mapping_id")
      .notNull()
      .references(() => animeProviderMappings.id, { onDelete: "cascade" }),
    providerEpisodeStart: integer("provider_episode_start").notNull(),
    providerEpisodeEnd: integer("provider_episode_end").notNull(),
    localEpisodeStart: integer("local_episode_start").notNull(),
    localEpisodeEnd: integer("local_episode_end").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    segmentIdx: uniqueIndex("anime_provider_segments_range_idx").on(
      table.animeProviderMappingId,
      table.providerEpisodeStart,
      table.providerEpisodeEnd,
      table.localEpisodeStart,
      table.localEpisodeEnd,
    ),
    mappingIdx: index("anime_provider_segments_mapping_idx").on(
      table.animeProviderMappingId,
    ),
    positiveProviderStartCheck: check(
      "anime_provider_segments_provider_start_positive_check",
      sql`${table.providerEpisodeStart} > 0`,
    ),
    positiveLocalStartCheck: check(
      "anime_provider_segments_local_start_positive_check",
      sql`${table.localEpisodeStart} > 0`,
    ),
    providerRangeCheck: check(
      "anime_provider_segments_provider_range_check",
      sql`${table.providerEpisodeEnd} >= ${table.providerEpisodeStart}`,
    ),
    localRangeCheck: check(
      "anime_provider_segments_local_range_check",
      sql`${table.localEpisodeEnd} >= ${table.localEpisodeStart}`,
    ),
    equalSpanCheck: check(
      "anime_provider_segments_equal_span_check",
      sql`${table.providerEpisodeEnd} - ${table.providerEpisodeStart} = ${table.localEpisodeEnd} - ${table.localEpisodeStart}`,
    ),
  }),
);
