import { describe, expect, test } from "bun:test";

import {
  buildOrphanParentRepairDiagnostics,
  diagnoseOrphanParentEvidence,
} from "./orphan-episode-parent-diagnostics";
import type { OrphanEpisodeMappingRow } from "./orphan-episode-parent-repair";

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

describe("orphan parent evidence diagnostics", () => {
  test("explains missing structural evidence precisely", () => {
    expect(
      diagnoseOrphanParentEvidence(row({ episodeSeasonNumber: null })).reason,
    ).toBe("missing-season-number");
    expect(diagnoseOrphanParentEvidence(row({ providerUrl: null })).reason).toBe(
      "missing-provider-url",
    );
    expect(
      diagnoseOrphanParentEvidence(row({ providerUrl: "not a url" })).reason,
    ).toBe("invalid-provider-url");
  });

  test("explains TMDB disagreements instead of returning an opaque null", () => {
    expect(
      diagnoseOrphanParentEvidence(
        row({
          providerUrl: "https://example.com/tv/123/season/2/episode/3",
        }),
      ).reason,
    ).toBe("unsupported-url-host");
    expect(
      diagnoseOrphanParentEvidence(
        row({
          providerUrl: "https://www.themoviedb.org/movie/123",
        }),
      ).reason,
    ).toBe("unsupported-url-path");
    expect(
      diagnoseOrphanParentEvidence(row({ providerEpisodeNumber: null })).reason,
    ).toBe("missing-provider-episode-number");
    expect(
      diagnoseOrphanParentEvidence(row({ episodeSeasonNumber: 3 })).reason,
    ).toBe("provider-season-mismatch");
    expect(
      diagnoseOrphanParentEvidence(row({ providerEpisodeNumber: "4" })).reason,
    ).toBe("provider-episode-number-mismatch");
  });

  test("explains TVDB identity mismatch", () => {
    expect(
      diagnoseOrphanParentEvidence(
        row({
          provider: "thetvdb",
          providerId: "343274",
          providerUrl: "https://thetvdb.com/series/777/episodes/343273",
          episodeSeasonNumber: 3,
        }),
      ).reason,
    ).toBe("provider-episode-id-mismatch");
  });

  test("returns the same usable parent evidence as the repair planner", () => {
    expect(diagnoseOrphanParentEvidence(row())).toEqual({
      evidence: {
        providerId: "123:2",
        providerUrl: "https://www.themoviedb.org/tv/123/season/2",
      },
      reason: null,
    });
  });
});

describe("orphan repair diagnostic summary", () => {
  test("reports coverage, provider and source-confidence distributions", () => {
    const diagnostics = buildOrphanParentRepairDiagnostics(
      [
        row(),
        row({
          episodeMappingId: 2,
          episodeId: 101,
          provider: "thetvdb",
          providerId: "343273",
          providerUrl: null,
          providerEpisodeNumber: null,
          episodeSeasonNumber: null,
          source: "fuzzy",
          confidence: 80,
        }),
      ],
      [],
    );

    expect(diagnostics.coverage).toEqual({
      withSeasonNumber: 1,
      withoutSeasonNumber: 1,
      withProviderUrl: 1,
      withoutProviderUrl: 1,
      withProviderEpisodeNumber: 1,
      withoutProviderEpisodeNumber: 1,
    });
    expect(diagnostics.byProvider).toEqual([
      { provider: "thetvdb", groups: 1, episodeMappings: 1 },
      { provider: "tmdb", groups: 1, episodeMappings: 1 },
    ]);
    expect(diagnostics.bySourceConfidence).toEqual([
      { source: "api", confidence: 85, episodeMappings: 1 },
      { source: "fuzzy", confidence: 80, episodeMappings: 1 },
    ]);
  });

  test("counts detailed incomplete evidence reasons and includes samples", () => {
    const diagnostics = buildOrphanParentRepairDiagnostics(
      [
        row({ providerUrl: null }),
        row({
          episodeMappingId: 2,
          episodeId: 101,
          providerUrl: null,
          providerEpisodeNumber: "4",
        }),
      ],
      [],
    );

    expect(diagnostics.categories["incomplete-parent-evidence"]).toMatchObject({
      groups: 1,
      episodeMappings: 2,
    });
    expect(diagnostics.incompleteEvidenceReasons["missing-provider-url"]).toEqual({
      groups: 1,
      episodeMappings: 2,
      rows: 2,
    });
    expect(
      diagnostics.categories["incomplete-parent-evidence"].samples[0],
    ).toMatchObject({
      animeId: 10,
      provider: "tmdb",
      episodeMappingCount: 2,
      providerUrlCount: 0,
      evidenceFailureReasons: ["missing-provider-url"],
    });
  });

  test("separates conflicts, collisions and reconstructable groups", () => {
    const conflictingRows = [
      row({ animeId: 10 }),
      row({
        animeId: 10,
        episodeMappingId: 2,
        episodeId: 101,
        providerId: "9002",
        providerUrl: "https://www.themoviedb.org/tv/456/season/2/episode/4",
        providerEpisodeNumber: "4",
      }),
    ];
    const reconstructable = row({
      animeId: 20,
      episodeMappingId: 3,
      episodeId: 200,
      providerId: "9100",
      providerUrl: "https://www.themoviedb.org/tv/789/season/1/episode/1",
      providerEpisodeNumber: "1",
      episodeSeasonNumber: 1,
    });
    const colliding = row({
      animeId: 30,
      episodeMappingId: 4,
      episodeId: 300,
      providerId: "9200",
      providerUrl: "https://www.themoviedb.org/tv/999/season/1/episode/1",
      providerEpisodeNumber: "1",
      episodeSeasonNumber: 1,
    });

    const diagnostics = buildOrphanParentRepairDiagnostics(
      [...conflictingRows, reconstructable, colliding],
      [{ animeId: 9999, provider: "tmdb", providerId: "999:1" }],
    );

    expect(diagnostics.categories["conflicting-parent-evidence"]).toMatchObject({
      groups: 1,
      episodeMappings: 2,
    });
    expect(diagnostics.categories.reconstructable).toMatchObject({
      groups: 1,
      episodeMappings: 1,
    });
    expect(diagnostics.categories["provider-identity-collision"]).toMatchObject({
      groups: 1,
      episodeMappings: 1,
    });
  });

  test("keeps stronger evidence and unsupported providers visible", () => {
    const diagnostics = buildOrphanParentRepairDiagnostics(
      [
        row({ animeId: 10, source: "manual" }),
        row({
          animeId: 11,
          episodeMappingId: 2,
          provider: "kitsu",
          providerUrl: null,
        }),
      ],
      [],
    );

    expect(diagnostics.categories["stronger-or-manual-evidence"]).toMatchObject({
      groups: 1,
      episodeMappings: 1,
    });
    expect(diagnostics.categories["unsupported-provider"]).toMatchObject({
      groups: 1,
      episodeMappings: 1,
    });
  });
});
