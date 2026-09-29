import { describe, expect, test } from "bun:test";

import { HttpError } from "../../lib/errors";
import {
  canonicalProviderId,
  prepareNewAnimeMappings,
  prepareNewEpisodeMappings,
} from "./mappings.service";

function expectBadRequest(fn: () => unknown, message: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).message).toBe(message);
    return;
  }
  throw new Error("expected a 400 HttpError");
}

describe("canonicalProviderId", () => {
  test("trims surrounding whitespace", () => {
    expect(canonicalProviderId("  151807  ")).toBe("151807");
    expect(canonicalProviderId(" 12345:2 ")).toBe("12345:2");
  });

  test("rejects blank IDs", () => {
    expectBadRequest(() => canonicalProviderId("   "), "Mapping providerId cannot be blank");
  });
});

describe("prepareNewAnimeMappings", () => {
  test("makes a provider's only mapping primary by default", () => {
    expect(
      prepareNewAnimeMappings([
        { provider: "kitsu", providerId: " 1 " },
        { provider: "mal", providerId: "2", isPrimary: false },
      ]),
    ).toEqual([
      { provider: "kitsu", providerId: "1", isPrimary: true },
      { provider: "mal", providerId: "2", isPrimary: false },
    ]);
  });

  test("requires exactly one primary when a provider has several mappings", () => {
    expectBadRequest(
      () =>
        prepareNewAnimeMappings([
          { provider: "thetvdb", providerId: "1" },
          { provider: "thetvdb", providerId: "2" },
        ]),
      "Multiple thetvdb mappings require exactly one primary mapping",
    );

    expect(
      prepareNewAnimeMappings([
        { provider: "thetvdb", providerId: "1", isPrimary: true },
        { provider: "thetvdb", providerId: "2" },
      ]).map((mapping) => mapping.isPrimary),
    ).toEqual([true, false]);
  });

  test("rejects the same identity twice after canonicalization", () => {
    expectBadRequest(
      () =>
        prepareNewAnimeMappings([
          { provider: "kitsu", providerId: "1", isPrimary: true },
          { provider: "kitsu", providerId: " 1" },
        ]),
      "Duplicate kitsu mapping 1 in request",
    );
  });
});

describe("prepareNewEpisodeMappings", () => {
  test("canonicalizes and de-duplicates identities", () => {
    expect(prepareNewEpisodeMappings([{ provider: "kitsu", providerId: " 9 " }])).toEqual([
      { provider: "kitsu", providerId: "9" },
    ]);
    expectBadRequest(
      () =>
        prepareNewEpisodeMappings([
          { provider: "kitsu", providerId: "9" },
          { provider: "kitsu", providerId: "9 " },
        ]),
      "Duplicate kitsu mapping 9 in request",
    );
  });
});
