import {
	loadExistingAnimeSourceMapping,
	loadExistingSegmentedAnimeSourceMapping,
	type EnrichmentContext,
	type TitleSourceMatch,
} from "../episode-titles";
import { retireInvalidAutomaticSourceMapping } from "../episode-source-mapping-lifecycle";
import {
	MIN_SOURCE_TITLE_SIMILARITY,
	scoreSourceEpisodeBatch,
	selectSourceCandidate,
	sourceTitleSimilarity,
} from "../episode-source-matching";
import { applyProviderEpisodeSegments } from "../segmented-source-mapping";
import {
	getTvdbOfficialEpisodes,
	getTvdbSeasonEpisodes,
	searchTvdbSeries,
	type TvdbEpisodeBase,
} from "./client";

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

function parseStoredMapping(
	value: string,
): { seriesId: number; seasonNumber: number } | null {
	const [seriesId, seasonNumber] = value.split(":");
	if (!seriesId || !seasonNumber) return null;

	const parsedSeriesId = Number(seriesId);
	const parsedSeasonNumber = Number(seasonNumber);
	if (!Number.isInteger(parsedSeriesId) || parsedSeriesId <= 0) return null;
	if (!Number.isInteger(parsedSeasonNumber) || parsedSeasonNumber <= 0) return null;

	return { seriesId: parsedSeriesId, seasonNumber: parsedSeasonNumber };
}

function sortByEpisodeNumber<T extends { providerEpisodeNumber: string }>(
	episodes: T[],
): T[] {
	return episodes.sort(
		(a, b) =>
			Number(a.providerEpisodeNumber) - Number(b.providerEpisodeNumber),
	);
}

function toTitledEpisodes(
	episodes: TvdbEpisodeBase[],
	seriesId: number,
	slug: string | null,
) {
	return sortByEpisodeNumber(
		episodes
			.filter(
				(episode): episode is TvdbEpisodeBase & { number: number; name: string } =>
					episode.number != null && Boolean(episode.name?.trim()),
			)
			.map((episode) => ({
				providerEpisodeId: String(episode.id),
				providerEpisodeNumber: String(episode.number),
				title: episode.name.trim(),
				description: episode.overview ?? null,
				airDate: episode.aired ?? null,
				providerUrl: `https://thetvdb.com/series/${slug ?? seriesId}/episodes/${episode.id}`,
			})),
	);
}

async function resolveSegmentedStoredMatch(
	context: EnrichmentContext,
): Promise<TitleSourceMatch | null> {
	const mapping = await loadExistingSegmentedAnimeSourceMapping(
		context.animeId,
		"thetvdb",
	);
	if (!mapping) return null;

	const parsed = parseStoredMapping(mapping.providerId);
	if (!parsed) {
		throw new Error(
			`Explicit segmented thetvdb mapping ${mapping.providerId} is malformed; refusing automatic fallback`,
		);
	}

	const episodes = await getTvdbSeasonEpisodes(
		parsed.seriesId,
		parsed.seasonNumber,
		"eng",
	);
	const titledEpisodes = toTitledEpisodes(
		episodes,
		parsed.seriesId,
		mapping.providerSlug,
	);
	if (!titledEpisodes.length) {
		throw new Error(
			`Explicit segmented thetvdb mapping ${mapping.providerId} returned no titled episodes`,
		);
	}

	const segmentedEpisodes = applyProviderEpisodeSegments(
		titledEpisodes,
		mapping.segments,
	);
	if (!segmentedEpisodes.length) {
		throw new Error(
			`Explicit segmented thetvdb mapping ${mapping.providerId} matched no provider episodes`,
		);
	}

	const batchScore = scoreSourceEpisodeBatch(
		{
			seasonYear: context.anilistData.seasonYear,
			episodeCount: context.anilistData.episodeCount,
			episodes: context.episodes,
		},
		segmentedEpisodes.map((episode) => ({
			number: episode.localEpisodeNumber,
			title: episode.title,
			airDate: episode.airDate,
		})),
	);
	if (!Number.isFinite(batchScore)) {
		throw new Error(
			`Explicit segmented thetvdb mapping ${mapping.providerId} no longer passes local episode count/year validation`,
		);
	}

	return {
		provider: "thetvdb",
		animeProviderId: mapping.providerId,
		animeProviderSlug: mapping.providerSlug,
		animeProviderUrl: mapping.providerUrl,
		seasonNumber: parsed.seasonNumber,
		mappingMode: "segmented",
		episodes: segmentedEpisodes,
	};
}

