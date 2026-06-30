import { and, eq, like, or } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { db } from "@anicore/db";
import {
  anime,
  animeExternalLinks,
  animeMappings,
  animeRelationLinks,
  episodes,
  type AnimeMapping,
} from "@anicore/db/schema";
import { withAnilistRetry } from "@anicore/providers/lib/anilist-rate-limit";
import { appendAnilistId } from "@anicore/providers/lib/cache";
import { toJsonArray } from "@anicore/providers/lib/json";
import { parseId, parseLimit } from "../../lib/params";
import { providerEnum, sourceEnum } from "../../lib/validators";
import { anilistClient } from "@anicore/providers/anilist/client";
import { syncAnilistAnime } from "@anicore/providers/anilist/sync";
import { formatAnime, getStudiosForAnime, getTagsForAnime } from "./anime.service";

type AnimeProvider = AnimeMapping["provider"];

async function findAnimeByProviderMapping(
	provider: AnimeProvider,
	providerId: string,
) {
	const rows = await db
		.select({
			anime,
			mapping: animeMappings,
		})
		.from(animeMappings)
		.innerJoin(anime, eq(animeMappings.animeId, anime.id))
		.where(
			and(
				eq(animeMappings.provider, provider),
				eq(animeMappings.providerId, providerId),
			),
		)
		.limit(1);

	return rows[0] ?? null;
}

async function getAnimeRowById(id: number) {
	const [row] = await db.select().from(anime).where(eq(anime.id, id)).limit(1);
	return row ?? null;
}

function parseAnilistId(providerId: string): number | null {
	const id = Number(providerId);
	return Number.isInteger(id) && id > 0 ? id : null;
}

function isUniqueConstraintError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return message.includes("unique") || message.includes("duplicate key");
}

const activeAnilistSyncs = new Map<
	number,
	Promise<Awaited<ReturnType<typeof getAnimeRowById>>>
>();

async function runAnilistSync(id: number) {
	try {
		const result = await withAnilistRetry(() => syncAnilistAnime(id));
		return getAnimeRowById(result.animeId);
	} catch (err) {
		if (isUniqueConstraintError(err)) {
			const existing = await findAnimeByProviderMapping("anilist", String(id));
			if (existing) return existing.anime;
		}

		throw err;
	}
}

async function syncMissingAnilistAnime(id: number) {
	appendAnilistId(id);

	const active = activeAnilistSyncs.get(id);
	if (active) return active;

	const sync = runAnilistSync(id).finally(() => {
		activeAnilistSyncs.delete(id);
	});
	activeAnilistSyncs.set(id, sync);
	return sync;
}

