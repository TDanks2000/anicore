import { describe, expect, test } from "bun:test";

import {
  buildTvdbSlugResolutionGroups,
  deriveTvdbSlugEpisodeEvidence,
  filterTvdbSlugCandidateCollisions,
  verifyResolvedTvdbSlugGroup,
  type TvdbSlugRepairCandidate,
} from "./orphan-tvdb-slug-repair";
import type { OrphanEpisodeMappingRow } from "./orphan-episode-parent-repair";

function row(
  overrides: Partial<OrphanEpisodeMappingRow> = {},
): OrphanEpisodeMappingRow {
  return {
    episodeMappingId: 1,
    animeId: 10,
    episodeId: 100,
    provider: "thetvdb",
    providerId: "343273",
    providerUrl: "https://thetvdb.com/series/example-show/episodes/343273",
    providerEpisodeNumber: "1",
    episodeSeasonNumber: 1,
    source: "api",
    confidence: 85,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<TvdbSlugRepairCandidate> = {},
): TvdbSlugRepairCandidate {
  return {
    animeId: 10,
    provider: "thetvdb",
    providerId: "777:1",
    providerSlug: "example-show",
    providerUrl: "https://thetvdb.com/series/example-show/seasons/official/1",
    source: "fuzzy",
    confidence: 85,
    episodeMappingCount: 2,
    episodeMappingIds: [1, 2],
    ...overrides,
  };
}

describe("TVDB slug evidence", () => {
  test("extracts a textual series slug while preserving episode identity", () => {
    expect(deriveTvdbSlugEpisodeEvidence(row())).toEqual({
      slug: "example-show",
      seasonNumber: 1,
      providerEpisodeId: 343273,
      providerEpisodeNumber: 1,
    });
  });

  test("does not treat numeric series URLs as slug recovery work", () => {
    expect(
      deriveTvdbSlugEpisodeEvidence(
        row({
          providerUrl: "https://thetvdb.com/series/777/episodes/343273",
        }),
      ),
    ).toBeNull();
  });

  test("requires URL episode ID to match the stored provider episode ID", () => {
    expect(
      deriveTvdbSlugEpisodeEvidence(
        row({
          providerUrl: "https://thetvdb.com/series/example-show/episodes/999",
        }),
      ),
    ).toBeNull();
  });
});

describe("TVDB slug resolution groups", () => {
  test("groups weak legacy rows only when slug and season agree", () => {
    const plan = buildTvdbSlugResolutionGroups([
      row(),
      row({
        episodeMappingId: 2,
        episodeId: 101,
        providerId: "343274",
        providerUrl: "https://thetvdb.com/series/example-show/episodes/343274",
        providerEpisodeNumber: "2",
      }),
    ]);

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toEqual({
      animeId: 10,
      slug: "example-show",
      seasonNumber: 1,
      confidence: 85,
      episodeMappingIds: [1, 2],
      episodes: [
        { providerEpisodeId: 343273, providerEpisodeNumber: 1 },
        { providerEpisodeId: 343274, providerEpisodeNumber: 2 },
      ],
    });
  });

  test("rejects a group with conflicting slugs or stronger provenance", () => {
    const conflicting = buildTvdbSlugResolutionGroups([
      row(),
      row({
        episodeMappingId: 2,
        providerId: "343274",
        providerUrl: "https://thetvdb.com/series/another-show/episodes/343274",
        providerEpisodeNumber: "2",
      }),
    ]);
    expect(conflicting.groups).toHaveLength(0);
    expect(conflicting.skippedInvalidEvidenceGroups).toBe(1);

    const strong = buildTvdbSlugResolutionGroups([
      row({ source: "manual", confidence: 100 }),
    ]);
    expect(strong.groups).toHaveLength(0);
    expect(strong.skippedInvalidEvidenceGroups).toBe(1);
  });
});

describe("TVDB remote verification", () => {
  test("requires every stored episode ID and number to match the resolved season", () => {
    const group = buildTvdbSlugResolutionGroups([
      row(),
      row({
        episodeMappingId: 2,
        providerId: "343274",
        providerUrl: "https://thetvdb.com/series/example-show/episodes/343274",
        providerEpisodeNumber: "2",
      }),
    ]).groups[0]!;

    const verified = verifyResolvedTvdbSlugGroup(
      group,
      { id: 777, slug: "example-show" },
      [
        { id: 343273, number: 1 },
        { id: 343274, number: 2 },
      ],
    );
    expect(verified?.providerId).toBe("777:1");
    expect(verified?.source).toBe("fuzzy");
    expect(verified?.confidence).toBe(85);

    expect(
      verifyResolvedTvdbSlugGroup(
        group,
        { id: 777, slug: "example-show" },
        [
          { id: 343273, number: 1 },
          { id: 343274, number: 3 },
        ],
      ),
    ).toBeNull();
  });

  test("rejects an unexpected slug returned by TVDB", () => {
    const group = buildTvdbSlugResolutionGroups([row()]).groups[0]!;
    expect(
      verifyResolvedTvdbSlugGroup(
        group,
        { id: 777, slug: "different-show" },
        [{ id: 343273, number: 1 }],
      ),
    ).toBeNull();
  });
});

describe("TVDB candidate collision filtering", () => {
  test("skips a provider season already owned by another anime", () => {
    const result = filterTvdbSlugCandidateCollisions([candidate()], [
      { animeId: 999, provider: "thetvdb", providerId: "777:1" },
    ]);
    expect(result.candidates).toHaveLength(0);
    expect(result.skippedCollisionGroups).toBe(1);
    expect(result.skippedCollisionEpisodeMappings).toBe(2);
  });

  test("skips both candidates when two orphan anime resolve to one provider season", () => {
    const result = filterTvdbSlugCandidateCollisions(
      [candidate(), candidate({ animeId: 11, episodeMappingIds: [3, 4] })],
      [],
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.skippedCollisionGroups).toBe(2);
    expect(result.skippedCollisionEpisodeMappings).toBe(4);
  });
});
