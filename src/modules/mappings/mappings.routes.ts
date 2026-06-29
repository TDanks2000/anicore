import { and, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { db } from "../../db";
import {
	anime,
	animeMappings,
	episodeMappings,
	episodes,
} from "../../db/schema";
import { providerEnum, sourceEnum } from "../../lib/validators";

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
			if (body.animeId <= 0) {
				set.status = 400;
				return { error: "Invalid anime id" };
			}

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
		},
		{
			body: t.Object({
				animeId: t.Integer(),
				provider: providerEnum,
				providerId: t.String(),
				providerSlug: t.Optional(t.String()),
				providerUrl: t.Optional(t.String()),
				confidence: t.Optional(t.Number()),
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
			if (body.episodeId <= 0) {
				set.status = 400;
				return { error: "Invalid episode id" };
			}

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
		},
		{
			body: t.Object({
				episodeId: t.Integer(),
				provider: providerEnum,
				providerId: t.String(),
				providerSlug: t.Optional(t.String()),
				providerUrl: t.Optional(t.String()),
				providerEpisodeNumber: t.Optional(t.String()),
				confidence: t.Optional(t.Number()),
				source: t.Optional(sourceEnum),
			}),
		},
	);
