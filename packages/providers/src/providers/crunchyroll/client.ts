import { formatHttpError } from "../../lib/http";
import { waitForProvider } from "../../lib/provider-wait";

const BASE = "https://www.crunchyroll.com";
// The public web client's anonymous grant: catalogue metadata only, no account.
const ANONYMOUS_CLIENT = "Basic Y3Jfd2ViOg==";
// Identify the application honestly; upstream may still challenge any request.
const USER_AGENT = "anicore/0.1 (+https://github.com/TDanks2000/anicore)";
const DEVICE_ID = crypto.randomUUID();
const CHALLENGE_COOLDOWN_MS = 15 * 60_000;
const RATE_MS = 300;
const GUID = /^[A-Z0-9]{6,40}$/;

export interface CrunchyrollSeries {
  id: string;
  slugTitle: string;
  title: string;
  launchYear: number | null;
}

export interface CrunchyrollSeason {
  id: string;
  seriesId: string;
  title: string;
  seasonNumber: number | null;
  sequenceNumber: number;
  audioLocale: string | null;
  /** False for a dub presented as its own season instead of as a version. */
  isOriginal: boolean;
}

export interface CrunchyrollEpisode {
  id: string;
  seasonId: string;
  /** Display number, e.g. "13", "13.5", "SP1" or "". */
  episode: string;
  episodeNumber: number | null;
  sequenceNumber: number;
  title: string | null;
  /** UTC calendar date of the original broadcast, when Crunchyroll records one. */
  airDate: string | null;
  durationMs: number | null;
  audioLocales: string[];
  subtitleLocales: string[];
}

let token: { value: string; expiresAt: number } | null = null;
let queue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;
let blockedUntil = 0;

/** An upstream access challenge, never a successful empty catalogue. */
export class CrunchyrollAccessBlockedError extends Error {
  constructor(
    public readonly retryAt: number,
    status?: number,
  ) {
    super(
      `Crunchyroll access blocked: Cloudflare challenge${status ? ` (HTTP ${status})` : ""}; ` +
        `retry after ${new Date(retryAt).toISOString()}. Existing evidence is preserved; other language providers can continue.`,
    );
  }
}

function assertAccessAvailable(): void {
  if (blockedUntil > Date.now()) throw new CrunchyrollAccessBlockedError(blockedUntil);
}

async function assertNotChallenged(response: Response): Promise<void> {
  let challenged = response.headers.get("cf-mitigated")?.toLowerCase() === "challenge";
  if (!challenged && response.headers.get("content-type")?.includes("text/html")) {
    // Read only a bounded prefix for older challenge responses without cf-mitigated.
    const reader = response.clone().body?.getReader();
    if (reader) {
      let prefix = "";
      let bytes = 0;
      const decoder = new TextDecoder();
      try {
        while (bytes < 8192) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = value.subarray(0, 8192 - bytes);
          bytes += chunk.length;
          prefix += decoder.decode(chunk, { stream: true });
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      challenged =
        /<title>\s*Just a moment\.\.\.<\/title>|\/cdn-cgi\/challenge-platform|challenges\.cloudflare\.com/i.test(
          prefix,
        );
    }
  }
  if (!challenged) return;
  blockedUntil = Date.now() + CHALLENGE_COOLDOWN_MS;
  token = null;
  void response.body?.cancel().catch(() => {});
  throw new CrunchyrollAccessBlockedError(blockedUntil, response.status);
}

/** Test seam: forget the cached anonymous token. */
export function resetCrunchyrollSession(): void {
  token = null;
  blockedUntil = 0;
  lastRequestAt = 0;
}

async function accessToken(): Promise<string> {
  assertAccessAvailable();
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const response = await fetch(`${BASE}/auth/v1/token`, {
    method: "POST",
    headers: {
      Authorization: ANONYMOUS_CLIENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "client_id",
      client_id: "cr_web",
      device_id: DEVICE_ID,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  await assertNotChallenged(response);
  if (!response.ok) throw new Error(await formatHttpError("Crunchyroll token", response));
  const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token)
    throw new Error("Crunchyroll token response did not include an access token");
  const lifetime = typeof body.expires_in === "number" ? body.expires_in : 300;
  token = { value: body.access_token, expiresAt: Date.now() + lifetime * 1000 };
  return token.value;
}

/** Serialised, rate-limited GET; `null` means the resource does not exist. */
async function get<T>(path: string): Promise<T | null> {
  const operation = queue.then(async () => {
    // Include response classification in the queue, so queued callers observe a
    // challenge before attempting another token or catalogue request.
    for (let attempt = 0; attempt < 2; attempt++) {
      assertAccessAvailable();
      await waitForProvider(Math.max(0, RATE_MS - (Date.now() - lastRequestAt)));
      lastRequestAt = Date.now();
      const url = new URL(path, BASE);
      url.searchParams.set("locale", "en-US");
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(15_000),
      });
      await assertNotChallenged(response);
      if (response.status === 401 && attempt === 0) {
        token = null;
        await response.body?.cancel();
        continue;
      }
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) throw new Error(await formatHttpError("Crunchyroll", response));
      return (await response.json()) as T;
    }
    throw new Error("Crunchyroll authentication retry exhausted");
  });
  queue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Crunchyroll payload");
  return value as Record<string, unknown>;
}

