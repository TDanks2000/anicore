import { eq } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { db } from "../../db";
import { episodeAudioStatus, episodeMappings, episodes } from "../../db/schema";
import { parseId, parseLimit } from "../../lib/params";
import { audioModeEnum, audioStatusEnum, episodeKindEnum, providerEnum, sourceEnum } from "../../lib/validators";

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

					if (body.audioStatuses?.length) {
						await tx.insert(episodeAudioStatus).values(
							body.audioStatuses.map((status) => ({
								episodeId: row.id,
								audioMode: status.audioMode,
								locale: status.locale ?? "en",
								status: status.status ?? "unknown",
								sourceProvider: status.sourceProvider ?? "manual",
								notes: status.notes,
							})),
						);
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

		const [mappings, audioStatuses] = await Promise.all([
			db
				.select()
				.from(episodeMappings)
				.where(eq(episodeMappings.episodeId, id)),
			db
				.select()
				.from(episodeAudioStatus)
				.where(eq(episodeAudioStatus.episodeId, id)),
		]);

		return {
			...episode,
			mappings,
			audioStatuses,
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

		return db
			.select()
			.from(episodeAudioStatus)
			.where(eq(episodeAudioStatus.episodeId, episodeId));
	})

	.post(
		"/:id/audio",
		async ({ params, body, set }) => {
			const episodeId = parseId(params.id);

			if (!episodeId) {
				set.status = 400;
				return { error: "Invalid episode id" };
			}

			const [exists] = await db
				.select({ id: episodes.id })
				.from(episodes)
				.where(eq(episodes.id, episodeId))
				.limit(1);

			if (!exists) {
				set.status = 404;
				return { error: "Episode not found" };
			}

			const [created] = await db
				.insert(episodeAudioStatus)
				.values({
					episodeId,
					audioMode: body.audioMode,
					locale: body.locale ?? "en",
					status: body.status ?? "unknown",
					sourceProvider: body.sourceProvider ?? "manual",
					notes: body.notes,
				})
				.returning();

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
