import { describe, expect, test } from "bun:test";

import { canonicalProviderId } from "./mappings.routes";

describe("mapping provider IDs", () => {
  test("canonicalizes leading and trailing whitespace", () => {
    expect(canonicalProviderId("  151807  ")).toBe("151807");
    expect(canonicalProviderId(" 12345:2 ")).toBe("12345:2");
    expect(canonicalProviderId("  anime-route  ")).toBe("anime-route");
  });
});