export const animeRoutes = new Elysia({ prefix: "/anime" })
	.get(
		"/",
		async ({ query, set }) => {
			const limit = parseLimit(query.limit);
			const search = query.q?.trim();

			if (!search) {
				const rows = await db.select().from(anime).limit(limit);
				return rows.map(formatAnime);
			}

			const pattern = `%${search}%`;

			const rows = await db
				.select()
				.from(anime)
				.where(
					or(
						like(anime.titleRomaji, pattern),
						like(anime.titleEnglish, pattern),
						like(anime.titleNative, pattern),
						like(anime.slug, pattern),
					),
				)
				.limit(limit);

			if (rows.length > 0) {
				return rows.map(formatAnime);
			}

			try {
				const result = await withAnilistRetry(() =>
					anilistClient.anime.getAnimeBySearch(search, 1, 1),
				);
				const match = result.Page?.media?.[0];
				if (!match?.id) return [];

				const synced = await syncMissingAnilistAnime(match.id);
				return synced ? [formatAnime(synced)] : [];
			} catch (err) {
				set.status = 502;
				return {
					error: "Failed to sync missing anime from AniList",
					message: err instanceof Error ? err.message : String(err),
				};
			}
		},
		{
			query: t.Object({
				q: t.Optional(t.String()),
				limit: t.Optional(t.String()),
			}),
		},
	)

	.post(
		"/",
		async ({ body, set }) => {
			try {
				const created = await db.transaction(async (tx) => {
					const [row] = await tx
						.insert(anime)
						.values({
							slug: body.slug,
							titleRomaji: body.titleRomaji,
							titleEnglish: body.titleEnglish,
							titleNative: body.titleNative,
							titleUserPreferred: body.titleUserPreferred,
							description: body.description,
							format: body.format,
							status: body.status,
							source: body.source,
							season: body.season,
							seasonYear: body.seasonYear,
							startDate: body.startDate,
							endDate: body.endDate,
							episodeCount: body.episodeCount,
							durationMinutes: body.durationMinutes,
							countryOfOrigin: body.countryOfOrigin,
							isAdult: body.isAdult ?? false,
							genresJson: toJsonArray(body.genres),
							synonymsJson: toJsonArray(body.synonyms),
							averageScore: body.averageScore,
							meanScore: body.meanScore,
							popularity: body.popularity,
							favourites: body.favourites,
							trending: body.trending,
							coverImage: body.coverImage,
							coverImageColor: body.coverImageColor,
							bannerImage: body.bannerImage,
							trailerVideoId: body.trailerVideoId,
							trailerSite: body.trailerSite,
							trailerThumbnail: body.trailerThumbnail,
							nextEpisodeNumber: body.nextEpisodeNumber,
							nextEpisodeAirsAt: body.nextEpisodeAirsAt,
							hashtag: body.hashtag,
						})
						.returning();

					if (!row) throw new Error("insert returned no row");

					if (body.mappings?.length) {
						await tx.insert(animeMappings).values(
							body.mappings.map((mapping) => ({
								animeId: row.id,
								provider: mapping.provider,
								providerId: mapping.providerId,
								providerSlug: mapping.providerSlug,
								providerUrl: mapping.providerUrl,
								confidence: mapping.confidence ?? 100,
								source: mapping.source ?? "manual",
								isPrimary: mapping.isPrimary ?? false,
							})),
						);
					}

					return row;
				});

				return formatAnime(created);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("anime_slug_idx") || msg.includes("unique")) {
					set.status = 409;
					return { error: "Slug or mapping already exists" };
				}
				set.status = 500;
				return { error: "Failed to create anime" };
			}
		},
		{
			body: t.Object({
				slug: t.Optional(t.String()),

				titleRomaji: t.String(),
				titleEnglish: t.Optional(t.String()),
				titleNative: t.Optional(t.String()),
				titleUserPreferred: t.Optional(t.String()),

				description: t.Optional(t.String()),

				format: t.Optional(t.String()),
				status: t.Optional(t.String()),
				source: t.Optional(t.String()),

				season: t.Optional(t.String()),
				seasonYear: t.Optional(t.Number()),
				startDate: t.Optional(t.String()),
				endDate: t.Optional(t.String()),

				episodeCount: t.Optional(t.Number()),
				durationMinutes: t.Optional(t.Number()),

				countryOfOrigin: t.Optional(t.String()),
				isAdult: t.Optional(t.Boolean()),

				genres: t.Optional(t.Array(t.String())),
				synonyms: t.Optional(t.Array(t.String())),

				averageScore: t.Optional(t.Number()),
				meanScore: t.Optional(t.Number()),
				popularity: t.Optional(t.Number()),
				favourites: t.Optional(t.Number()),
				trending: t.Optional(t.Number()),

				coverImage: t.Optional(t.String()),
				coverImageColor: t.Optional(t.String()),
				bannerImage: t.Optional(t.String()),

				trailerVideoId: t.Optional(t.String()),
				trailerSite: t.Optional(t.String()),
				trailerThumbnail: t.Optional(t.String()),

				nextEpisodeNumber: t.Optional(t.Number()),
				nextEpisodeAirsAt: t.Optional(t.Number()),

				hashtag: t.Optional(t.String()),

				mappings: t.Optional(
					t.Array(
						t.Object({
							provider: providerEnum,
							providerId: t.String(),
							providerSlug: t.Optional(t.String()),
							providerUrl: t.Optional(t.String()),
							confidence: t.Optional(t.Number()),
							source: t.Optional(sourceEnum),
							isPrimary: t.Optional(t.Boolean()),
						}),
					),
				),
			}),
		},
	)

	.get(
		"/by/:provider/:providerId",
		async ({ params, set }) => {
			const existing = await findAnimeByProviderMapping(
				params.provider,
				params.providerId,
			);

			let row = existing;
			if (!row && params.provider === "anilist") {
				const anilistId = parseAnilistId(params.providerId);
				if (!anilistId) return null;

				try {
					await syncMissingAnilistAnime(anilistId);
					row = await findAnimeByProviderMapping(
						params.provider,
						params.providerId,
					);
				} catch (err) {
					set.status = 502;
					return {
						error: "Failed to sync missing anime from AniList",
						message: err instanceof Error ? err.message : String(err),
					};
				}
			}

			if (!row) return null;
			const { anime: animeRow, mapping } = row;
			return { ...formatAnime(animeRow), mapping };
		},
		{
			params: t.Object({
				provider: providerEnum,
				providerId: t.String(),
			}),
		},
	)

	.get("/:id/full", async ({ params, set }) => {
		const id = parseId(params.id);

		if (!id) {
			set.status = 400;
			return { error: "Invalid anime id" };
		}

		const [row] = await db
			.select()
			.from(anime)
			.where(eq(anime.id, id))
			.limit(1);

		if (!row) {
			set.status = 404;
			return { error: "Anime not found" };
		}

		const [mappings, episodeRows, studios, tags, externalLinks, relations] =
			await Promise.all([
				db.select().from(animeMappings).where(eq(animeMappings.animeId, id)),
				db.select().from(episodes).where(eq(episodes.animeId, id)),
				getStudiosForAnime(id),
				getTagsForAnime(id),
				db
					.select()
					.from(animeExternalLinks)
					.where(eq(animeExternalLinks.animeId, id)),
				db
					.select()
					.from(animeRelationLinks)
					.where(eq(animeRelationLinks.animeId, id)),
			]);

		return {
			...formatAnime(row),
			mappings,
			episodes: episodeRows,
			studios,
			tags,
			externalLinks,
			relations,
		};
	})

	.get("/:id", async ({ params, set }) => {
		const id = parseId(params.id);

		if (!id) {
			set.status = 400;
			return { error: "Invalid anime id" };
		}

		const [row] = await db.select().from(anime).where(eq(anime.id, id)).limit(1);

		if (!row) {
			set.status = 404;
			return { error: "Anime not found" };
		}

		return formatAnime(row);
	})

	.get("/:id/mappings", async ({ params, set }) => {
		const animeId = parseId(params.id);

		if (!animeId) {
			set.status = 400;
			return { error: "Invalid anime id" };
		}

		return db
			.select()
			.from(animeMappings)
			.where(eq(animeMappings.animeId, animeId));
	})

	.get("/:id/episodes", async ({ params, set }) => {
		const animeId = parseId(params.id);

		if (!animeId) {
			set.status = 400;
			return { error: "Invalid anime id" };
		}

		return db.select().from(episodes).where(eq(episodes.animeId, animeId));
	})

	.get("/:id/studios", async ({ params, set }) => {
		const animeId = parseId(params.id);

		if (!animeId) {
			set.status = 400;
			return { error: "Invalid anime id" };
		}

		return getStudiosForAnime(animeId);
	})

	.get("/:id/tags", async ({ params, set }) => {
		const animeId = parseId(params.id);

		if (!animeId) {
			set.status = 400;
			return { error: "Invalid anime id" };
		}

		return getTagsForAnime(animeId);
	})

	.get("/:id/external-links", async ({ params, set }) => {
		const animeId = parseId(params.id);

		if (!animeId) {
			set.status = 400;
			return { error: "Invalid anime id" };
		}

		return db
			.select()
			.from(animeExternalLinks)
			.where(eq(animeExternalLinks.animeId, animeId));
	})

	.get("/:id/relations", async ({ params, set }) => {
		const animeId = parseId(params.id);

		if (!animeId) {
			set.status = 400;
			return { error: "Invalid anime id" };
		}

		return db
			.select()
			.from(animeRelationLinks)
			.where(eq(animeRelationLinks.animeId, animeId));
	});
