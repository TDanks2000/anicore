import { describe, expect, test } from "bun:test";

import {
  analyzeCollisionCoverageGroup,
  type CoverageDiagnosticRow,
} from "./provider-collision-coverage-diagnostics";

function rows(
  localNumbers: number[],
  providerStart: number,
  expectedLocalEpisodeCount = 12,
): CoverageDiagnosticRow[] {
  return localNumbers.map((localEpisodeNumber, index) => ({
    episodeMappingId: index + 1,
    animeId: 10,
    provider: "tmdb",
    localEpisodeNumber,
    localNormalEpisodeCount: expectedLocalEpisodeCount,
    providerEpisodeNumber: String(providerStart + index),
  }));
}

describe("provider collision coverage diagnostics", () => {
  test("recognizes complete offset coverage", () => {
    const result = analyzeCollisionCoverageGroup(
      rows(Array.from({ length: 12 }, (_, index) => index + 1), 13),
    );
    expect(result.completeCoverage).toBe(true);
    expect(result.evidenceBackedLinear).toBe(true);
    expect(result.offset).toBe(12);
    expect(result.gapPosition).toBe("complete");
  });

  test("recognizes partial trailing coverage without guessing the missing episode", () => {
    const result = analyzeCollisionCoverageGroup(
      rows(Array.from({ length: 11 }, (_, index) => index + 1), 13),
    );
    expect(result.completeCoverage).toBe(false);
    expect(result.evidenceBackedLinear).toBe(true);
    expect(result.offset).toBe(12);
    expect(result.gapPosition).toBe("trailing");
    expect(result.missingLocalEpisodeNumbers).toEqual([12]);
  });

  test("recognizes a linear subset missing both ends", () => {
    const result = analyzeCollisionCoverageGroup(rows([3, 4, 5], 15));
    expect(result.evidenceBackedLinear).toBe(true);
    expect(result.offset).toBe(12);
    expect(result.gapPosition).toBe("both-ends");
  });

  test("does not call a local numbering gap linear", () => {
    const result = analyzeCollisionCoverageGroup(rows([1, 2, 4], 13));
    expect(result.evidenceBackedLinear).toBe(false);
    expect(result.offset).toBeNull();
    expect(result.gapPosition).toBe("internal-or-nonlinear");
  });

  test("does not call a provider numbering gap linear", () => {
    const group = rows([1, 2, 3], 13);
    group[2]!.providerEpisodeNumber = "16";
    const result = analyzeCollisionCoverageGroup(group);
    expect(result.evidenceBackedLinear).toBe(false);
    expect(result.offset).toBeNull();
  });
});
