import { describe, expect, test } from "bun:test";

import type { MappedEpisode } from "./mapper";
import { kitsuEpisodeProviderIdsForRepair } from "./sync";

describe("Kitsu authoritative repair cleanup", () => {
  test("targets only provider episode IDs belonging to the repaired Kitsu series", () => {
    const episodes = [
      { kitsuId: "episode-101" },
      { kitsuId: "episode-102" },
      { kitsuId: "episode-101" },
    ] as MappedEpisode[];

    expect(kitsuEpisodeProviderIdsForRepair(episodes)).toEqual([
      "episode-101",
      "episode-102",
    ]);
  });

  test("does not invent cleanup IDs when Kitsu exposes no episodes", () => {
    expect(kitsuEpisodeProviderIdsForRepair([])).toEqual([]);
  });
});
