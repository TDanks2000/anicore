import { describe, expect, test } from "bun:test";

import {
  classifyProviderSeasonOwnership,
  type ProviderSeasonEpisodeOwnership,
} from "./provider-season-ownership-diagnostics";

function season(owners: Array<number | null>): ProviderSeasonEpisodeOwnership[] {
  return owners.map((animeId, index) => ({
    providerEpisodeId: String(1000 + index + 1),
    providerEpisodeNumber: index + 1,
    animeId,
  }));
}

describe("provider season ownership diagnostics", () => {
  test("detects owner then orphan adjacent partition", () => {
    const result = classifyProviderSeasonOwnership(
      season([20, 20, 10, 10, 10]),
      10,
      [20],
    );
    expect(result.classification).toBe("owner-then-orphan-adjacent");
    expect(result.ownerRanges).toEqual(["1-2"]);
    expect(result.orphanRanges).toEqual(["3-5"]);
  });

  test("detects orphan then owner adjacent partition", () => {
    const result = classifyProviderSeasonOwnership(
      season([10, 10, 20, 20]),
      10,
      [20],
    );
    expect(result.classification).toBe("orphan-then-owner-adjacent");
  });

  test("detects a gap between owner and orphan", () => {
    const result = classifyProviderSeasonOwnership(
      season([20, 20, null, 10, 10]),
      10,
      [20],
    );
    expect(result.classification).toBe("owner-orphan-with-gap");
    expect(result.unmappedRanges).toEqual(["3"]);
  });

  test("detects fragmented ownership", () => {
    const result = classifyProviderSeasonOwnership(
      season([20, 10, 20, 10]),
      10,
      [20],
    );
    expect(result.classification).toBe("fragmented-between-owner-and-orphan");
  });

  test("detects a third anime owning provider episodes", () => {
    const result = classifyProviderSeasonOwnership(
      season([20, 30, 10]),
      10,
      [20],
    );
    expect(result.classification).toBe("other-anime-involved");
    expect(result.otherAnimeIds).toEqual([30]);
  });
});
