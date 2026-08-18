import { TMDB, type Season, type SeasonDetails } from "@api-wrappers/tmdb-wrapper";

import { loadExistingAnimeSourceMapping, type EnrichmentContext, type TitleSourceMatch } from "../episode-titles";
import { retireInvalidAutomaticSourceMapping } from "../episode-source-mapping-lifecycle";
import {
	MIN_SOURCE_TITLE_SIMILARITY,
	scoreSourceEpisodeBatch,
	selectSourceCandidate,
	sourceTitleSimilarity,
} from "../episode-source-matching";

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

function parseStoredMapping(value: string): { showId: number; seasonNumber: number } | null {
	const [showId, seasonNumber] = value.split(":");
	if (!showId || !seasonNumber) return null;

	const parsedShowId = Number(showId);
	const parsedSeasonNumber = Number(seasonNumber);
	if (!Number.isInteger(parsedShowId) || parsedShowId <= 0) return null;
	if (!Number.isInteger(parsedSeasonNumber) || parsedSeasonNumber <= 0) return null;

	return { showId: parsedShowId, seasonNumber: parsedSeasonNumber };
}

function sortByEpisodeNumber<T extends { providerEpisodeNumber: string }>(
	episodes: T[],
): T[] {
	return episodes.sort(
		(a, b) =>
			Number(a.providerEpisodeNumber) - Number(b.providerEpisodeNumber),
	);
}

function seasonSummaryScore(context: EnrichmentContext, season: Season): number {
	const summary = season as Season & {
		air_date?: string | null;
		episode_count?: number | null;
	};
	let score = 0;

	if (context.anilistData.seasonYear && summary.air_date) {
		const year = Number(summary.air_date.slice(0, 4));
		if (Number.isInteger(year)) {
			const distance = Math.abs(year - context.anilistData.seasonYear);
			score += distance === 0 ? 60 : distance === 1 ? 30 : -distance * 20;
		}
	}

	if (context.anilistData.episodeCount && summary.episode_count) {
		const diff = Math.abs(
			summary.episode_count - context.anilistData.episodeCount,
		);
		score += Math.max(0, 40 - diff * 5);
	}

	return score;
}

let tmdbClient: TMDB | null | undefined;

function getClient(): TMDB | null {
	if (tmdbClient !== undefined) return tmdbClient;
	const apiKey = process.env.TMDB_API_KEY?.trim();
	tmdbClient = apiKey ? new TMDB({ apiKey }) : null;
	return tmdbClient;
}

function titledEpisodesForSeason(
	showId: number,
	seasonNumber: number,
	season: SeasonDetails,
) {
	return sortByEpisodeNumber(
		(season.episodes ?? [])
			.filter((episode) => Boolean(episode.name?.trim()))
			.map((episode) => ({
				providerEpisodeId: String(episode.id),
				providerEpisodeNumber: String(episode.episode_number),
				title: episode.name.trim(),
				description: episode.overview ?? null,
				airDate: episode.air_date ?? null,
				providerUrl: `https://www.themoviedb.org/tv/${showId}/season/${seasonNumber}/episode/${episode.episode_number}`,
			})),
	);
}

async function resolveStoredMatch(
	context: EnrichmentContext,
	client: TMDB,
): Promise<TitleSourceMatch | null> {
	const mapping = await loadExistingAnimeSourceMapping(context.animeId, "tmdb");
	if (!mapping) return null;

	const parsed = parseStoredMapping(mapping.providerId);
	if (!parsed) {
		await retireInvalidAutomaticSourceMapping({
			animeId: context.animeId,
			provider: "tmdb",
			mapping,
			reason: "malformed stored show/season ID",
		});
		return null;
	}

	const season = await client.tvSeasons.details(
		{ tvShowID: parsed.showId, seasonNumber: parsed.seasonNumber },
		undefined,
		{ language: "en-US" },
	);
	const titledEpisodes = titledEpisodesForSeason(
		parsed.showId,
		parsed.seasonNumber,
		season,
	);

	if (!titledEpisodes.length) {
		throw new Error(
			`Stored tmdb mapping ${mapping.providerId} returned no titled episodes; refusing automatic rematch without evidence that the mapping is wrong`,
		);
	}
	const batchScore = scoreSourceEpisodeBatch(
		{
			seasonYear: context.anilistData.seasonYear,
			episodeCount: context.anilistData.episodeCount,
			episodes: context.episodes,
		},
		titledEpisodes.map((episode) => ({
			number: Number(episode.providerEpisodeNumber),
			title: episode.title,
			airDate: episode.airDate,
		})),
	);
	if (!Number.isFinite(batchScore)) {
		await retireInvalidAutomaticSourceMapping({
			animeId: context.animeId,
			provider: "tmdb",
			mapping,
			reason: "stored season no longer passes episode count/year validation",
		});
		return null;
	}

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
	const baseTitles = rawTitles
		.map(deriveBaseTitle)
		.filter((title): title is string => title !== null);
	const allSearchTitles = [...new Set([...rawTitles, ...baseTitles])];
	const searchTitles = rawTitles;

	const candidates = new Map<number, { id: number; score: number }>();

	for (const title of allSearchTitles) {
		const results = await client.search.tv({
			query: title,
			include_adult: false,
			language: "en-US",
			page: 1,
		});

		for (const result of results.results.slice(0, 5)) {
			const similarity = Math.max(
				0,
				...searchTitles.flatMap((candidateTitle) => [
					sourceTitleSimilarity(result.name, candidateTitle),
					sourceTitleSimilarity(result.original_name, candidateTitle),
				]),
			);
			if (similarity < MIN_SOURCE_TITLE_SIMILARITY) continue;

			const score = similarity * 100;
			const existing = candidates.get(result.id);
			if (!existing || score > existing.score) {
				candidates.set(result.id, { id: result.id, score });
			}
		}
	}

	const rankedShows = [...candidates.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, 3);
	const seasonCandidates: Array<{ value: TitleSourceMatch; score: number }> = [];

	for (const candidate of rankedShows) {
		const show = await client.tvShows.details(candidate.id, undefined, "en-US");

		const rankedSeasons = show.seasons
			.filter((season: Season) => season.season_number > 0)
			.map((season: Season) => ({
				season,
				score: seasonSummaryScore(context, season),
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, 8);

		for (const { season } of rankedSeasons) {
			const details: SeasonDetails = await client.tvSeasons.details(
				{ tvShowID: candidate.id, seasonNumber: season.season_number },
				undefined,
				{ language: "en-US" },
			);
			const titledEpisodes = titledEpisodesForSeason(
				candidate.id,
				season.season_number,
				details,
			);
			if (!titledEpisodes.length) continue;

			const batchScore = scoreSourceEpisodeBatch(
				{
					seasonYear: context.anilistData.seasonYear,
					episodeCount: context.anilistData.episodeCount,
					episodes: context.episodes,
				},
				titledEpisodes.map((episode) => ({
					number: Number(episode.providerEpisodeNumber),
					title: episode.title,
					airDate: episode.airDate,
				})),
			);
			if (!Number.isFinite(batchScore)) continue;

			seasonCandidates.push({
				score: candidate.score + batchScore,
				value: {
					provider: "tmdb",
					animeProviderId: `${candidate.id}:${season.season_number}`,
					animeProviderSlug: null,
					animeProviderUrl: `https://www.themoviedb.org/tv/${candidate.id}/season/${season.season_number}`,
					seasonNumber: season.season_number,
					episodes: titledEpisodes,
				},
			});
		}
	}

	return selectSourceCandidate(seasonCandidates);
}
