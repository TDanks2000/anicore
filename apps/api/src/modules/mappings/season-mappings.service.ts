import { db, readDb } from "@anicore/db";
import type { MappingSource, Provider } from "@anicore/db/enums";
import { seasonMappings } from "@anicore/db/provider-mapping-schema";
import { anime } from "@anicore/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { formatAnime } from "../anime/anime.format";
import { canonicalProviderId } from "./mappings.service";

interface SeasonMappingInput {
  animeId: number;
  provider: Provider;
  providerSeriesId: string;
  seasonNumber: number;
  partNumber?: number;
  confidence?: number;
  source?: MappingSource;
}

export function listAnimeSeasonMappings(animeId: number) {
  return readDb
    .select()
    .from(seasonMappings)
    .where(eq(seasonMappings.animeId, animeId))
    .orderBy(
      asc(seasonMappings.provider),
      asc(seasonMappings.providerSeriesId),
      asc(seasonMappings.seasonNumber),
      asc(seasonMappings.partNumber),
    );
}

export async function findSeasonMappings(
  provider: Provider,
  providerSeriesId: string,
  seasonNumber?: number,
) {
  const rows = await readDb
    .select({ mapping: seasonMappings, anime })
    .from(seasonMappings)
    .innerJoin(anime, eq(seasonMappings.animeId, anime.id))
    .where(
      and(
        eq(seasonMappings.provider, provider),
        eq(seasonMappings.providerSeriesId, canonicalProviderId(providerSeriesId)),
        seasonNumber === undefined ? undefined : eq(seasonMappings.seasonNumber, seasonNumber),
      ),
    )
    .orderBy(asc(seasonMappings.seasonNumber), asc(seasonMappings.partNumber));
  return rows.map((row) => ({ mapping: row.mapping, anime: formatAnime(row.anime) }));
}

async function saveSeasonMapping<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict("Season part is already mapped, or this anime already maps to that season");
    throw error;
  }
}

export function createSeasonMapping(input: SeasonMappingInput) {
  const providerSeriesId = canonicalProviderId(input.providerSeriesId);
  return saveSeasonMapping(() =>
    db.transaction(async (tx) => {
      const [parent] = await tx
        .select({ id: anime.id })
        .from(anime)
        .where(eq(anime.id, input.animeId));
      if (!parent) throw notFound("Anime not found");
      const [created] = await tx
        .insert(seasonMappings)
        .values({ ...input, providerSeriesId })
        .returning();
      return created!;
    }),
  );
}

export function updateSeasonMapping(
  id: number,
  patch: Partial<Pick<SeasonMappingInput, "seasonNumber" | "partNumber" | "confidence" | "source">>,
) {
  return saveSeasonMapping(async () => {
    const [updated] = await db
      .update(seasonMappings)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(seasonMappings.id, id))
      .returning();
    if (!updated) throw notFound("Season mapping not found");
    return updated;
  });
}

export async function deleteSeasonMapping(id: number) {
  const [deleted] = await db
    .delete(seasonMappings)
    .where(eq(seasonMappings.id, id))
    .returning({ id: seasonMappings.id });
  if (!deleted) throw notFound("Season mapping not found");
  return { deleted: true as const, id: deleted.id };
}
