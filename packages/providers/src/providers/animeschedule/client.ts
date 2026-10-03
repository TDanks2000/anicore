import { formatHttpError } from "../../lib/http";

const BASE = "https://animeschedule.net/api/v3";

// anime-schedule.net uses Go's zero time as a sentinel for "not set"
export const NULL_DATE = "0001-01-01T00:00:00Z";

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
  jpnTime?: string | null;
  subTime?: string | null;
  dubTime?: string | null;
  subTimeTBD?: boolean;
  dubTimeTBD?: boolean;
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
  if (!res.ok) throw new Error(await formatHttpError("anime-schedule", res));
  return res.json() as Promise<T>;
}

export function hasDub(entry: AnimeScheduleEntry): boolean {
  return hasLanguageTrack(entry, "audio");
}

export function validScheduleDate(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).getUTCFullYear() > 1 ? time : null;
}

function releaseMinute(value: unknown): number | null {
  const time = validScheduleDate(value);
  if (time === null) return null;
  const date = new Date(time);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/** AnimeSchedule's documented *-exists rule; release-time dates are NOT release dates. */
export function hasLanguageTrack(
  entry: AnimeScheduleEntry,
  mediaType: "audio" | "subtitle",
): boolean {
  const premiere = mediaType === "audio" ? entry.dubPremier : entry.subPremier;
  if (validScheduleDate(premiere) !== null) return true;
  const tbd = mediaType === "audio" ? entry.dubTimeTBD : entry.subTimeTBD;
  const minute = releaseMinute(mediaType === "audio" ? entry.dubTime : entry.subTime);
  return !tbd && minute !== null && minute !== 0 && minute !== releaseMinute(entry.jpnTime);
}

export function isFinished(entry: AnimeScheduleEntry): boolean {
  return entry.status === "Finished";
}

// Parses AniList numeric ID out of strings like:
//   "anilist.co/anime/1"
//   "anilist.co/anime/151807/Ore-dake-Level-Up-na-Ken/"
export function parseAnilistId(url: string | undefined): string | null {
  return parseProviderReference(url, ["anilist.co"], true);
}

// Parses MyAnimeList numeric ID out of strings like:
//   "myanimelist.net/anime/36522"
//   "myanimelist.net/anime/37029/Hoozuki_no_Reitetsu_2nd_Season__Sono_Ni"
export function parseMalId(url: string | undefined): string | null {
  return parseProviderReference(url, ["myanimelist.net"], true);
}

function parseProviderReference(
  value: string | undefined,
  hosts: string[],
  numeric: boolean,
): string | null {
  if (!value) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (
      !hosts.includes(url.hostname.replace(/^www\./, "")) ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    const id = /^\/anime\/([^/]+)(?:\/|$)/.exec(url.pathname)?.[1];
    if (!id || (numeric && !/^[1-9]\d*$/.test(id))) return null;
    return id;
  } catch {
    return null;
  }
}

export interface KitsuReference {
  kitsuId: string | null;
  kitsuSlug: string | null;
}

/**
 * Parses a Kitsu reference, which AnimeSchedule publishes in two shapes:
 *   "kitsu.io/anime/13628"                        -> numeric id
 *   "kitsu.io/anime/hoozuki-no-reitetsu-2nd-...'  -> slug
 * Only the numeric form can be stored as a provider id directly; the slug form
 * is returned separately so callers can resolve it when they are able to.
 */
export function parseKitsuReference(url: string | undefined): KitsuReference {
  if (!url) return { kitsuId: null, kitsuSlug: null };
  const value = parseProviderReference(url, ["kitsu.io", "kitsu.app"], false);
  if (!value) return { kitsuId: null, kitsuSlug: null };
  if (/^\d+$/.test(value) && !/^[1-9]\d*$/.test(value)) return { kitsuId: null, kitsuSlug: null };
  return /^[1-9]\d*$/.test(value)
    ? { kitsuId: value, kitsuSlug: null }
    : { kitsuId: null, kitsuSlug: value };
}

export async function fetchByRoute(route: string): Promise<AnimeScheduleEntry | null> {
  const value = await fetchJson<unknown>(`${BASE}/anime/${encodeURIComponent(route)}`);
  return value === null ? null : validateEntry(value);
}

export function validateEntry(value: unknown): AnimeScheduleEntry {
  if (!value || typeof value !== "object") throw new Error("Invalid AnimeSchedule entry");
  const entry = value as AnimeScheduleEntry;
  if (
    typeof entry.route !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.route) ||
    typeof entry.title !== "string" ||
    !entry.title.trim()
  ) {
    throw new Error("Invalid AnimeSchedule identity payload");
  }
  if (
    entry.websites != null &&
    (typeof entry.websites !== "object" || Array.isArray(entry.websites))
  )
    throw new Error("Invalid AnimeSchedule cross-references");
  for (const field of ["aniList", "mal", "kitsu"] as const) {
    const reference = entry.websites?.[field];
    if (reference != null && typeof reference !== "string")
      throw new Error(`Invalid AnimeSchedule ${field} reference`);
  }
  return entry;
}

async function search(params: URLSearchParams): Promise<AnimeScheduleEntry[]> {
  const entries: AnimeScheduleEntry[] = [];
  for (let page = 1; page <= 20; page++) {
    params.set("page", String(page));
    const data = await fetchJson<AnimeScheduleSearchResult>(`${BASE}/anime?${params}`);
    if (!data) {
      if (page === 1) return [];
      throw new Error("Incomplete AnimeSchedule search pagination");
    }
    if (!Array.isArray(data.anime) || !Number.isInteger(data.totalAmount) || data.totalAmount < 0)
      throw new Error("Invalid AnimeSchedule search payload");
    entries.push(...data.anime.map(validateEntry));
    if (entries.length >= data.totalAmount) return entries;
    if (!data.anime.length) throw new Error("Incomplete AnimeSchedule search pagination");
  }
  throw new Error("AnimeSchedule search exceeded pagination limit");
}

export async function searchByAnilistId(id: string): Promise<AnimeScheduleEntry[]> {
  if (!/^[1-9]\d*$/.test(id)) throw new Error("Invalid AniList id");
  return search(new URLSearchParams({ "anilist-ids": id }));
}

export async function searchByTitle(title: string): Promise<AnimeScheduleEntry[]> {
  return search(new URLSearchParams({ q: title }));
}
