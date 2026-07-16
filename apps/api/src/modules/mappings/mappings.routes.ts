import { and, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { db } from "@anicore/db";
import {
	anime,
	animeMappings,
	episodeMappings,
	episodes,
} from "@anicore/db/schema";
import {
	confidenceValue,
	positiveInteger,
	providerEnum,
	sourceEnum,
} from "../../lib/validators";

function isUniqueConstraintError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("unique") || message.includes("duplicate key");
}

export const mappingRoutes = new Elysia({ prefix: "/mappings" })
	.get(
		"/anime/:provider/:providerId",
		async ({ params }) => {
			const rows = await db
				.select({
					mapping: animeMappings,
					anime,
				})
				.from(animeMappings)
				.innerJoin(anime, eq(animeMappings.animeId, anime.id))
				.where(
					and(
						eq(animeMappings.provider, params.provider),
						eq(animeMappings.providerId, params.providerId),
					),
				)
				.limit(1);

			return rows[0] ?? null;
		},
		{
			params: t.Object({
				provider: providerEnum,
				providerId: t.String(),
			}),
		},
	)

	.post(
		"/anime",
		async ({ body, set }) => {
			const [parent] = await db
				.select({ id: anime.id })
				.from(anime)
				.where(eq(anime.id, body.animeId))
				.limit(1);
			if (!parent) {
				set.status = 404;
				return { error: "Anime not found" };
			}

			try {
				const [created] = await db
					.insert(animeMappings)
					.values({
						animeId: body.animeId,
						provider: body.provider,
						providerId: body.providerId,
						providerSlug: body.providerSlug,
						providerUrl: body.providerUrl,
						confidence: body.confidence ?? 100,
						source: body.source ?? "manual",
						isPrimary: body.isPrimary ?? false,
					})
					.returning();

				return created;
			} catch (error) {
				if (!isUniqueConstraintError(error)) throw error;
				set.status = 409;
				return { error: "Anime mapping already exists" };
			}
		},
		{
			body: t.Object({
				animeId: positiveInteger,
				provider: providerEnum,
				providerId: t.String({ minLength: 1 }),
				providerSlug: t.Optional(t.String()),
				providerUrl: t.Optional(t.String()),
				confidence: t.Optional(confidenceValue),
				source: t.Optional(sourceEnum),
				isPrimary: t.Optional(t.Boolean()),
			}),
		},
	)

	.get(
		"/episode/:provider/:providerId",
		async ({ params }) => {
			const rows = await db
				.select({
					mapping: episodeMappings,
					episode: episodes,
				})
				.from(episodeMappings)
				.innerJoin(episodes, eq(episodeMappings.episodeId, episodes.id))
				.where(
					and(
						eq(episodeMappings.provider, params.provider),
						eq(episodeMappings.providerId, params.providerId),
					),
				)
				.limit(1);

			return rows[0] ?? null;
		},
		{
			params: t.Object({
				provider: providerEnum,
				providerId: t.String(),
			}),
		},
	)

	.post(
		"/episode",
		async ({ body, set }) => {
			const [parent] = await db
				.select({ id: episodes.id })
				.from(episodes)
				.where(eq(episodes.id, body.episodeId))
				.limit(1);
			if (!parent) {
				set.status = 404;
				return { error: "Episode not found" };
			}

			try {
				const [created] = await db
					.insert(episodeMappings)
					.values({
						episodeId: body.episodeId,
						provider: body.provider,
						providerId: body.providerId,
						providerSlug: body.providerSlug,
						providerUrl: body.providerUrl,
						providerEpisodeNumber: body.providerEpisodeNumber,
						confidence: body.confidence ?? 100,
						source: body.source ?? "manual",
					})
					.returning();

				return created;
			} catch (error) {
				if (!isUniqueConstraintError(error)) throw error;
				set.status = 409;
				return { error: "Episode mapping already exists" };
			}
		},
		{
			body: t.Object({
				episodeId: positiveInteger,
				provider: providerEnum,
				providerId: t.String({ minLength: 1 }),
				providerSlug: t.Optional(t.String()),
				providerUrl: t.Optional(t.String()),
				providerEpisodeNumber: t.Optional(t.String()),
				confidence: t.Optional(confidenceValue),
				source: t.Optional(sourceEnum),
			}),
		},
	);
