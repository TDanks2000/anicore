import { TMDB, type Season, type SeasonDetails } from "@api-wrappers/tmdb-wrapper";

import { loadExistingAnimeSourceMapping, type EnrichmentContext, type TitleSourceMatch } from "../episode-titles";

function normalizeTitle(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
}

function titleSimilarity(a: string, b: string): number {
	const aWords = normalizeTitle(a).split(/\s+/).filter(Boolean);
	const bWords = new Set(normalizeTitle(b).split(/\s+/).filter(Boolean));
	if (!aWords.length || !bWords.size) return 0;
	return aWords.filter((word) => bWords.has(word)).length /
		Math.max(aWords.length, bWords.size);
}

// Strip season qualifiers so e.g. "My Hero Academia 3rd Season" also searches as "My Hero Academia".
function deriveBaseTitle(title: string): string | null {
	const stripped = title
		.replace(/\s+(?:season|part|series|cour)\s*\d+\s*$/i, "")
		.replace(/\s+\d+(?:st|nd|rd|th)\s+(?:season|series|cour)\s*$/i, "")
		.replace(/\s+(?:second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:season|series|cour)\s*$/i, "")
		.replace(/\s+(?:II|III|IV|VI{0,3}|IX)\s*$/i, "")
		.replace(/\s+\d+\s*$/, "")
		.trim();
	return stripped !== title && stripped.length >= 3 ? stripped : null;
}

function scoreEpisodeBatch(context: EnrichmentContext, titles: { number: number; title: string; airDate?: string | null }[]): number {
	const episodeCount = context.anilistData.episodeCount ?? context.episodes.length;
	const batchYear = titles[0]?.airDate ? Number(titles[0].airDate.slice(0, 4)) : null;
	const localAirDates = new Map(
		context.episodes
			.filter((episode) => episode.airDate)
			.map((episode) => [episode.number, episode.airDate]),
	);

	let score = 0;
	if (episodeCount > 0) {
		const diff = Math.abs(titles.length - episodeCount);
		score += Math.max(0, 30 - diff * 4);
	}

	if (batchYear && context.anilistData.seasonYear) {
		const diff = Math.abs(batchYear - context.anilistData.seasonYear);
		score += Math.max(0, 20 - diff * 8);
	}

	for (const title of titles) {
		const localAirDate = localAirDates.get(title.number);
		if (localAirDate && title.airDate && localAirDate === title.airDate) {
			score += 8;
		}
	}

	score += titles.filter((title) => title.title.trim().length > 0).length;
	return score;
}

function parseStoredMapping(value: string): { showId: number; seasonNumber: number } | null {
	const [showId, seasonNumber] = value.split(":");
	if (!showId || !seasonNumber) return null;

	const parsedShowId = Number(showId);
	const parsedSeasonNumber = Number(seasonNumber);
	if (!Number.isFinite(parsedShowId) || !Number.isFinite(parsedSeasonNumber)) {
		return null;
	}

	return { showId: parsedShowId, seasonNumber: parsedSeasonNumber };
}

let tmdbClient: TMDB | null | undefined;

function getClient(): TMDB | null {
	if (tmdbClient !== undefined) return tmdbClient;
	const apiKey = process.env.TMDB_API_KEY?.trim();
	tmdbClient = apiKey ? new TMDB({ apiKey }) : null;
	return tmdbClient;
}

async function resolveStoredMatch(
	context: EnrichmentContext,
	client: TMDB,
): Promise<TitleSourceMatch | null> {
	const mapping = await loadExistingAnimeSourceMapping(context.animeId, "tmdb");
	if (!mapping) return null;

	const parsed = parseStoredMapping(mapping.providerId);
	if (!parsed) return null;

	const season = await client.tvSeasons.details(
		{ tvShowID: parsed.showId, seasonNumber: parsed.seasonNumber },
		undefined,
		{ language: "en-US" },
	);

	const titledEpisodes = (season.episodes ?? [])
		.filter((episode) => Boolean(episode.name?.trim()))
		.map((episode) => ({
			providerEpisodeId: String(episode.id),
			providerEpisodeNumber: String(episode.episode_number),
			title: episode.name.trim(),
			description: episode.overview ?? null,
			airDate: episode.air_date ?? null,
			providerUrl: `https://www.themoviedb.org/tv/${parsed.showId}/season/${parsed.seasonNumber}/episode/${episode.episode_number}`,
		}));

	if (!titledEpisodes.length) return null;

	return {
		provider: "tmdb",
		animeProviderId: mapping.providerId,
		animeProviderSlug: mapping.providerSlug,
		animeProviderUrl: mapping.providerUrl,
		seasonNumber: parsed.seasonNumber,
		episodes: titledEpisodes,
	};
}

