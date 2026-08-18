import { describe, expect, test } from "bun:test";

import { planEpisodeOwnershipTransfers } from "./provider-season-ownership-transfer-plan";

const authoritative = Array.from({ length: 3 }, (_, index) => ({
  providerEpisodeId: `provider-${index + 1}`,
  providerEpisodeNumber: index + 1,
}));

function baseInput() {
  return {
    currentOwnerAnimeId: 20,
    targetAnimeId: 10,
    providerEpisodeNumbersToMove: [1],
    authoritativeEpisodes: authoritative,
    mappedEpisodes: [
      {
        episodeMappingId: 101,
        providerEpisodeId: "provider-1",
        animeId: 20,
        episodeId: 201,
      },
      {
        episodeMappingId: 102,
        providerEpisodeId: "provider-2",
        animeId: 10,
        episodeId: 202,
      },
      {
        episodeMappingId: 103,
        providerEpisodeId: "provider-3",
        animeId: 10,
        episodeId: 203,
      },
    ],
    targetEpisodes: [
      { episodeId: 301, episodeNumber: 1, kind: "normal", hasProviderMapping: false },
      { episodeId: 302, episodeNumber: 2, kind: "normal", hasProviderMapping: true },
      { episodeId: 303, episodeNumber: 3, kind: "normal", hasProviderMapping: true },
    ],
  };
}

describe("planEpisodeOwnershipTransfers", () => {
  test("plans an exact provider episode move to the matching target local episode", () => {
    expect(planEpisodeOwnershipTransfers(baseInput())).toEqual({
      moves: [
        {
          episodeMappingId: 101,
          providerEpisodeId: "provider-1",
          providerEpisodeNumber: 1,
          fromEpisodeId: 201,
          toEpisodeId: 301,
        },
      ],
      reason: null,
    });
  });

  test("prefers the normal target when a special has the same number", () => {
    const input = baseInput();
    input.targetEpisodes.push({
      episodeId: 999,
      episodeNumber: 1,
      kind: "special",
      hasProviderMapping: false,
    });
    expect(planEpisodeOwnershipTransfers(input)).toEqual({
      moves: [
        {
          episodeMappingId: 101,
          providerEpisodeId: "provider-1",
          providerEpisodeNumber: 1,
          fromEpisodeId: 201,
          toEpisodeId: 301,
        },
      ],
      reason: null,
    });
  });

  test("rejects when the current mapping no longer belongs to the expected owner", () => {
    const input = baseInput();
    input.mappedEpisodes[0]!.animeId = 999;
    expect(planEpisodeOwnershipTransfers(input)).toEqual({
      moves: null,
      reason: "wrong-current-owner",
    });
  });

  test("rejects when the target provider slot is already populated", () => {
    const input = baseInput();
    input.targetEpisodes[0]!.hasProviderMapping = true;
    expect(planEpisodeOwnershipTransfers(input)).toEqual({
      moves: null,
      reason: "target-provider-slot-already-populated",
    });
  });

  test("rejects when the matching target episode does not exist", () => {
    const input = baseInput();
    input.targetEpisodes = input.targetEpisodes.filter((episode) => episode.episodeNumber !== 1);
    expect(planEpisodeOwnershipTransfers(input)).toEqual({
      moves: null,
      reason: "missing-target-episode",
    });
  });

  test("rejects duplicate provider episode numbers instead of planning twice", () => {
    const input = baseInput();
    input.providerEpisodeNumbersToMove = [1, 1];
    expect(planEpisodeOwnershipTransfers(input)).toEqual({
      moves: null,
      reason: "duplicate-provider-episode-number",
    });
  });
});
