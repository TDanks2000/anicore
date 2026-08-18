import { describe, expect, test } from "bun:test";

import { planWholeSeasonOwnershipRepair } from "./whole-season-ownership-repair-plan";

function authoritative(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    providerEpisodeId: `p${index + 1}`,
    providerEpisodeNumber: index + 1,
  }));
}

function targetEpisodes(count: number) {
  return Array.from({ length: count }, (_, index) => index + 1);
}

describe("planWholeSeasonOwnershipRepair", () => {
  test("plans a repair when a one-episode owner stole the prefix of a complete target season", () => {
    const result = planWholeSeasonOwnershipRepair({
      targetAnimeId: 10,
      currentOwnerAnimeId: 20,
      authoritativeEpisodes: authoritative(12),
      targetNormalEpisodeNumbers: targetEpisodes(12),
      ownerNormalEpisodeCount: 1,
      mappedEpisodes: authoritative(12).map((episode) => ({
        providerEpisodeId: episode.providerEpisodeId,
        animeId: episode.providerEpisodeNumber === 1 ? 20 : 10,
        localEpisodeNumber: episode.providerEpisodeNumber,
        localKind: "normal",
      })),
    });

    expect(result.reason).toBeNull();
    expect(result.candidate).toEqual({
      targetAnimeId: 10,
      currentOwnerAnimeId: 20,
      authoritativeEpisodeCount: 12,
      targetOwnedEpisodeCount: 11,
      ownerOwnedEpisodeCount: 1,
      providerEpisodeNumbersToMove: [1],
    });
  });

  test("rejects a real split season when the target has fewer local episodes than the provider season", () => {
    const result = planWholeSeasonOwnershipRepair({
      targetAnimeId: 10,
      currentOwnerAnimeId: 20,
      authoritativeEpisodes: authoritative(24),
      targetNormalEpisodeNumbers: targetEpisodes(12),
      ownerNormalEpisodeCount: 12,
      mappedEpisodes: authoritative(24).map((episode) => ({
        providerEpisodeId: episode.providerEpisodeId,
        animeId: episode.providerEpisodeNumber <= 12 ? 20 : 10,
        localEpisodeNumber:
          episode.providerEpisodeNumber <= 12
            ? episode.providerEpisodeNumber
            : episode.providerEpisodeNumber - 12,
        localKind: "normal",
      })),
    });

    expect(result.candidate).toBeNull();
    expect(result.reason).toBe("target-local-count-mismatch");
  });

  test("rejects when the current owner is also season-sized", () => {
    const result = planWholeSeasonOwnershipRepair({
      targetAnimeId: 10,
      currentOwnerAnimeId: 20,
      authoritativeEpisodes: authoritative(12),
      targetNormalEpisodeNumbers: targetEpisodes(12),
      ownerNormalEpisodeCount: 12,
      mappedEpisodes: authoritative(12).map((episode) => ({
        providerEpisodeId: episode.providerEpisodeId,
        animeId: episode.providerEpisodeNumber === 1 ? 20 : 10,
        localEpisodeNumber: episode.providerEpisodeNumber,
        localKind: "normal",
      })),
    });

    expect(result.candidate).toBeNull();
    expect(result.reason).toBe("owner-also-full-season-sized");
  });

  test("rejects incomplete provider coverage", () => {
    const result = planWholeSeasonOwnershipRepair({
      targetAnimeId: 10,
      currentOwnerAnimeId: 20,
      authoritativeEpisodes: authoritative(12),
      targetNormalEpisodeNumbers: targetEpisodes(12),
      ownerNormalEpisodeCount: 1,
      mappedEpisodes: authoritative(12)
        .filter((episode) => episode.providerEpisodeNumber !== 7)
        .map((episode) => ({
          providerEpisodeId: episode.providerEpisodeId,
          animeId: episode.providerEpisodeNumber === 1 ? 20 : 10,
          localEpisodeNumber: episode.providerEpisodeNumber,
          localKind: "normal",
        })),
    });

    expect(result.candidate).toBeNull();
    expect(result.reason).toBe("unmapped-provider-episodes");
  });

  test("rejects target/provider numbering drift", () => {
    const result = planWholeSeasonOwnershipRepair({
      targetAnimeId: 10,
      currentOwnerAnimeId: 20,
      authoritativeEpisodes: authoritative(12),
      targetNormalEpisodeNumbers: targetEpisodes(12),
      ownerNormalEpisodeCount: 1,
      mappedEpisodes: authoritative(12).map((episode) => ({
        providerEpisodeId: episode.providerEpisodeId,
        animeId: episode.providerEpisodeNumber === 1 ? 20 : 10,
        localEpisodeNumber:
          episode.providerEpisodeNumber === 5 ? 4 : episode.providerEpisodeNumber,
        localKind: "normal",
      })),
    });

    expect(result.candidate).toBeNull();
    expect(result.reason).toBe("target-mapping-number-mismatch");
  });

  test("requires the target to own a strict majority", () => {
    const result = planWholeSeasonOwnershipRepair({
      targetAnimeId: 10,
      currentOwnerAnimeId: 20,
      authoritativeEpisodes: authoritative(12),
      targetNormalEpisodeNumbers: targetEpisodes(12),
      ownerNormalEpisodeCount: 2,
      mappedEpisodes: authoritative(12).map((episode) => ({
        providerEpisodeId: episode.providerEpisodeId,
        animeId: episode.providerEpisodeNumber <= 6 ? 20 : 10,
        localEpisodeNumber: episode.providerEpisodeNumber,
        localKind: "normal",
      })),
    });

    expect(result.candidate).toBeNull();
    expect(result.reason).toBe("target-not-majority-owner");
  });
});
