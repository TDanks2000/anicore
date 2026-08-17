import { describe, expect, test } from "bun:test";

import {
  conflictingKitsuIdentities,
  formatKitsuIdentityConflict,
} from "./identity";

describe("Kitsu identity drift", () => {
  test("allows resyncing the same Kitsu identity", () => {
    expect(
      conflictingKitsuIdentities(
        [{ providerId: "10", source: "fuzzy", confidence: 90 }],
        "10",
      ),
    ).toEqual([]);
  });

  test("detects a different Kitsu identity instead of silently accumulating it", () => {
    const conflicts = conflictingKitsuIdentities(
      [{ providerId: "10", source: "fuzzy", confidence: 90 }],
      "20",
    );

    expect(conflicts).toEqual([
      { providerId: "10", source: "fuzzy", confidence: 90 },
    ]);
    expect(formatKitsuIdentityConflict("20", conflicts)).toContain(
      "10 (fuzzy/90)",
    );
  });

  test("does not weaken the guard for authoritative or manual existing mappings", () => {
    expect(
      conflictingKitsuIdentities(
        [
          { providerId: "10", source: "api", confidence: 100 },
          { providerId: "11", source: "manual", confidence: 100 },
        ],
        "20",
      ),
    ).toHaveLength(2);
  });
});
