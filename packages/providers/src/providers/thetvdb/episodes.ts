import { loadExistingAnimeSourceMapping, type EnrichmentContext, type TitleSourceMatch } from "../episode-titles";
import { hasConflictingExplicitEpisodeNumbers } from "../episode-title-scoring";
import {
	getTvdbSeasonEpisodes,
	getTvdbSeriesExtended,
	searchTvdbSeries,
} from "./client";

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
// TVDB lists multi-season anime as a single series, so the original series year (2016) won't
// match the AniList season year (2018). The base title finds the parent series; episode count
// and air date scoring then picks the correct season.
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
	if (hasConflictingExplicitEpisodeNumbers(titles)) {
		return Number.NEGATIVE_INFINITY;
	}

	const episodeCount = context.anilistData.episodeCount ?? context.episodes.length;
	if (
		episodeCount >= 8 &&
		titles.length < Math.ceil(episodeCount * 0.75)
	) {
		return Number.NEGATIVE_INFINITY;
	}

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

function parseStoredMapping(
	value: string,
): { seriesId: number; seasonNumber: number } | null {
	const [seriesId, seasonNumber] = value.split(":");
	if (!seriesId || !seasonNumber) return null;

	const parsedSeriesId = Number(seriesId);
	const parsedSeasonNumber = Number(seasonNumber);
	if (!Number.isFinite(parsedSeriesId) || !Number.isFinite(parsedSeasonNumber)) {
		return null;
	}

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

async function resolveStoredMatch(
	context: EnrichmentContext,
): Promise<TitleSourceMatch | null> {
	const mapping = await loadExistingAnimeSourceMapping(context.animeId, "thetvdb");
	if (!mapping) return null;

	const parsed = parseStoredMapping(mapping.providerId);
	if (!parsed) return null;

	const episodes = await getTvdbSeasonEpisodes(parsed.seriesId, parsed.seasonNumber, "eng");
	const titledEpisodes = sortByEpisodeNumber(episodes
		.filter((episode): episode is typeof episode & { number: number; name: string } =>
			episode.number != null && Boolean(episode.name?.trim()),
		)
		.map((episode) => ({
			providerEpisodeId: String(episode.id),
			providerEpisodeNumber: String(episode.number),
			title: episode.name.trim(),
			description: episode.overview ?? null,
			airDate: episode.aired ?? null,
			providerUrl: `https://thetvdb.com/series/${parsed.seriesId}/episodes/${episode.id}`,
		})));

	if (!titledEpisodes.length) return null;
	if (hasConflictingExplicitEpisodeNumbers(titledEpisodes)) return null;

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

	// Also search with season qualifiers stripped so sequel seasons (listed as a single
	// TVDB series with season 1 start year) are discoverable even when the AniList year
	// is the sequel year (e.g., MHA S3 2018 vs TVDB series year 2016).
	const baseTitles = rawTitles.map(deriveBaseTitle).filter((t): t is string => t !== null);
	const allSearchTitles = [...new Set([...rawTitles, ...baseTitles])];
	// Use all original titles when scoring similarity (strip variants are just search helpers).
	const searchTitles = rawTitles;

	const candidates = new Map<string, { id: number; slug: string | null; score: number }>();

	for (const title of allSearchTitles) {
		// No year filter: TVDB stores multi-season anime as one series with the original
		// start year, so filtering by the AniList season year would exclude it.
		// Episode count + air date scoring in scoreEpisodeBatch differentiates seasons.
		const results = await searchTvdbSeries(title);
		for (const result of results) {
			const id = Number(result.tvdb_id);
			if (!Number.isFinite(id)) continue;

			// Check the result name AND all aliases — TVDB's primary name is often the
			// native-language title (e.g., Japanese), while aliases include English names.
			const labels = [
				result.name ?? result.title ?? "",
				...(result.aliases ?? []),
			].filter(Boolean);
			const similarity = Math.max(
				...searchTitles.flatMap((candidateTitle) =>
					labels.map((label) => titleSimilarity(label, candidateTitle)),
				),
			);
			const score = similarity * 100;
			const key = String(id);
			const existing = candidates.get(key);
			if (!existing || score > existing.score) {
				candidates.set(key, { id, slug: result.slug ?? null, score });
			}
		}
	}

	const rankedCandidates = [...candidates.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, 3);

	let bestMatch: TitleSourceMatch | null = null;
	let bestScore = -Infinity;

	for (const candidate of rankedCandidates) {
		const series = await getTvdbSeriesExtended(candidate.id);
		const seasons = [...new Set((series?.seasons ?? []).map((season) => season.number).filter((value): value is number => typeof value === "number" && value > 0))];

		for (const seasonNumber of seasons.slice(0, 8)) {
			const seasonEpisodes = await getTvdbSeasonEpisodes(candidate.id, seasonNumber, "eng");
			const titledEpisodes = sortByEpisodeNumber(seasonEpisodes
				.filter((episode): episode is typeof episode & { number: number; name: string } =>
					episode.number != null && Boolean(episode.name?.trim()),
				)
				.map((episode) => ({
					providerEpisodeId: String(episode.id),
					providerEpisodeNumber: String(episode.number),
					title: episode.name.trim(),
					description: episode.overview ?? null,
					airDate: episode.aired ?? null,
					providerUrl: `https://thetvdb.com/series/${candidate.slug ?? candidate.id}/episodes/${episode.id}`,
				})));

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
					provider: "thetvdb",
					animeProviderId: `${candidate.id}:${seasonNumber}`,
					animeProviderSlug: candidate.slug,
					animeProviderUrl: candidate.slug
						? `https://thetvdb.com/series/${candidate.slug}/seasons/official/${seasonNumber}`
						: null,
					seasonNumber,
					episodes: titledEpisodes,
				};
			}
		}
	}

	return bestMatch;
}
