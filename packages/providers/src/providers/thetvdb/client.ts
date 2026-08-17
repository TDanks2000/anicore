import { formatHttpError } from "../../lib/http";

const TVDB_API_BASE = "https://api4.thetvdb.com/v4";

interface TvdbEnvelope<T> {
	data: T;
	status: string;
	links?: {
		next?: string | null;
		prev?: string | null;
		self?: string | null;
	};
}

interface TvdbSearchResult {
	tvdb_id?: string;
	name?: string;
	title?: string;
	slug?: string;
	aliases?: string[];
	year?: string;
	type?: string;
}

interface TvdbSeasonRecord {
	number?: number;
}

interface TvdbSeriesExtended {
	id: number;
	name: string;
	slug?: string;
	firstAired?: string;
	seasons?: TvdbSeasonRecord[];
}

export interface TvdbEpisodeBase {
	id: number;
	name?: string;
	number?: number;
	seasonNumber?: number;
	overview?: string;
	aired?: string;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

function getCredentials(): { apiKey: string; pin?: string } | null {
	const apiKey = process.env.TVDB_API_KEY?.trim();
	if (!apiKey) return null;

	const pin = process.env.TVDB_PIN?.trim();
	return pin ? { apiKey, pin } : { apiKey };
}

async function getToken(): Promise<string | null> {
	if (tokenCache && tokenCache.expiresAt > Date.now()) {
		return tokenCache.token;
	}

	const credentials = getCredentials();
	if (!credentials) return null;

	const res = await fetch(`${TVDB_API_BASE}/login`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(
			credentials.pin
				? { apikey: credentials.apiKey, pin: credentials.pin }
				: { apikey: credentials.apiKey },
		),
		signal: AbortSignal.timeout(15_000),
	});

	if (!res.ok) {
		throw new Error(await formatHttpError("TVDB login failed", res));
	}

	const json = (await res.json()) as TvdbEnvelope<{ token: string }>;
	const token = json.data?.token;
	if (!token) {
		throw new Error("TVDB login did not return a token");
	}

	tokenCache = {
		token,
		expiresAt: Date.now() + 25 * 24 * 60 * 60 * 1000,
	};
	return token;
}

async function tvdbGetEnvelope<T>(
	path: string,
	query?: Record<string, string | number | undefined>,
): Promise<TvdbEnvelope<T> | null> {
	const token = await getToken();
	if (!token) return null;

	const url = new URL(`${TVDB_API_BASE}${path}`);
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value !== undefined && value !== "") {
			url.searchParams.set(key, String(value));
		}
	}

	const res = await fetch(url, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
		},
		signal: AbortSignal.timeout(15_000),
	});

	if (!res.ok) {
		throw new Error(await formatHttpError("TVDB request failed", res));
	}

	return (await res.json()) as TvdbEnvelope<T>;
}

async function tvdbGet<T>(
	path: string,
	query?: Record<string, string | number | undefined>,
): Promise<T | null> {
	const envelope = await tvdbGetEnvelope<T>(path, query);
	return envelope?.data ?? null;
}

export async function searchTvdbSeries(
	query: string,
	year?: number | null,
): Promise<TvdbSearchResult[]> {
	const data = await tvdbGet<TvdbSearchResult[]>("/search", {
		query,
		type: "series",
		year: year ?? undefined,
		limit: 5,
	});
	return data ?? [];
}

export async function getTvdbSeriesExtended(
	id: number,
): Promise<TvdbSeriesExtended | null> {
	return tvdbGet<TvdbSeriesExtended>(`/series/${id}/extended`, {
		short: "true",
	});
}

async function fetchTvdbEpisodePages(
	seriesId: number,
	options: { lang?: string; seasonNumber?: number } = {},
): Promise<TvdbEpisodeBase[]> {
	const episodes: TvdbEpisodeBase[] = [];
	let page = 0;

	while (true) {
		const path = options.lang
			? `/series/${seriesId}/episodes/official/${options.lang}`
			: `/series/${seriesId}/episodes/official`;
		const query = options.lang
			? { page }
			: { page, season: options.seasonNumber };

		const envelope = await tvdbGetEnvelope<{ episodes?: TvdbEpisodeBase[] }>(
			path,
			query,
		);
		const rawBatch = envelope?.data?.episodes ?? [];
		if (!rawBatch.length) break;

		episodes.push(...rawBatch);

		// Prefer TVDB's pagination links when present. Keep the old page-size
		// fallback for responses that omit links so older/self-hosted responses do
		// not accidentally loop forever.
		if (envelope?.links) {
			if (!envelope.links.next) break;
		} else if (rawBatch.length < 100) {
			break;
		}
		page++;
	}

	return episodes;
}

/**
 * Fetch all official episodes once. This is especially important for the
 * language-specific TVDB endpoint, which ignores the season query and returns
 * every season; callers can group/filter the result locally without repeating
 * the same full-series request for each season candidate.
 */
export async function getTvdbOfficialEpisodes(
	seriesId: number,
	lang?: string,
): Promise<TvdbEpisodeBase[]> {
	return fetchTvdbEpisodePages(seriesId, { lang });
}

export async function getTvdbSeasonEpisodes(
	seriesId: number,
	seasonNumber: number,
	lang?: string,
): Promise<TvdbEpisodeBase[]> {
	if (lang) {
		const allEpisodes = await getTvdbOfficialEpisodes(seriesId, lang);
		return allEpisodes.filter((episode) => episode.seasonNumber === seasonNumber);
	}

	return fetchTvdbEpisodePages(seriesId, { seasonNumber });
}
