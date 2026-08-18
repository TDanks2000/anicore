import { and, eq, ilike, or } from "drizzle-orm";

import { db } from "@anicore/db";
import { anime, animeMappings } from "@anicore/db/schema";
import { formatAnime } from "../modules/anime/anime.service";
import { isAdminAuthenticated } from "./admin-auth";
import { classifyPotentiallyMutatingAnimeRead } from "./public-anime-read-routing";

export type PublicAnimeReadResult =
	| { handled: false }
	| { handled: true; value: unknown };

/**
 * The legacy anime GET routes can import missing AniList data as a side effect.
 * Public requests are short-circuited through this database-only path so a GET
 * cannot trigger external traffic or mutate the database. Supplying a valid
 * admin token deliberately opts into the existing on-demand import behavior.
 */
export async function handlePublicAnimeRead(input: {
	method: string;
	requestUrl: string;
	headers: Record<string, string | undefined>;
}): Promise<PublicAnimeReadResult> {
	const read = classifyPotentiallyMutatingAnimeRead(
		input.method,
		input.requestUrl,
	);
	if (!read || isAdminAuthenticated(input.headers)) {
		return { handled: false };
	}

	if (read.kind === "search") {
		const pattern = `%${read.search}%`;
		const rows = await db
			.select()
			.from(anime)
			.where(
				or(
					ilike(anime.titleRomaji, pattern),
					ilike(anime.titleEnglish, pattern),
					ilike(anime.titleNative, pattern),
					ilike(anime.slug, pattern),
				),
			)
			.limit(read.limit);

		return { handled: true, value: rows.map(formatAnime) };
	}

	const rows = await db
		.select({
			anime,
			mapping: animeMappings,
		})
		.from(animeMappings)
		.innerJoin(anime, eq(animeMappings.animeId, anime.id))
		.where(
			and(
				eq(animeMappings.provider, "anilist"),
				eq(animeMappings.providerId, read.providerId),
			),
		)
		.limit(1);

	const row = rows[0];
	if (!row) return { handled: true, value: null };
	return {
		handled: true,
		value: { ...formatAnime(row.anime), mapping: row.mapping },
	};
}