async function resolveStoredMatch(
	context: EnrichmentContext,
): Promise<TitleSourceMatch | null> {
	const segmented = await resolveSegmentedStoredMatch(context);
	if (segmented) return segmented;

	const mapping = await loadExistingAnimeSourceMapping(context.animeId, "thetvdb");
	if (!mapping) return null;

	const parsed = parseStoredMapping(mapping.providerId);
	if (!parsed) {
		await retireInvalidAutomaticSourceMapping({
			animeId: context.animeId,
			provider: "thetvdb",
			mapping,
			reason: "malformed stored series/season ID",
		});
		return null;
	}

	const episodes = await getTvdbSeasonEpisodes(
		parsed.seriesId,
		parsed.seasonNumber,
		"eng",
	);
	const titledEpisodes = toTitledEpisodes(
		episodes,
		parsed.seriesId,
		mapping.providerSlug,
	);

	if (!titledEpisodes.length) {
		throw new Error(
			`Stored thetvdb mapping ${mapping.providerId} returned no titled episodes; refusing automatic rematch without evidence that the mapping is wrong`,
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
			provider: "thetvdb",
			mapping,
			reason: "stored season no longer passes episode count/year validation",
		});
		return null;
	}

	return {
		provider: "thetvdb",
		animeProviderId: mapping.providerId,
		animeProviderSlug: mapping.providerSlug,
		animeProviderUrl: mapping.providerUrl,
		seasonNumber: parsed.seasonNumber,
		episodes: titledEpisodes,
	};
}

export async function fetchTvdbEpisodeTitles(
	context: EnrichmentContext,
): Promise<TitleSourceMatch | null> {
	const stored = await resolveStoredMatch(context);
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

	const candidates = new Map<
		string,
		{ id: number; slug: string | null; score: number }
	>();

	for (const title of allSearchTitles) {
		const results = await searchTvdbSeries(title);
		for (const result of results) {
			const id = Number(result.tvdb_id);
			if (!Number.isInteger(id) || id <= 0) continue;

			const labels = [
				result.name ?? result.title ?? "",
				...(result.aliases ?? []),
			].filter(Boolean);
			const similarity = Math.max(
				0,
				...searchTitles.flatMap((candidateTitle) =>
					labels.map((label) => sourceTitleSimilarity(label, candidateTitle)),
				),
			);
			if (similarity < MIN_SOURCE_TITLE_SIMILARITY) continue;

			const score = similarity * 100;
			const key = String(id);
			const existing = candidates.get(key);
			if (!existing || score > existing.score) {
				candidates.set(key, { id, slug: result.slug ?? null, score });
			}
		}
	}

	const rankedSeries = [...candidates.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, 3);
	const seasonCandidates: Array<{ value: TitleSourceMatch; score: number }> = [];

	for (const candidate of rankedSeries) {
		const allEpisodes = await getTvdbOfficialEpisodes(candidate.id, "eng");
		const bySeason = new Map<number, TvdbEpisodeBase[]>();
		for (const episode of allEpisodes) {
			if (!episode.seasonNumber || episode.seasonNumber <= 0) continue;
			const rows = bySeason.get(episode.seasonNumber) ?? [];
			rows.push(episode);
			bySeason.set(episode.seasonNumber, rows);
		}

		for (const [seasonNumber, seasonEpisodes] of bySeason) {
			const titledEpisodes = toTitledEpisodes(
				seasonEpisodes,
				candidate.id,
				candidate.slug,
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
					provider: "thetvdb",
					animeProviderId: `${candidate.id}:${seasonNumber}`,
					animeProviderSlug: candidate.slug,
					animeProviderUrl: candidate.slug
						? `https://thetvdb.com/series/${candidate.slug}/seasons/official/${seasonNumber}`
						: null,
					seasonNumber,
					episodes: titledEpisodes,
				},
			});
		}
	}

	return selectSourceCandidate(seasonCandidates);
}
