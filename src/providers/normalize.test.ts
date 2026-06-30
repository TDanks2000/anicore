import { describe, expect, test } from "bun:test";

import {
  dedupeProviderStudios,
  dedupeProviderTags,
  normalizeEntityName,
} from "./normalize";

describe("provider normalization", () => {
  test("normalizes entity names consistently", () => {
    expect(normalizeEntityName("  Studio BONES  ")).toBe("studio bones");
  });

  test("dedupes studios by normalized name and preserves strongest metadata", () => {
    expect(
      dedupeProviderStudios([
        {
          name: " Bones ",
          isMain: false,
          isAnimationStudio: false,
          anilistStudioId: null,
        },
        {
          name: "bones",
          isMain: true,
          isAnimationStudio: true,
          anilistStudioId: 4,
        },
      ]),
    ).toEqual([
      {
        name: "Bones",
        isMain: true,
        isAnimationStudio: true,
        anilistStudioId: 4,
      },
    ]);
  });

  test("dedupes tags by normalized name and keeps lowest rank", () => {
    expect(
      dedupeProviderTags([
        {
          name: " Space ",
          category: null,
          rank: 70,
          isGeneralSpoiler: false,
          isMediaSpoiler: false,
          isAdult: false,
        },
        {
          name: "space",
          category: "Theme",
          rank: 30,
          isGeneralSpoiler: true,
          isMediaSpoiler: false,
          isAdult: false,
        },
      ]),
    ).toEqual([
      {
        name: "Space",
        category: "Theme",
        rank: 30,
        isGeneralSpoiler: true,
        isMediaSpoiler: false,
        isAdult: false,
      },
    ]);
  });
});
