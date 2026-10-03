import type { AnimeCatalogQuery } from "./anime-query";

/**
 * One row from `GET /anime`. Timestamps arrive as ISO strings because Drizzle's
 * `Date` values are JSON-serialized by Elysia.
 */
export interface AnimeListItem {
  id: number;
  slug: string | null;
  titleRomaji: string;
  titleEnglish: string | null;
  titleNative: string | null;
  titleUserPreferred: string | null;
  description: string | null;
  format: string | null;
  status: string | null;
  source: string | null;
  season: string | null;
  seasonYear: number | null;
  startDate: string | null;
  endDate: string | null;
  episodeCount: number | null;
  durationMinutes: number | null;
  countryOfOrigin: string | null;
  isAdult: boolean;
  genres: string[];
  synonyms: string[];
  averageScore: number | null;
  meanScore: number | null;
  popularity: number | null;
  favourites: number | null;
  trending: number | null;
  coverImage: string | null;
  coverImageColor: string | null;
  bannerImage: string | null;
  trailerVideoId: string | null;
  trailerSite: string | null;
  trailerThumbnail: string | null;
  nextEpisodeNumber: number | null;
  nextEpisodeAirsAt: number | null;
  hashtag: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnimeListResponse {
  items: AnimeListItem[];
  /** Null when the server did not expose a total (older API deployments). */
  total: number | null;
}

export interface AnimeMapping {
  id: number;
  animeId: number;
  provider: string;
  providerId: string;
  providerSlug: string | null;
  providerUrl: string | null;
  confidence: number;
  source: string;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AnimeSegmentMapping {
  id: number;
  provider: string;
  providerId: string;
  providerSlug: string | null;
  providerUrl: string | null;
  confidence: number;
  source: string;
  isPrimary: boolean;
  updatedAt: string;
  segments: Array<{
    providerEpisodeStart: number;
    providerEpisodeEnd: number;
    localEpisodeStart: number;
    localEpisodeEnd: number;
  }>;
}

export interface AnimeEpisode {
  id: number;
  animeId: number;
  number: number;
  displayNumber: string | null;
  sortNumber: number | null;
  seasonNumber: number | null;
  absoluteNumber: number | null;
  title: string | null;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  synopsis: string | null;
  airDate: string | null;
  thumbnail: string | null;
  lengthMinutes: number | null;
  kind: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnimeStudioLink {
  id: number;
  name: string;
  isMain: boolean;
  isAnimationStudio: boolean;
  anilistStudioId: number | null;
}

export interface AnimeTagLink {
  id: number;
  name: string;
  category: string | null;
  rank: number | null;
  isGeneralSpoiler: boolean;
  isMediaSpoiler: boolean;
  isAdult: boolean;
}

export interface AnimeExternalLink {
  id: number;
  animeId: number;
  site: string;
  url: string;
  type: string | null;
  language: string | null;
  color: string | null;
  icon: string | null;
}

export interface AnimeRelationLink {
  id: number;
  animeId: number;
  relatedAnimeId: number;
  relationType: string;
  createdAt: string;
}

export interface AnimeFull extends AnimeListItem {
  mappings: AnimeMapping[];
  /** Shared provider seasons, with the episode range this anime occupies. */
  segmentMappings?: AnimeSegmentMapping[];
  episodes: AnimeEpisode[];
  studios: AnimeStudioLink[];
  tags: AnimeTagLink[];
  externalLinks: AnimeExternalLink[];
  relations: AnimeRelationLink[];
}

export type LanguageMediaType = "audio" | "subtitle";

export interface AnimeLanguageStatusRow {
  id: number;
  animeId: number;
  languageCode: string;
  mediaType: LanguageMediaType;
  status: string;
  confidence: number;
  isManualOverride: boolean;
  notes: string | null;
  checkedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface EpisodeLanguageStatusRow {
  id: number;
  animeId: number;
  episodeNumber: number;
  languageCode: string;
  mediaType: LanguageMediaType;
  status: string;
  provider: string;
  confidence: number;
  checkedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnimeLanguageStatusResponse {
  animeId: number;
  statuses: AnimeLanguageStatusRow[];
  evidence: AnimeLanguageEvidenceRow[];
  episodes: EpisodeLanguageStatusRow[];
}

export interface AnimeLanguageEvidenceRow {
  id: number;
  animeId: number;
  languageCode: string;
  mediaType: LanguageMediaType;
  source: string;
  sourceUrl: string | null;
  evidenceType: string;
  value: string;
  confidence: number;
  updatedAt: string;
}

export function buildAnimeListParams(query: AnimeCatalogQuery): URLSearchParams {
  const params = new URLSearchParams();
  params.set("limit", String(query.pageSize));
  params.set("offset", String((query.page - 1) * query.pageSize));

  const search = query.q.trim();
  if (search) params.set("q", search);
  if (query.format) params.set("format", query.format);
  if (query.season) params.set("season", query.season);
  if (query.seasonYear) params.set("seasonYear", query.seasonYear);
  if (query.status) params.set("status", query.status);

  params.set("sort", query.sort);
  params.set("order", query.order);
  return params;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error;
  } catch {
    // Not JSON; fall through to the generic message.
  }
  return `Request failed with status ${response.status}`;
}

function readTotal(response: Response): number | null {
  const raw = response.headers.get("X-Total-Count");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as T;
}

export async function fetchAnimeList(
  baseUrl: string,
  query: AnimeCatalogQuery,
  signal?: AbortSignal,
): Promise<AnimeListResponse> {
  const base = baseUrl.replace(/\/+$/, "");
  const params = buildAnimeListParams(query);
  const response = await fetch(`${base}/anime?${params.toString()}`, {
    signal,
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const items = (await response.json()) as AnimeListItem[];
  return { items, total: readTotal(response) };
}

export function fetchAnimeFull(
  baseUrl: string,
  animeId: number,
  signal?: AbortSignal,
): Promise<AnimeFull> {
  const base = baseUrl.replace(/\/+$/, "");
  return getJson<AnimeFull>(`${base}/anime/${animeId}/full`, signal);
}

export function fetchAnimeLanguageStatus(
  baseUrl: string,
  animeId: number,
  signal?: AbortSignal,
): Promise<AnimeLanguageStatusResponse> {
  const base = baseUrl.replace(/\/+$/, "");
  return getJson<AnimeLanguageStatusResponse>(`${base}/anime/${animeId}/language-status`, signal);
}
