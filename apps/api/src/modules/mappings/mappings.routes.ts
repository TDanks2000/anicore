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
	providerIdValue,
	sourceEnum,
} from "../../lib/validators";

class MappingRuleError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404 | 409,
	) {
		super(message);
	}
}

export function canonicalProviderId(value: string): string {
	return value.trim();
}

function isUniqueConstraintError(error: unknown): boolean {
	const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
	return message.includes("unique") || message.includes("duplicate key");
}

function handleMappingError(error: unknown, set: { status?: number | string }) {
	if (error instanceof MappingRuleError) {
		set.status = error.status;
		return { error: error.message };
	}
	if (isUniqueConstraintError(error)) {
		set.status = 409;
		return { error: "Mapping already exists or belongs to another record" };
	}
	throw error;
}

export const mappingRoutes = new Elysia({ prefix: "/mappings" })
	.get(
		"/anime/:provider/:providerId",
		async ({ params }) => {
			const providerId = canonicalProviderId(params.providerId);
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
						eq(animeMappings.providerId, providerId),
					),
				)
				.limit(1);

			return rows[0] ?? null;
		},
		{
			params: t.Object({
				provider: providerEnum,
				providerId: providerIdValue,
			}),
		},
	)

	.post(
		"/anime",
		async ({ body, set }) => {
			try {
				const providerId = canonicalProviderId(body.providerId);
				return await db.transaction(async (tx) => {
					const [parent] = await tx
						.select({ id: anime.id })
						.from(anime)
						.where(eq(anime.id, body.animeId))
						.limit(1);
					if (!parent) {
						throw new MappingRuleError("Anime not found", 404);
					}

					const existingForProvider = await tx
						.select({
							id: animeMappings.id,
							isPrimary: animeMappings.isPrimary,
						})
						.from(animeMappings)
						.where(
							and(
								eq(animeMappings.animeId, body.animeId),
								eq(animeMappings.provider, body.provider),
							),
						);

					if (body.isPrimary) {
						await tx
							.update(animeMappings)
							.set({ isPrimary: false, updatedAt: new Date() })
							.where(
								and(
									eq(animeMappings.animeId, body.animeId),
									eq(animeMappings.provider, body.provider),
								),
							);
					} else if (
						existingForProvider.length > 0 &&
						!existingForProvider.some((mapping) => mapping.isPrimary)
					) {
						throw new MappingRuleError(
							"Adding another mapping for this provider would be ambiguous; mark one mapping as primary",
							409,
						);
					}

					const [created] = await tx
						.insert(animeMappings)
						.values({
							animeId: body.animeId,
							provider: body.provider,
							providerId,
							providerSlug: body.providerSlug?.trim() || null,
							providerUrl: body.providerUrl?.trim() || null,
							confidence: body.confidence ?? 100,
							source: body.source ?? "manual",
							isPrimary: body.isPrimary ?? false,
						})
						.returning();

					if (!created) throw new Error("anime mapping insert returned no row");
					return created;
				});
			} catch (error) {
				return handleMappingError(error, set);
			}
		},
		{
			body: t.Object({
				animeId: positiveInteger,
				provider: providerEnum,
				providerId: providerIdValue,
				providerSlug: t.Optional(t.String()),
				providerUrl: t.Optional(t.String()),
				confidence: t.Optional(confidenceValue),
				source: t.Optional(sourceEnum),
				isPrimary: t.Optional(t.Boolean()),
			}),
		},
	)

	.patch(
		"/anime/:provider/:providerId",
		async ({ params, body, set }) => {
			try {
				const providerId = canonicalProviderId(params.providerId);
				return await db.transaction(async (tx) => {
					const [mapping] = await tx
						.select()
						.from(animeMappings)
						.where(
							and(
								eq(animeMappings.provider, params.provider),
								eq(animeMappings.providerId, providerId),
							),
						)
						.limit(1);
					if (!mapping) throw new MappingRuleError("Anime mapping not found", 404);

					if (body.isPrimary === true) {
						await tx
							.update(animeMappings)
							.set({ isPrimary: false, updatedAt: new Date() })
							.where(
								and(
									eq(animeMappings.animeId, mapping.animeId),
									eq(animeMappings.provider, mapping.provider),
								),
							);
					} else if (body.isPrimary === false && mapping.isPrimary) {
						const others = await tx
							.select({ id: animeMappings.id })
							.from(animeMappings)
							.where(
								and(
									eq(animeMappings.animeId, mapping.animeId),
									eq(animeMappings.provider, mapping.provider),
								),
							);
						if (others.length > 1) {
							throw new MappingRuleError(
								"Promote another mapping before clearing the primary mapping",
								409,
							);
						}
					}

					const [updated] = await tx
						.update(animeMappings)
						.set({
							providerSlug:
								body.providerSlug === undefined
									? undefined
									: body.providerSlug.trim() || null,
							providerUrl:
								body.providerUrl === undefined
									? undefined
									: body.providerUrl.trim() || null,
							confidence: body.confidence,
							source: body.source,
							isPrimary: body.isPrimary,
							updatedAt: new Date(),
						})
						.where(eq(animeMappings.id, mapping.id))
						.returning();

					if (!updated) throw new Error("anime mapping update returned no row");
					return updated;
				});
			} catch (error) {
				return handleMappingError(error, set);
			}
		},
		{
			params: t.Object({
				provider: providerEnum,
				providerId: providerIdValue,
			}),
			body: t.Object({
				providerSlug: t.Optional(t.String()),
				providerUrl: t.Optional(t.String()),
				confidence: t.Optional(confidenceValue),
				source: t.Optional(sourceEnum),
				isPrimary: t.Optional(t.Boolean()),
			}),
		},
	)

	.delete(
		"/anime/:provider/:providerId",
		async ({ params, set }) => {
			try {
				const providerId = canonicalProviderId(params.providerId);
				return await db.transaction(async (tx) => {
					const [mapping] = await tx
						.select()
						.from(animeMappings)
						.where(
							and(
								eq(animeMappings.provider, params.provider),
								eq(animeMappings.providerId, providerId),
							),
						)
						.limit(1);
					if (!mapping) throw new MappingRuleError("Anime mapping not found", 404);

					const [episodeDependency] = await tx
						.select({ id: episodeMappings.id })
						.from(episodeMappings)
						.innerJoin(episodes, eq(episodeMappings.episodeId, episodes.id))
						.where(
							and(
								eq(episodes.animeId, mapping.animeId),
								eq(episodeMappings.provider, mapping.provider),
							),
						)
						.limit(1);
					if (episodeDependency) {
						throw new MappingRuleError(
							"Cannot delete anime mapping while episode mappings for this provider still exist",
							409,
						);
					}

					if (mapping.isPrimary) {
						const others = await tx
							.select({ id: animeMappings.id })
							.from(animeMappings)
							.where(
								and(
									eq(animeMappings.animeId, mapping.animeId),
									eq(animeMappings.provider, mapping.provider),
								),
							);
						if (others.length > 1) {
							throw new MappingRuleError(
								"Promote another mapping before deleting the primary mapping",
								409,
							);
						}
					}

					await tx.delete(animeMappings).where(eq(animeMappings.id, mapping.id));
					return { deleted: true, id: mapping.id };
				});
			} catch (error) {
				return handleMappingError(error, set);
			}
		},
		{
			params: t.Object({
				provider: providerEnum,
				providerId: providerIdValue,
			}),
		},
	)

	.get(
		"/episode/:provider/:providerId",
		async ({ params }) => {
			const providerId = canonicalProviderId(params.providerId);
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
						eq(episodeMappings.providerId, providerId),
					),
				)
				.limit(1);

			return rows[0] ?? null;
		},
		{
			params: t.Object({
				provider: providerEnum,
				providerId: providerIdValue,
			}),
		},
	)

	.post(
		"/episode",
		async ({ body, set }) => {
			try {
				const providerId = canonicalProviderId(body.providerId);
				return await db.transaction(async (tx) => {
					const [parent] = await tx
						.select({ id: episodes.id })
						.from(episodes)
						.where(eq(episodes.id, body.episodeId))
						.limit(1);
					if (!parent) throw new MappingRuleError("Episode not found", 404);

					const [created] = await tx
						.insert(episodeMappings)
						.values({
							episodeId: body.episodeId,
							provider: body.provider,
							providerId,
							providerSlug: body.providerSlug?.trim() || null,
							providerUrl: body.providerUrl?.trim() || null,
							providerEpisodeNumber:
								body.providerEpisodeNumber?.trim() || null,
							confidence: body.confidence ?? 100,
							source: body.source ?? "manual",
						})
						.returning();

					if (!created) throw new Error("episode mapping insert returned no row");
					return created;
				});
			} catch (error) {
				return handleMappingError(error, set);
			}
		},
		{
			body: t.Object({
				episodeId: positiveInteger,
				provider: providerEnum,
				providerId: providerIdValue,
				providerSlug: t.Optional(t.String()),
				providerUrl: t.Optional(t.String()),
				providerEpisodeNumber: t.Optional(t.String()),
				confidence: t.Optional(confidenceValue),
				source: t.Optional(sourceEnum),
			}),
		},
	)

	.patch(
		"/episode/:provider/:providerId",
		async ({ params, body, set }) => {
			try {
				const providerId = canonicalProviderId(params.providerId);
				const [updated] = await db
					.update(episodeMappings)
					.set({
						providerSlug:
							body.providerSlug === undefined
								? undefined
								: body.providerSlug.trim() || null,
						providerUrl:
							body.providerUrl === undefined
								? undefined
								: body.providerUrl.trim() || null,
						providerEpisodeNumber:
							body.providerEpisodeNumber === undefined
								? undefined
								: body.providerEpisodeNumber.trim() || null,
						confidence: body.confidence,
						source: body.source,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(episodeMappings.provider, params.provider),
							eq(episodeMappings.providerId, providerId),
						),
					)
					.returning();

				if (!updated) throw new MappingRuleError("Episode mapping not found", 404);
				return updated;
			} catch (error) {
				return handleMappingError(error, set);
			}
		},
		{
			params: t.Object({
				provider: providerEnum,
				providerId: providerIdValue,
			}),
			body: t.Object({
				providerSlug: t.Optional(t.String()),
				providerUrl: t.Optional(t.String()),
				providerEpisodeNumber: t.Optional(t.String()),
				confidence: t.Optional(confidenceValue),
				source: t.Optional(sourceEnum),
			}),
		},
	)

	.delete(
		"/episode/:provider/:providerId",
		async ({ params, set }) => {
			const providerId = canonicalProviderId(params.providerId);
			const [deleted] = await db
				.delete(episodeMappings)
				.where(
					and(
						eq(episodeMappings.provider, params.provider),
						eq(episodeMappings.providerId, providerId),
					),
				)
				.returning({ id: episodeMappings.id });

			if (!deleted) {
				set.status = 404;
				return { error: "Episode mapping not found" };
			}
			return { deleted: true, id: deleted.id };
		},
		{
			params: t.Object({
				provider: providerEnum,
				providerId: providerIdValue,
			}),
		},
	);
