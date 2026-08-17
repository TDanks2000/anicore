import { describe, expect, test } from "bun:test";

import { normalizeAuthoritativeMappings } from "./authoritative-cross-mappings";

describe("authoritative cross mappings", () => {
  test("canonicalizes and deduplicates identical provider identities", () => {
    expect(
      normalizeAuthoritativeMappings([
        { provider: "mal", providerId: " 123 ", providerUrl: " https://example.test/123 " },
        { provider: "mal", providerId: "123", providerUrl: "https://example.test/123" },
      ]),
    ).toEqual([
      {
        provider: "mal",
        providerId: "123",
        providerSlug: null,
        providerUrl: "https://example.test/123",
      },
    ]);
  });

  test("rejects two authoritative IDs for one provider", () => {
    expect(() =>
      normalizeAuthoritativeMappings([
        { provider: "mal", providerId: "123" },
        { provider: "mal", providerId: "456" },
      ]),
    ).toThrow("multiple mal identities");
  });

  test("rejects blank authoritative IDs", () => {
    expect(() =>
      normalizeAuthoritativeMappings([{ provider: "mal", providerId: "   " }]),
    ).toThrow("blank provider ID");
  });
});
