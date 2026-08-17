import { describe, expect, test } from "bun:test";

import {
  assertUnambiguousAnimeMappingPrimaries,
  assertUniqueMappingIdentities,
  canonicalProviderId,
  MappingInputError,
} from "./mapping-invariants";

describe("mapping input invariants", () => {
  test("canonicalizes provider IDs", () => {
    expect(canonicalProviderId(" 12345:2 ")).toBe("12345:2");
  });

  test("detects duplicates after canonicalization", () => {
    expect(() =>
      assertUniqueMappingIdentities([
        { provider: "kitsu", providerId: "123" },
        { provider: "kitsu", providerId: " 123 " },
      ]),
    ).toThrow(MappingInputError);
  });

  test("requires exactly one primary when an anime has multiple IDs for a provider", () => {
    expect(() =>
      assertUnambiguousAnimeMappingPrimaries([
        { provider: "thetvdb", providerId: "1:1" },
        { provider: "thetvdb", providerId: "1:2" },
      ]),
    ).toThrow("exactly one primary");

    expect(() =>
      assertUnambiguousAnimeMappingPrimaries([
        { provider: "thetvdb", providerId: "1:1", isPrimary: true },
        { provider: "thetvdb", providerId: "1:2", isPrimary: true },
      ]),
    ).toThrow("exactly one primary");

    expect(() =>
      assertUnambiguousAnimeMappingPrimaries([
        { provider: "thetvdb", providerId: "1:1", isPrimary: true },
        { provider: "thetvdb", providerId: "1:2" },
      ]),
    ).not.toThrow();
  });
});
