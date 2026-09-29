import type { Anime } from "@anicore/db/schema";
import { fromJsonArray } from "@anicore/providers/lib/json";

/** Public shape of an anime row: JSON storage columns become real arrays. */
export function formatAnime(row: Anime) {
  const { genresJson, synonymsJson, ...rest } = row;
  return {
    ...rest,
    genres: fromJsonArray(genresJson),
    synonyms: fromJsonArray(synonymsJson),
  };
}

export type AnimeResponse = ReturnType<typeof formatAnime>;
