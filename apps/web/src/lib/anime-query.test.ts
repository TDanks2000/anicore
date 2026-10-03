import { describe, expect, test } from "bun:test";

import {
  animeHasNextPage,
  animePageBounds,
  animeQueryKey,
  applyAnimeFilters,
  clearAnimeFilters,
  DEFAULT_ANIME_QUERY,
  toggleAnimeSort,
} from "./anime-query";

describe("anime query", () => {
  test("toggleAnimeSort flips direction on the active field and resets the page", () => {
    const byScore = toggleAnimeSort({ ...DEFAULT_ANIME_QUERY, page: 3 }, "score");
    expect(byScore).toMatchObject({ sort: "score", order: "desc", page: 1 });
    expect(toggleAnimeSort(byScore, "score")).toMatchObject({
      sort: "score",
      order: "asc",
      page: 1,
    });
    // Text fields start ascending so the first click reads A→Z.
    expect(toggleAnimeSort(byScore, "title")).toMatchObject({ sort: "title", order: "asc" });
  });

  test("filter patches reset to the first page and keep the sort", () => {
    const query = {
      ...DEFAULT_ANIME_QUERY,
      sort: "score" as const,
      order: "desc" as const,
      page: 4,
    };
    expect(applyAnimeFilters(query, { format: "TV" })).toMatchObject({
      format: "TV",
      page: 1,
      sort: "score",
      order: "desc",
    });
  });

  test("clearing filters keeps sort, order and page size", () => {
    const query = {
      ...DEFAULT_ANIME_QUERY,
      q: "naruto",
      format: "TV",
      season: "SPRING",
      seasonYear: "2005",
      status: "FINISHED",
      sort: "popularity" as const,
      order: "desc" as const,
      pageSize: 100,
    };
    expect(clearAnimeFilters(query)).toEqual({
      ...DEFAULT_ANIME_QUERY,
      sort: "popularity",
      order: "desc",
      pageSize: 100,
    });
  });

  test("the query key ignores surrounding search whitespace", () => {
    expect(animeQueryKey({ ...DEFAULT_ANIME_QUERY, q: " naruto " })).toBe(
      animeQueryKey({ ...DEFAULT_ANIME_QUERY, q: "naruto" }),
    );
    expect(animeQueryKey({ ...DEFAULT_ANIME_QUERY, page: 2 })).not.toBe(
      animeQueryKey(DEFAULT_ANIME_QUERY),
    );
  });

  test("page bounds clamp to the total and survive an empty result set", () => {
    expect(animePageBounds(3, 50, 210)).toEqual({ start: 101, end: 150, lastPage: 5 });
    expect(animePageBounds(5, 50, 210)).toEqual({ start: 201, end: 210, lastPage: 5 });
    expect(animePageBounds(1, 50, 0)).toEqual({ start: 0, end: 0, lastPage: 1 });
    expect(animePageBounds(1, 50, null)).toEqual({ start: 0, end: 0, lastPage: null });
  });

  test("next-page detection falls back to a full page when the total is unknown", () => {
    expect(animeHasNextPage(1, 50, 120, 50)).toBe(true);
    expect(animeHasNextPage(3, 50, 120, 20)).toBe(false);
    expect(animeHasNextPage(1, 50, null, 50)).toBe(true);
    expect(animeHasNextPage(1, 50, null, 49)).toBe(false);
  });
});
