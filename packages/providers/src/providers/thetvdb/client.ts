import { formatHttpError } from "../../lib/http";

const TVDB_API_BASE = "https://api4.thetvdb.com/v4";

interface TvdbEnvelope<T> {
	data: T;
	status: string;
	links?: {
		next?: string | null;
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

interface TvdbEpisodeBase {
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

async function tvdbGet<T>(
	path: string,
	query?: Record<string, string | number | undefined>,
): Promise<T | null> {
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

	const json = (await res.json()) as TvdbEnvelope<T>;
	return json.data ?? null;
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

export async function getTvdbSeasonEpisodes(
	seriesId: number,
	seasonNumber: number,
	lang?: string,
): Promise<TvdbEpisodeBase[]> {
	const episodes: TvdbEpisodeBase[] = [];
	let page = 0;

	while (true) {
		const path = lang
			? `/series/${seriesId}/episodes/official/${lang}`
			: `/series/${seriesId}/episodes/official`;

		// When a language is in the URL path, the ?season= query param is silently
		// ignored by TVDB v4 and all seasons' episodes are returned. Filter client-side.
		const query = lang ? { page } : { page, season: seasonNumber };

		const data = await tvdbGet<{ episodes?: TvdbEpisodeBase[] }>(path, query);
		const rawBatch = data?.episodes ?? [];

		if (!rawBatch.length) break;

		const batch = lang
			? rawBatch.filter((e) => e.seasonNumber === seasonNumber)
			: rawBatch;

		episodes.push(...batch);
		if (rawBatch.length < 100) break;
		page++;
	}

	return episodes;
}
