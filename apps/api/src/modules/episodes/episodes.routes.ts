import { and, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { db } from "@anicore/db";
import { episodeLanguageStatus, episodeMappings, episodes } from "@anicore/db/schema";
import { parseId, parseLimit } from "../../lib/params";
import {
	audioModeEnum,
	audioStatusEnum,
	episodeKindEnum,
	episodeLanguageStatusEnum,
	languageMediaTypeEnum,
	providerEnum,
	sourceEnum,
} from "../../lib/validators";
import {
	getEpisodeLanguageStatusesForEpisode,
	upsertLegacyEpisodeAudioStatus,
} from "../language-status/language-status.service";
import {
	mapLegacyAudioStatusToEpisodeStatus,
	normalizeLanguageCode,
	toLegacyEpisodeAudioResponse,
} from "../language-status/language-status.scoring";

export const episodeRoutes = new Elysia({ prefix: "/episodes" })
	.get(
		"/",
		async ({ query }) => {
			const limit = parseLimit(query.limit);

			return db.select().from(episodes).limit(limit);
		},
		{
			query: t.Object({
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
						.insert(episodes)
						.values({
							animeId: body.animeId,
							number: body.number,
							displayNumber: body.displayNumber ?? String(body.number),
							sortNumber: body.sortNumber ?? body.number,
							seasonNumber: body.seasonNumber,
							absoluteNumber: body.absoluteNumber,
							title: body.title,
							titleRomaji: body.titleRomaji,
							titleEnglish: body.titleEnglish,
							titleNative: body.titleNative,
							synopsis: body.synopsis,
							airDate: body.airDate,
							thumbnail: body.thumbnail,
							lengthMinutes: body.lengthMinutes,
							kind: body.kind ?? "normal",
						})
						.returning();

					if (!row) throw new Error("insert returned no row");

					if (body.mappings?.length) {
						await tx.insert(episodeMappings).values(
							body.mappings.map((mapping) => ({
								episodeId: row.id,
								provider: mapping.provider,
								providerId: mapping.providerId,
								providerSlug: mapping.providerSlug,
								providerUrl: mapping.providerUrl,
								providerEpisodeNumber: mapping.providerEpisodeNumber,
								confidence: mapping.confidence ?? 100,
								source: mapping.source ?? "manual",
							})),
						);
					}

					const languageStatuses = [
						...(body.languageStatuses ?? []).map((status) => ({
							animeId: row.animeId,
							episodeNumber: row.number,
							languageCode: normalizeLanguageCode(status.languageCode),
							mediaType: status.mediaType,
							status: status.status ?? "unknown",
							provider: status.provider ?? "manual",
							confidence: status.confidence ?? 75,
						})),
						...(body.audioStatuses ?? []).map((status) => ({
							animeId: row.animeId,
							episodeNumber: row.number,
							languageCode: normalizeLanguageCode(
								status.locale ?? (status.audioMode === "original" ? "ja" : "en"),
							),
							mediaType: "audio" as const,
							status: mapLegacyAudioStatusToEpisodeStatus(
								status.status ?? "unknown",
							),
							provider: status.sourceProvider ?? "manual",
							confidence: status.sourceProvider === "manual" ? 100 : 75,
						})),
					];

					if (languageStatuses.length) {
						await tx.insert(episodeLanguageStatus).values(languageStatuses);
					}

					return row;
				});

				return created;
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("unique") || msg.includes("duplicate")) {
					set.status = 409;
					return { error: "Episode or mapping already exists" };
				}
				set.status = 500;
				return { error: "Failed to create episode" };
			}
		},
		{
			body: t.Object({
				animeId: t.Number(),
				number: t.Number(),
				displayNumber: t.Optional(t.String()),
				sortNumber: t.Optional(t.Number()),

				seasonNumber: t.Optional(t.Number()),
				absoluteNumber: t.Optional(t.Number()),

				title: t.Optional(t.String()),
				titleRomaji: t.Optional(t.String()),
				titleEnglish: t.Optional(t.String()),
				titleNative: t.Optional(t.String()),

				synopsis: t.Optional(t.String()),

				airDate: t.Optional(t.String()),
				thumbnail: t.Optional(t.String()),

				lengthMinutes: t.Optional(t.Number()),

				kind: t.Optional(episodeKindEnum),

				mappings: t.Optional(
					t.Array(
						t.Object({
							provider: providerEnum,
							providerId: t.String(),
							providerSlug: t.Optional(t.String()),
							providerUrl: t.Optional(t.String()),
							providerEpisodeNumber: t.Optional(t.String()),
							confidence: t.Optional(t.Number()),
							source: t.Optional(sourceEnum),
						}),
					),
				),

				audioStatuses: t.Optional(
					t.Array(
						t.Object({
							audioMode: audioModeEnum,
							locale: t.Optional(t.String()),
							status: t.Optional(audioStatusEnum),
							sourceProvider: t.Optional(t.String()),
							notes: t.Optional(t.String()),
						}),
					),
				),

				languageStatuses: t.Optional(
					t.Array(
						t.Object({
							languageCode: t.String(),
							mediaType: languageMediaTypeEnum,
							status: t.Optional(episodeLanguageStatusEnum),
							provider: t.Optional(t.String()),
							confidence: t.Optional(t.Number()),
						}),
					),
				),
			}),
		},
	)

	.get("/:id/full", async ({ params, set }) => {
		const id = parseId(params.id);

		if (!id) {
			set.status = 400;
			return { error: "Invalid episode id" };
		}

		const [episode] = await db
			.select()
			.from(episodes)
			.where(eq(episodes.id, id))
			.limit(1);

		if (!episode) {
			set.status = 404;
			return { error: "Episode not found" };
		}

		const [mappings, languageStatuses] = await Promise.all([
			db
				.select()
				.from(episodeMappings)
				.where(eq(episodeMappings.episodeId, id)),
			db
				.select()
				.from(episodeLanguageStatus)
				.where(
					and(
						eq(episodeLanguageStatus.animeId, episode.animeId),
						eq(episodeLanguageStatus.episodeNumber, episode.number),
					),
				),
		]);

		return {
			...episode,
			mappings,
			languageStatuses,
			audioStatuses: toLegacyEpisodeAudioResponse(episode, languageStatuses),
		};
	})

	.get("/:id", async ({ params, set }) => {
		const id = parseId(params.id);

		if (!id) {
			set.status = 400;
			return { error: "Invalid episode id" };
		}

		const [row] = await db
			.select()
			.from(episodes)
			.where(eq(episodes.id, id))
			.limit(1);

		if (!row) {
			set.status = 404;
			return { error: "Episode not found" };
		}

		return row;
	})

	.get("/:id/mappings", async ({ params, set }) => {
		const episodeId = parseId(params.id);

		if (!episodeId) {
			set.status = 400;
			return { error: "Invalid episode id" };
		}

		return db
			.select()
			.from(episodeMappings)
			.where(eq(episodeMappings.episodeId, episodeId));
	})

	.get("/:id/audio", async ({ params, set }) => {
		const episodeId = parseId(params.id);

		if (!episodeId) {
			set.status = 400;
			return { error: "Invalid episode id" };
		}

		const result = await getEpisodeLanguageStatusesForEpisode(episodeId);
		if (!result) {
			set.status = 404;
			return { error: "Episode not found" };
		}

		return toLegacyEpisodeAudioResponse(result.episode, result.rows);
	})

	.post(
		"/:id/audio",
		async ({ params, body, set }) => {
			const episodeId = parseId(params.id);

			if (!episodeId) {
				set.status = 400;
				return { error: "Invalid episode id" };
			}

			const created = await upsertLegacyEpisodeAudioStatus({
				episodeId,
				audioMode: body.audioMode,
				locale: body.locale,
				status: body.status,
				sourceProvider: body.sourceProvider,
			});

			if (!created) {
				set.status = 404;
				return { error: "Episode not found" };
			}

			return created;
		},
		{
			body: t.Object({
				audioMode: audioModeEnum,
				locale: t.Optional(t.String()),
				status: t.Optional(audioStatusEnum),
				sourceProvider: t.Optional(t.String()),
				notes: t.Optional(t.String()),
			}),
		},
	);
