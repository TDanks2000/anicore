const BASE = "https://animeschedule.net/api/v3";

// anime-schedule.net uses Go's zero time as a sentinel for "not set"
const NULL_DATE = "0001-01-01T00:00:00Z";

export interface EpisodeOverride {
  overrideDate: string;
  overrideEpisode: number;
  episodesAired: number;
}

export interface AnimeScheduleEntry {
  id: string;
  title: string;
  route: string;
  premier: string;
  subPremier: string;
  dubPremier: string;
  episodes: number | null;
  status: string;
  episodeOverride: EpisodeOverride;
  subEpisodeOverride: EpisodeOverride;
  dubEpisodeOverride: EpisodeOverride;
  websites?: {
    aniList?: string;
    mal?: string;
    kitsu?: string;
    anidb?: string;
    official?: string;
    streams?: Array<{ platform: string; url: string; name: string }>;
  };
}

export interface AnimeScheduleSearchResult {
  page: number;
  totalAmount: number;
  anime: AnimeScheduleEntry[];
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  // 5xx means their API is broken for this query — treat as no result rather than
  // propagating an error that would mark the entire anime sync as failed.
  if (res.status >= 500) return null;
  if (!res.ok) throw new Error(`anime-schedule ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

export function hasDub(entry: AnimeScheduleEntry): boolean {
  return entry.dubPremier !== NULL_DATE && entry.dubPremier !== "";
}

export function isFinished(entry: AnimeScheduleEntry): boolean {
  return entry.status === "Finished";
}

// Parses AniList numeric ID out of strings like:
//   "anilist.co/anime/1"
//   "anilist.co/anime/151807/Ore-dake-Level-Up-na-Ken/"
export function parseAnilistId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/\/anime\/(\d+)/);
  return match?.[1] ?? null;
}

export async function fetchByRoute(
  route: string,
): Promise<AnimeScheduleEntry | null> {
  return fetchJson<AnimeScheduleEntry>(
    `${BASE}/anime/${encodeURIComponent(route)}`,
  );
}

export async function searchByTitle(
  title: string,
): Promise<AnimeScheduleEntry[]> {
  const data = await fetchJson<AnimeScheduleSearchResult>(
    `${BASE}/anime?q=${encodeURIComponent(title)}`,
  );
  return data?.anime ?? [];
}
