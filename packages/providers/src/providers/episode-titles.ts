import { and, eq } from "drizzle-orm";

import { db } from "@anicore/db";
import { animeMappings, episodeMappings, episodes } from "@anicore/db/schema";
import { fetchTvdbEpisodeTitles } from "./thetvdb/episodes";
import { fetchTmdbEpisodeTitles } from "./tmdb/episodes";
import type { ProviderAnimeData } from "./types";

interface EpisodeRow {
	id: number;
	number: number;
	title: string | null;
	titleEnglish: string | null;
	titleRomaji: string | null;
	synopsis: string | null;
	airDate: string | null;
	seasonNumber: number | null;
}

interface EpisodeTitlePreviewRow {
	number: number;
	title?: string | null;
	titleEnglish?: string | null;
	titleRomaji?: string | null;
	synopsis?: string | null;
	airDate?: string | null;
	seasonNumber?: number | null;
}

interface EpisodeTitleMatch {
	providerEpisodeId: string;
	providerEpisodeNumber: string;
	title: string;
	description?: string | null;
	airDate?: string | null;
	providerUrl?: string | null;
}

interface TitleSourceMatch {
	provider: "thetvdb" | "tmdb";
	animeProviderId: string;
	animeProviderSlug?: string | null;
	animeProviderUrl?: string | null;
	seasonNumber: number;
	episodes: EpisodeTitleMatch[];
}

interface EnrichmentContext {
	animeId: number;
	anilistData: ProviderAnimeData;
	episodes: EpisodeRow[];
}

export interface EpisodeTitleEnrichmentResult {
	updated: number;
	sourcesUsed: Array<"thetvdb" | "tmdb">;
}

export interface EpisodeTitleEnrichmentPreview {
	possibleUpdates: number;
	sourcesUsed: Array<"thetvdb" | "tmdb">;
	errors: string[];
	episodeRowsSource: "database" | "provided";
	skippedReason?: "no-anime-id" | "no-episode-rows" | "no-missing-titles";
	matches: Array<{
		provider: "thetvdb" | "tmdb";
		seasonNumber: number;
		episodeCount: number;
		sampleTitles: string[];
	}>;
}

async function loadEpisodeRows(animeId: number): Promise<EpisodeRow[]> {
	return db
		.select({
			id: episodes.id,
			number: episodes.number,
			title: episodes.title,
			titleEnglish: episodes.titleEnglish,
			titleRomaji: episodes.titleRomaji,
			synopsis: episodes.synopsis,
			airDate: episodes.airDate,
			seasonNumber: episodes.seasonNumber,
		})
		.from(episodes)
		.where(eq(episodes.animeId, animeId));
}

function isTitleMissing(row: EpisodeRow): boolean {
	return !row.title && !row.titleEnglish && !row.titleRomaji;
}

function isPreviewTitleMissing(row: EpisodeTitlePreviewRow): boolean {
	return !row.title && !row.titleEnglish && !row.titleRomaji;
}

function toPreviewRows(rows: EpisodeTitlePreviewRow[]): EpisodeRow[] {
	return rows.map((row, index) => ({
		id: -(index + 1),
		number: row.number,
		title: row.title ?? null,
		titleEnglish: row.titleEnglish ?? null,
		titleRomaji: row.titleRomaji ?? null,
		synopsis: row.synopsis ?? null,
		airDate: row.airDate ?? null,
		seasonNumber: row.seasonNumber ?? null,
	}));
}

async function upsertAnimeSourceMapping(
	animeId: number,
	match: TitleSourceMatch,
): Promise<void> {
	const [mapping] = await db
		.insert(animeMappings)
		.values({
			animeId,
			provider: match.provider,
			providerId: match.animeProviderId,
			providerSlug: match.animeProviderSlug ?? null,
			providerUrl: match.animeProviderUrl ?? null,
			confidence: 85,
			source: "api",
			isPrimary: false,
		})
		.onConflictDoUpdate({
			target: [animeMappings.provider, animeMappings.providerId],
			set: {
				providerSlug: match.animeProviderSlug ?? null,
				providerUrl: match.animeProviderUrl ?? null,
				confidence: 85,
				source: "api",
				isPrimary: false,
				updatedAt: new Date(),
			},
			setWhere: eq(animeMappings.animeId, animeId),
		})
		.returning({ animeId: animeMappings.animeId });

	if (!mapping) {
		throw new Error(
			`${match.provider} mapping ${match.animeProviderId} already belongs to another anime`,
		);
	}
}

