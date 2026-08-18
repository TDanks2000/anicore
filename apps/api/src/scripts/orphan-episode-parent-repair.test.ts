import { describe, expect, test } from "bun:test";

import {
  buildOrphanParentRepairPlan,
  deriveOrphanParentEvidence,
  isWeakAutomaticOrphanEpisodeMapping,
  type OrphanEpisodeMappingRow,
} from "./orphan-episode-parent-repair";

function row(
  overrides: Partial<OrphanEpisodeMappingRow> = {},
): OrphanEpisodeMappingRow {
  return {
    episodeMappingId: 1,
    animeId: 10,
    episodeId: 100,
    provider: "tmdb",
    providerId: "9001",
    providerUrl: "https://www.themoviedb.org/tv/123/season/2/episode/3",
    providerEpisodeNumber: "3",
    episodeSeasonNumber: 2,
    source: "api",
    confidence: 85,
    ...overrides,
  };
}

describe("orphan episode parent evidence", () => {
  test("recognizes only weak automatic provenance", () => {
    expect(isWeakAutomaticOrphanEpisodeMapping(row())).toBe(true);
    expect(
      isWeakAutomaticOrphanEpisodeMapping(row({ source: "fuzzy", confidence: 80 })),
    ).toBe(true);
    expect(
      isWeakAutomaticOrphanEpisodeMapping(row({ source: "api", confidence: 90 })),
    ).toBe(false);
    expect(
      isWeakAutomaticOrphanEpisodeMapping(row({ source: "manual", confidence: 85 })),
    ).toBe(false);
  });

  test("derives TMDB show and season from the stored episode URL", () => {
    expect(deriveOrphanParentEvidence(row())).toEqual({
      providerId: "123:2",
      providerUrl: "https://www.themoviedb.org/tv/123/season/2",
    });
  });

  test("requires TMDB URL episode number and canonical season to agree", () => {
    expect(
      deriveOrphanParentEvidence(row({ providerEpisodeNumber: "4" })),
    ).toBeNull();
    expect(
      deriveOrphanParentEvidence(row({ episodeSeasonNumber: 1 })),
    ).toBeNull();
  });

  test("derives numeric TVDB series and canonical season", () => {
    expect(
      deriveOrphanParentEvidence(
        row({
          provider: "thetvdb",
          providerId: "343273",
          providerUrl: "https://thetvdb.com/series/777/episodes/343273",
          providerEpisodeNumber: "1",
          episodeSeasonNumber: 3,
        }),
      ),
    ).toEqual({ providerId: "777:3", providerUrl: null });
  });

  test("does not guess a TVDB numeric identity from a textual slug", () => {
    expect(
      deriveOrphanParentEvidence(
        row({
          provider: "thetvdb",
          providerId: "343273",
          providerUrl: "https://thetvdb.com/series/example-show/episodes/343273",
          episodeSeasonNumber: 1,
        }),
      ),
    ).toBeNull();
  });
});

describe("orphan parent repair plan", () => {
  test("reconstructs a parent only when every row agrees", () => {
    const plan = buildOrphanParentRepairPlan(
      [
        row({ episodeMappingId: 1, providerEpisodeNumber: "3" }),
        row({
          episodeMappingId: 2,
          episodeId: 101,
          providerId: "9002",
          providerUrl: "https://www.themoviedb.org/tv/123/season/2/episode/4",
          providerEpisodeNumber: "4",
          source: "fuzzy",
        }),
      ],
      [],
    );

    expect(plan.candidates).toEqual([
      {
        animeId: 10,
        provider: "tmdb",
        providerId: "123:2",
        providerUrl: "https://www.themoviedb.org/tv/123/season/2",
        source: "fuzzy",
        confidence: 85,
        episodeMappingCount: 2,
        episodeMappingIds: [1, 2],
      },
    ]);
  });

  test("skips a group containing manual or stronger automatic evidence", () => {
    const plan = buildOrphanParentRepairPlan(
      [row(), row({ episodeMappingId: 2, source: "manual" })],
      [],
    );

    expect(plan.candidates).toHaveLength(0);
    expect(plan.skipped.strongerOrManualEvidence).toEqual({
      groups: 1,
      episodeMappings: 2,
    });
  });

  test("skips incomplete or conflicting parent evidence", () => {
    const incomplete = buildOrphanParentRepairPlan(
      [row({ providerUrl: null })],
      [],
    );
    expect(incomplete.skipped.incompleteParentEvidence.groups).toBe(1);

    const conflicting = buildOrphanParentRepairPlan(
      [
        row(),
        row({
          episodeMappingId: 2,
          providerId: "9002",
          providerUrl: "https://www.themoviedb.org/tv/456/season/2/episode/4",
          providerEpisodeNumber: "4",
        }),
      ],
      [],
    );
    expect(conflicting.skipped.conflictingParentEvidence.groups).toBe(1);
  });

  test("skips a provider identity already owned by another anime", () => {
    const plan = buildOrphanParentRepairPlan([row()], [
      { animeId: 999, provider: "tmdb", providerId: "123:2" },
    ]);

    expect(plan.candidates).toHaveLength(0);
    expect(plan.skipped.providerIdentityCollision).toEqual({
      groups: 1,
      episodeMappings: 1,
    });
  });

  test("skips when two orphan anime claim the same provider season", () => {
    const plan = buildOrphanParentRepairPlan(
      [row(), row({ episodeMappingId: 2, animeId: 11, episodeId: 200 })],
      [],
    );

    expect(plan.candidates).toHaveLength(0);
    expect(plan.skipped.providerIdentityCollision).toEqual({
      groups: 2,
      episodeMappings: 2,
    });
  });

  test("reports unsupported orphan providers without modifying them", () => {
    const plan = buildOrphanParentRepairPlan(
      [row({ provider: "kitsu", providerUrl: null })],
      [],
    );

    expect(plan.candidates).toHaveLength(0);
    expect(plan.skipped.unsupportedProvider).toEqual({
      groups: 1,
      episodeMappings: 1,
    });
  });
});
