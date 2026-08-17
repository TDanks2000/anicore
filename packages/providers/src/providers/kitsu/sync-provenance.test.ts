import { describe, expect, test } from "bun:test";

import { kitsuMappingProvenance } from "./sync";

describe("Kitsu mapping provenance", () => {
  test("marks direct AniList cross-references as authoritative API mappings", () => {
    expect(kitsuMappingProvenance(true)).toEqual({
      confidence: 100,
      source: "api",
    });
  });

  test("keeps title/metadata matches visibly fuzzy at anime and episode level", () => {
    expect(kitsuMappingProvenance(false)).toEqual({
      confidence: 90,
      source: "fuzzy",
    });
  });
});