async function applySourceMatch(
	animeId: number,
	rows: EpisodeRow[],
	match: TitleSourceMatch,
): Promise<number> {
	const rowsByNumber = new Map(rows.map((row) => [row.number, row]));
	let updated = 0;

	await upsertAnimeSourceMapping(animeId, match);

	for (const episode of match.episodes) {
		const row = rowsByNumber.get(Number(episode.providerEpisodeNumber));
		if (!row || !isTitleMissing(row)) {
			continue;
		}

		const [mapping] = await db
			.insert(episodeMappings)
			.values({
				episodeId: row.id,
				provider: match.provider,
				providerId: episode.providerEpisodeId,
				providerSlug: null,
				providerUrl: episode.providerUrl ?? null,
				providerEpisodeNumber: episode.providerEpisodeNumber,
				confidence: 85,
				source: "api",
			})
			.onConflictDoUpdate({
				target: [episodeMappings.provider, episodeMappings.providerId],
				set: {
					providerSlug: null,
					providerUrl: episode.providerUrl ?? null,
					providerEpisodeNumber: episode.providerEpisodeNumber,
					confidence: 85,
					source: "api",
					updatedAt: new Date(),
				},
				setWhere: eq(episodeMappings.episodeId, row.id),
			})
			.returning({ episodeId: episodeMappings.episodeId });

		if (!mapping) {
			throw new Error(
				`${match.provider} episode mapping ${episode.providerEpisodeId} already belongs to another episode`,
			);
		}

		await db
			.update(episodes)
			.set({
				title: row.title ?? episode.title,
				titleEnglish: row.titleEnglish ?? episode.title,
				synopsis: row.synopsis ?? episode.description ?? null,
				airDate: row.airDate ?? episode.airDate ?? null,
				seasonNumber: row.seasonNumber ?? match.seasonNumber,
				updatedAt: new Date(),
			})
			.where(eq(episodes.id, row.id));

		row.title = episode.title;
		row.titleEnglish = episode.title;
		row.synopsis = row.synopsis ?? episode.description ?? null;
		row.airDate = row.airDate ?? episode.airDate ?? null;
		row.seasonNumber = row.seasonNumber ?? match.seasonNumber;
		updated++;
	}

	return updated;
}

export async function enrichEpisodeTitlesForAnime(
	animeId: number,
	anilistData: ProviderAnimeData,
): Promise<EpisodeTitleEnrichmentResult> {
	const rows = await loadEpisodeRows(animeId);
	if (!rows.length || rows.every((row) => !isTitleMissing(row))) {
		return { updated: 0, sourcesUsed: [] };
	}

	const context: EnrichmentContext = { animeId, anilistData, episodes: rows };
	const sourcesUsed: Array<"thetvdb" | "tmdb"> = [];
	let updated = 0;

	let tvdbMatch: TitleSourceMatch | null = null;
	try {
		tvdbMatch = await fetchTvdbEpisodeTitles(context);
	} catch {
		tvdbMatch = null;
	}
	if (tvdbMatch) {
		const count = await applySourceMatch(animeId, rows, tvdbMatch);
		if (count > 0) {
			updated += count;
			sourcesUsed.push("thetvdb");
		}
	}

	if (rows.some((row) => isTitleMissing(row))) {
		let tmdbMatch: TitleSourceMatch | null = null;
		try {
			tmdbMatch = await fetchTmdbEpisodeTitles(context);
		} catch {
			tmdbMatch = null;
		}
		if (tmdbMatch) {
			const count = await applySourceMatch(animeId, rows, tmdbMatch);
			if (count > 0) {
				updated += count;
				sourcesUsed.push("tmdb");
			}
		}
	}

	return { updated, sourcesUsed };
}

