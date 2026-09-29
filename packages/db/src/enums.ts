/**
 * Single source of truth for the closed value sets stored in the database.
 *
 * The Drizzle schema, the API request validators and the provider types all
 * derive from these arrays, so adding a value here is the only change needed
 * to accept it everywhere.
 */

export {
  animeLanguageStatuses,
  episodeLanguageStatuses,
  languageEvidenceSources,
  languageEvidenceTypes,
  languageMediaTypes,
} from "./language-status-scoring";

export const providers = [
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
export type Provider = (typeof providers)[number];

export const mappingSources = ["manual", "api", "import", "fuzzy", "system"] as const;
export type MappingSource = (typeof mappingSources)[number];

export const episodeKinds = [
  "normal",
  "special",
  "ova",
  "recap",
  "trailer",
  "extra",
  "other",
] as const;
export type EpisodeKind = (typeof episodeKinds)[number];

/** Providers a sync run can be recorded against; TheTVDB is only ever enriched. */
export const syncRunProviders = [
  "anilist",
  "kitsu",
  "mal",
  "tmdb",
  "simkl",
  "anisearch",
  "animeplanet",
  "animeschedule",
  "other",
] as const satisfies readonly Provider[];

export const syncRunKinds = ["anime", "episodes", "mappings", "audio_status", "full"] as const;
export const syncRunStatuses = ["running", "success", "failed", "partial"] as const;

export const legacyAudioModes = ["original", "sub", "dub"] as const;
export const legacyAudioStatuses = ["unknown", "unavailable", "available", "partial"] as const;