function guid(value: unknown, what: string): string {
  if (typeof value !== "string" || !GUID.test(value))
    throw new Error(`Invalid Crunchyroll ${what}`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function locales(...values: unknown[]): string[] {
  const result = new Set<string>();
  for (const value of values)
    for (const item of Array.isArray(value) ? value : [value])
      if (typeof item === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?$/.test(item))
        result.add(item);
  return [...result];
}

function dataArray(body: unknown): unknown[] {
  const data = record(body).data;
  if (!Array.isArray(data)) throw new Error("Invalid Crunchyroll payload data");
  return data;
}

export function parseSeries(value: unknown): CrunchyrollSeries {
  const item = record(value);
  const slugTitle = optionalString(item.slug_title);
  const title = optionalString(item.title);
  if (!slugTitle || !title) throw new Error("Invalid Crunchyroll series identity");
  const metadata = item.series_metadata ? record(item.series_metadata) : item;
  const year = metadata.series_launch_year;
  return {
    id: guid(item.id, "series id"),
    slugTitle,
    title,
    launchYear: Number.isInteger(year) && (year as number) > 1900 ? (year as number) : null,
  };
}

export function parseSeason(value: unknown): CrunchyrollSeason {
  const item = record(value);
  const id = guid(item.id, "season id");
  const title = optionalString(item.title) ?? "";
  const versions = Array.isArray(item.versions) ? item.versions.map(record) : [];
  const own = versions.find((version) => version.guid === id);
  const sequence = item.season_sequence_number;
  const number = item.season_number;
  return {
    id,
    seriesId: guid(item.series_id, "season series id"),
    title,
    seasonNumber: Number.isInteger(number) ? (number as number) : null,
    sequenceNumber: typeof sequence === "number" && Number.isFinite(sequence) ? sequence : 0,
    audioLocale: optionalString(item.audio_locale),
    isOriginal: typeof own?.original === "boolean" ? own.original : !/\bdub(?:bed)?\b/i.test(title),
  };
}

export function parseEpisode(value: unknown): CrunchyrollEpisode {
  const item = record(value);
  const versions = Array.isArray(item.versions) ? item.versions.map(record) : [];
  const number = item.episode_number;
  const sequence = item.sequence_number;
  const air = optionalString(item.episode_air_date);
  const duration = item.duration_ms;
  return {
    id: guid(item.id, "episode id"),
    seasonId: guid(item.season_id, "episode season id"),
    episode: typeof item.episode === "string" ? item.episode.trim() : "",
    episodeNumber: Number.isInteger(number) && (number as number) > 0 ? (number as number) : null,
    sequenceNumber: typeof sequence === "number" && Number.isFinite(sequence) ? sequence : 0,
    title: optionalString(item.title),
    airDate: air && /^\d{4}-\d{2}-\d{2}T/.test(air) ? air.slice(0, 10) : null,
    durationMs: typeof duration === "number" && duration > 0 ? duration : null,
    audioLocales: locales(
      item.audio_locale,
      versions.map((version) => version.audio_locale),
    ),
    subtitleLocales: locales(item.subtitle_locales),
  };
}

export async function fetchSeries(id: string): Promise<CrunchyrollSeries | null> {
  const body = await get<unknown>(
    `/content/v2/cms/series/${encodeURIComponent(guid(id, "series id"))}`,
  );
  if (body === null) return null;
  const [first] = dataArray(body);
  return first === undefined ? null : parseSeries(first);
}

export async function fetchSeasons(seriesId: string): Promise<CrunchyrollSeason[]> {
  const body = await get<unknown>(
    `/content/v2/cms/series/${encodeURIComponent(guid(seriesId, "series id"))}/seasons`,
  );
  return body === null ? [] : dataArray(body).map(parseSeason);
}

export async function fetchEpisodes(seasonId: string): Promise<CrunchyrollEpisode[]> {
  const body = await get<unknown>(
    `/content/v2/cms/seasons/${encodeURIComponent(guid(seasonId, "season id"))}/episodes`,
  );
  return body === null ? [] : dataArray(body).map(parseEpisode);
}

export async function searchSeries(query: string): Promise<CrunchyrollSeries[]> {
  const params = new URLSearchParams({ q: query, type: "series", n: "10" });
  const body = await get<unknown>(`/content/v2/discover/search?${params}`);
  if (body === null) return [];
  const series: CrunchyrollSeries[] = [];
  for (const group of dataArray(body)) {
    const { type, items } = record(group);
    if (type !== "series" || !Array.isArray(items)) continue;
    for (const item of items) {
      try {
        series.push(parseSeries(item));
      } catch {
        /* A malformed search hit is not a candidate. */
      }
    }
  }
  return series;
}