export async function previewEpisodeTitleEnrichment(
	animeId: number | null,
	anilistData: ProviderAnimeData,
	options: {
		episodeRows?: EpisodeTitlePreviewRow[];
	} = {},
): Promise<EpisodeTitleEnrichmentPreview | null> {
	if (animeId === null && !options.episodeRows?.length) {
		return {
			possibleUpdates: 0,
			sourcesUsed: [],
			errors: [],
			episodeRowsSource: "database",
			skippedReason: "no-anime-id",
			matches: [],
		};
	}

	const rows =
		options.episodeRows && options.episodeRows.length > 0
			? toPreviewRows(options.episodeRows)
			: animeId === null
				? []
				: await loadEpisodeRows(animeId);
	const episodeRowsSource = options.episodeRows?.length
		? "provided"
		: "database";
	if (!rows.length) {
		return {
			possibleUpdates: 0,
			sourcesUsed: [],
			errors: [],
			episodeRowsSource,
			skippedReason: "no-episode-rows",
			matches: [],
		};
	}

	if (rows.every((row) => !isPreviewTitleMissing(row))) {
		return {
			possibleUpdates: 0,
			sourcesUsed: [],
			errors: [],
			episodeRowsSource,
			skippedReason: "no-missing-titles",
			matches: [],
		};
	}

	const context: EnrichmentContext = {
		animeId: animeId ?? 0,
		anilistData,
		episodes: rows,
	};
	const matches: EpisodeTitleEnrichmentPreview["matches"] = [];
	let possibleUpdates = 0;
	const sourcesUsed: Array<"thetvdb" | "tmdb"> = [];
	const errors: string[] = [];

	// Track which episode numbers TVDB would fill so TMDB doesn't double-count them.
	// Mirrors the sequential TVDB-first, TMDB-for-gaps logic in enrichEpisodeTitlesForAnime.
	const coveredByTvdb = new Set<number>();

	let tvdbMatch: TitleSourceMatch | null = null;
	try {
		tvdbMatch = await fetchTvdbEpisodeTitles(context);
	} catch (error) {
		errors.push(
			`thetvdb: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (tvdbMatch) {
		const matchedRows = tvdbMatch.episodes
			.map((ep) =>
				rows.find((r) => r.number === Number(ep.providerEpisodeNumber)),
			)
			.filter((r): r is EpisodeRow => r !== undefined && isTitleMissing(r));

		for (const row of matchedRows) coveredByTvdb.add(row.number);

		if (matchedRows.length > 0) {
			possibleUpdates += matchedRows.length;
			sourcesUsed.push("thetvdb");
			matches.push({
				provider: "thetvdb",
				seasonNumber: tvdbMatch.seasonNumber,
				episodeCount: tvdbMatch.episodes.length,
				sampleTitles: tvdbMatch.episodes
					.slice(0, 3)
					.map((episode) => episode.title),
			});
		}
	}

	// Only try TMDB if gaps remain after TVDB (same condition as real sync).
	const hasRemainingGaps = rows.some(
		(row) => isTitleMissing(row) && !coveredByTvdb.has(row.number),
	);
	if (hasRemainingGaps) {
		let tmdbMatch: TitleSourceMatch | null = null;
		try {
			tmdbMatch = await fetchTmdbEpisodeTitles(context);
		} catch (error) {
			errors.push(
				`tmdb: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (tmdbMatch) {
			const matchedRows = tmdbMatch.episodes
				.map((ep) =>
					rows.find((r) => r.number === Number(ep.providerEpisodeNumber)),
				)
				.filter(
					(r): r is EpisodeRow =>
						r !== undefined &&
						isTitleMissing(r) &&
						!coveredByTvdb.has(r.number),
				);

			if (matchedRows.length > 0) {
				possibleUpdates += matchedRows.length;
				sourcesUsed.push("tmdb");
				matches.push({
					provider: "tmdb",
					seasonNumber: tmdbMatch.seasonNumber,
					episodeCount: tmdbMatch.episodes.length,
					sampleTitles: tmdbMatch.episodes
						.slice(0, 3)
						.map((episode) => episode.title),
				});
			}
		}
	}

	return { possibleUpdates, sourcesUsed, errors, episodeRowsSource, matches };
}

export async function loadExistingAnimeSourceMapping(
	animeId: number,
	provider: "thetvdb" | "tmdb",
): Promise<{
	providerId: string;
	providerSlug: string | null;
	providerUrl: string | null;
} | null> {
	const [row] = await db
		.select({
			providerId: animeMappings.providerId,
			providerSlug: animeMappings.providerSlug,
			providerUrl: animeMappings.providerUrl,
		})
		.from(animeMappings)
		.where(
			and(
				eq(animeMappings.animeId, animeId),
				eq(animeMappings.provider, provider),
			),
		)
		.limit(1);

	return row ?? null;
}

export type { EnrichmentContext, EpisodeTitleMatch, TitleSourceMatch };
