import { describe, expect, test } from "bun:test";

import { isRetirableAutomaticSourceMapping } from "./episode-source-mapping-lifecycle";

describe("episode source mapping lifecycle", () => {
  test("allows fuzzy mappings to self-retire", () => {
    expect(
      isRetirableAutomaticSourceMapping({ source: "fuzzy", confidence: 85 }),
    ).toBe(true);
  });

  test("recognizes legacy 85/api heuristic mappings as automatic", () => {
    expect(
      isRetirableAutomaticSourceMapping({ source: "api", confidence: 85 }),
    ).toBe(true);
  });

  test("preserves strong or human-controlled mappings", () => {
    expect(
      isRetirableAutomaticSourceMapping({ source: "api", confidence: 100 }),
    ).toBe(false);
    expect(
      isRetirableAutomaticSourceMapping({ source: "manual", confidence: 100 }),
    ).toBe(false);
    expect(
      isRetirableAutomaticSourceMapping({ source: "import", confidence: 90 }),
    ).toBe(false);
    expect(
      isRetirableAutomaticSourceMapping({ source: "system", confidence: 100 }),
    ).toBe(false);
  });
});
