import { describe, expect, test } from "bun:test";

import type { CollisionEpisodeMappingRow } from "./provider-collision-segment-plan";
import {
  buildLinearCollisionSegment,
  buildTmdbResolvedCollisionGroups,
  filterOverlappingCollisionSegments,
  type ResolvedCollisionGroup,
} from "./provider-collision-segment-plan";

function row(
  overrides: Partial<CollisionEpisodeMappingRow> = {},
): CollisionEpisodeMappingRow {
  return {
    episodeMappingId: 1,
    animeId: 10,
    episodeId: 100,
    provider: "tmdb",
    providerId: "5001",
    providerUrl: "https://www.themoviedb.org/tv/777/season/1/episode/13",
    providerEpisodeNumber: "13",
    episodeSeasonNumber: 1,
    source: "api",
    confidence: 85,
    localEpisodeNumber: 1,
    localNormalEpisodeCount: 12,
    ...overrides,
  };
}

function resolvedGroup(
  overrides: Partial<ResolvedCollisionGroup> = {},
): ResolvedCollisionGroup {
  return {
    animeId: 10,
    provider: "tmdb",
    providerId: "777:1",
    providerSlug: null,
    providerUrl: "https://www.themoviedb.org/tv/777/season/1",
    confidence: 85,
    rows: Array.from({ length: 12 }, (_, index) =>
      row({
        episodeMappingId: index + 1,
        episodeId: 100 + index,
        providerId: String(5001 + index),
        providerUrl: `https://www.themoviedb.org/tv/777/season/1/episode/${13 + index}`,
        providerEpisodeNumber: String(13 + index),
        localEpisodeNumber: index + 1,
      }),
    ),
    ...overrides,
  };
}

describe("TMDB collision identity planning", () => {
  test("resolves one real provider season from stored episode URLs", () => {
    const plan = buildTmdbResolvedCollisionGroups(resolvedGroup().rows);
    expect(plan.rejected).toHaveLength(0);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.providerId).toBe("777:1");
  });

  test("rejects conflicting provider season evidence", () => {
    const rows = resolvedGroup().rows;
    rows[11] = row({
      episodeMappingId: 12,
      episodeId: 111,
      providerId: "5012",
      providerUrl: "https://www.themoviedb.org/tv/999/season/1/episode/24",
      providerEpisodeNumber: "24",
      localEpisodeNumber: 12,
    });
    const plan = buildTmdbResolvedCollisionGroups(rows);
    expect(plan.groups).toHaveLength(0);
    expect(plan.rejected[0]?.reason).toBe("conflicting-provider-identity");
  });
});

describe("linear collision segments", () => {
  test("accepts provider 13-24 mapped to local 1-12", () => {
    const result = buildLinearCollisionSegment(resolvedGroup());
    expect(result.reason).toBeNull();
    expect(result.candidate).toMatchObject({
      providerEpisodeStart: 13,
      providerEpisodeEnd: 24,
      localEpisodeStart: 1,
      localEpisodeEnd: 12,
      offset: 12,
      episodeMappingCount: 12,
    });
  });

  test("rejects partial local coverage", () => {
    const group = resolvedGroup();
    group.rows = group.rows.slice(0, 11);
    const result = buildLinearCollisionSegment(group);
    expect(result.candidate).toBeNull();
    expect(result.reason).toBe("invalid-local-coverage");
  });

  test("rejects a gap in provider numbering", () => {
    const group = resolvedGroup();
    group.rows[5] = row({
      episodeMappingId: 6,
      episodeId: 105,
      providerId: "5006",
      providerUrl: "https://www.themoviedb.org/tv/777/season/1/episode/19",
      providerEpisodeNumber: "19",
      localEpisodeNumber: 6,
    });
    const result = buildLinearCollisionSegment(group);
    expect(result.candidate).toBeNull();
    expect(result.reason).toBe("non-linear-numbering");
  });

  test("rejects overlapping segments for the same provider season", () => {
    const first = buildLinearCollisionSegment(resolvedGroup()).candidate!;
    const second = {
      ...first,
      animeId: 20,
      providerEpisodeStart: 20,
      providerEpisodeEnd: 31,
      localEpisodeStart: 1,
      localEpisodeEnd: 12,
      offset: 19,
    };
    const filtered = filterOverlappingCollisionSegments([first, second]);
    expect(filtered.candidates).toHaveLength(0);
    expect(filtered.rejected).toHaveLength(2);
  });
});
