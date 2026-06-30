import { asc, eq } from "drizzle-orm";

import { db } from "../../db";
import {
  animeStudioLinks,
  animeTagLinks,
  studios,
  tags,
  type Anime,
} from "../../db/schema";
import { fromJsonArray } from "../../lib/json";

export function formatAnime(row: Anime) {
  const { genresJson, synonymsJson, ...rest } = row;
  return {
    ...rest,
    genres: fromJsonArray(genresJson),
    synonyms: fromJsonArray(synonymsJson),
  };
}

export async function getStudiosForAnime(animeId: number) {
  return db
    .select({
      id: studios.id,
      name: studios.name,
      isMain: animeStudioLinks.isMain,
      isAnimationStudio: studios.isAnimationStudio,
      anilistStudioId: studios.anilistStudioId,
    })
    .from(animeStudioLinks)
    .innerJoin(studios, eq(animeStudioLinks.studioId, studios.id))
    .where(eq(animeStudioLinks.animeId, animeId))
    .orderBy(asc(studios.name));
}

export async function getTagsForAnime(animeId: number) {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      category: tags.category,
      rank: animeTagLinks.rank,
      isGeneralSpoiler: tags.isGeneralSpoiler,
      isMediaSpoiler: tags.isMediaSpoiler,
      isAdult: tags.isAdult,
    })
    .from(animeTagLinks)
    .innerJoin(tags, eq(animeTagLinks.tagId, tags.id))
    .where(eq(animeTagLinks.animeId, animeId))
    .orderBy(asc(animeTagLinks.rank), asc(tags.name));
}