export async function fetchTmdbEpisodeTitles(
	context: EnrichmentContext,
): Promise<TitleSourceMatch | null> {
	const client = getClient();
	if (!client) return null;

	const stored = await resolveStoredMatch(context, client);
	if (stored) return stored;

	const rawTitles = [
		context.anilistData.titleEnglish,
		context.anilistData.titleRomaji,
	].filter((title): title is string => Boolean(title));

	// Also search with season qualifiers stripped so sequel seasons find the parent series.
	const baseTitles = rawTitles.map(deriveBaseTitle).filter((t): t is string => t !== null);
	const allSearchTitles = [...new Set([...rawTitles, ...baseTitles])];
	const searchTitles = rawTitles;

	const candidates = new Map<number, { id: number; score: number }>();

	for (const title of allSearchTitles) {
		// No first_air_date_year filter: TMDB stores multi-season anime as one series with
		// the original start year, so filtering by the AniList season year would exclude it.
		const results = await client.search.tv({
			query: title,
			include_adult: false,
			language: "en-US",
			page: 1,
		});

		for (const result of results.results.slice(0, 5)) {
			const similarity = Math.max(
				...searchTitles.flatMap((candidateTitle) => [
					titleSimilarity(result.name, candidateTitle),
					titleSimilarity(result.original_name, candidateTitle),
				]),
			);
			const score = similarity * 100;
			const existing = candidates.get(result.id);
			if (!existing || score > existing.score) {
				candidates.set(result.id, { id: result.id, score });
			}
		}
	}

	const rankedCandidates = [...candidates.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, 3);

	let bestMatch: TitleSourceMatch | null = null;
	let bestScore = -Infinity;

	for (const candidate of rankedCandidates) {
		const show = await client.tvShows.details(candidate.id, undefined, "en-US");

		for (const season of show.seasons
			.filter((entry: Season) => entry.season_number > 0)
			.slice(0, 8)) {
			const details: SeasonDetails = await client.tvSeasons.details(
				{ tvShowID: candidate.id, seasonNumber: season.season_number },
				undefined,
				{ language: "en-US" },
			);

			const titledEpisodes = (details.episodes ?? [])
				.filter((episode: SeasonDetails["episodes"][number]) => Boolean(episode.name?.trim()))
				.map((episode: SeasonDetails["episodes"][number]) => ({
					providerEpisodeId: String(episode.id),
					providerEpisodeNumber: String(episode.episode_number),
					title: episode.name.trim(),
					description: episode.overview ?? null,
					airDate: episode.air_date ?? null,
					providerUrl: `https://www.themoviedb.org/tv/${candidate.id}/season/${season.season_number}/episode/${episode.episode_number}`,
				}));

			if (!titledEpisodes.length) continue;

			const score = scoreEpisodeBatch(
				context,
				titledEpisodes.map((episode) => ({
					number: Number(episode.providerEpisodeNumber),
					title: episode.title,
					airDate: episode.airDate,
				})),
			) + candidate.score;

			if (score > bestScore) {
				bestScore = score;
				bestMatch = {
					provider: "tmdb",
					animeProviderId: `${candidate.id}:${season.season_number}`,
					animeProviderSlug: null,
					animeProviderUrl: `https://www.themoviedb.org/tv/${candidate.id}/season/${season.season_number}`,
					seasonNumber: season.season_number,
					episodes: titledEpisodes,
				};
			}
		}
	}

	return bestMatch;
}
