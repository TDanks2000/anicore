import { describe, expect, test } from "bun:test";

import type { KitsuSearchNode } from "@anicore/providers/kitsu/client";
import type { MatchHints } from "../../../../packages/providers/src/providers/kitsu/matching";

import {
  buildEvaluationReport,
  collectTopAbstentions,
  collectWrongCases,
  computeFormatBreakdown,
  computeMetrics,
  gradeCase,
  passesMinPrecision,
  type GradedCase,
  type KitsuMatchingCorpus,
  type KitsuMatchingCorpusCase,
} from "./evaluate-kitsu-matching";

interface NodeOptions {
  id: string;
  title: string;
  season?: string | null;
  startDate?: string | null;
  episodeCount?: number | null;
  subtype?: string | null;
}

function buildNode(options: NodeOptions): KitsuSearchNode {
  return {
    id: options.id,
    slug: options.id,
    season: options.season ?? null,
    startDate: options.startDate ?? null,
    endDate: null,
    subtype: options.subtype ?? null,
    status: null,
    episodeCount: options.episodeCount ?? null,
    episodeLength: null,
    averageRating: null,
    userCount: null,
    userCountRank: null,
    averageRatingRank: null,
    ageRating: null,
    titles: {
      romanized: options.title,
      translated: null,
      original: null,
      localized: {},
      alternatives: [],
    },
    mappings: { nodes: [], pageInfo: { hasNextPage: false } },
    posterImage: null,
    bannerImage: null,
  };
}

function buildHints(overrides: Partial<MatchHints> = {}): MatchHints {
  return {
    titleRomaji: "Test Anime Alpha",
    format: "TV",
    ...overrides,
  };
}

function buildCase(overrides: Partial<KitsuMatchingCorpusCase> = {}): KitsuMatchingCorpusCase {
  return {
    hints: buildHints(),
    expectedKitsuId: "expected-1",
    candidates: [],
    ...overrides,
  };
}

describe("gradeCase", () => {
  test("classifies a correct match: expected candidate scores highest and clears the threshold", () => {
    const testCase = buildCase({
      hints: buildHints({ titleRomaji: "Test Anime Alpha", seasonYear: 2020 }),
      expectedKitsuId: "expected-1",
      candidates: [
        buildNode({ id: "expected-1", title: "Test Anime Alpha", startDate: "2020-01-01" }),
      ],
    });

    const graded = gradeCase(testCase);

    expect(graded.classification).toBe("correct");
    expect(graded.selectedKitsuId).toBe("expected-1");
    expect(graded.expectedScore).not.toBeNull();
    expect(graded.margin).toBeNull();
  });

  test("classifies a wrong match: a decoy outscores the expected candidate by more than the ambiguity margin", () => {
    const testCase = buildCase({
      hints: buildHints({ titleRomaji: "Test Anime Alpha", seasonYear: 2020 }),
      expectedKitsuId: "expected-1",
      candidates: [
        // Exact title match, no other corroborating metadata -> title score only.
        buildNode({ id: "expected-1", title: "Test Anime Alpha" }),
        // Near-miss title plus a matching year -> scores higher. The decoy's
        // title must differ from the expected node's, otherwise both are
        // discounted as a title shared across the candidate set.
        buildNode({ id: "decoy-1", title: "Test Anime Alphas", startDate: "2020-06-01" }),
      ],
    });

    const graded = gradeCase(testCase);

    expect(graded.classification).toBe("wrong");
    expect(graded.selectedKitsuId).toBe("decoy-1");
    expect(graded.expectedKitsuId).toBe("expected-1");
    expect(graded.selectedScore).not.toBeNull();
    expect(graded.expectedScore).not.toBeNull();
    expect(graded.margin).toBe(graded.selectedScore! - graded.expectedScore!);
    expect(graded.margin).toBeGreaterThan(0);
  });

  test("classifies an abstention: the only candidate clears title similarity but stays below the match threshold", () => {
    const testCase = buildCase({
      hints: buildHints({ titleRomaji: "Test Anime Alpha" }),
      expectedKitsuId: "expected-1",
      // Exact title match with no season/year/episode corroboration scores 35,
      // which is below the matcher's fixed threshold of 45.
      candidates: [buildNode({ id: "expected-1", title: "Test Anime Alpha" })],
    });

    const graded = gradeCase(testCase);

    expect(graded.classification).toBe("abstained");
    expect(graded.selectedKitsuId).toBeNull();
    expect(graded.bestScore).not.toBeNull();
    expect(graded.margin).toBeNull();
  });

  test("classifies unreachable: the expected id never appears among the candidates", () => {
    const testCase = buildCase({
      hints: buildHints({ titleRomaji: "Test Anime Alpha" }),
      expectedKitsuId: "missing-id",
      candidates: [buildNode({ id: "some-other-id", title: "Completely Unrelated Show" })],
    });

    const graded = gradeCase(testCase);

    // Unrelated candidate scores below the floor, so nothing is selected. The
    // outcome is an abstention; unreachability is recorded on its own flag.
    expect(graded.expectedReachable).toBe(false);
    expect(graded.classification).toBe("abstained");
    expect(graded.expectedTitle).toBeNull();
    expect(graded.expectedScore).toBeNull();
  });

  test("an unreachable case that still selects a node counts as wrong, not as a footnote", () => {
    // Regression: reachability used to be an outcome value that shadowed
    // "wrong", so a run that confidently picked the wrong record whenever the
    // right one was missing reported inflated precision.
    const testCase = buildCase({
      hints: buildHints({
        titleRomaji: "Test Anime Alpha",
        seasonYear: 2020,
        episodeCount: 12,
      }),
      expectedKitsuId: "never-returned",
      candidates: [
        buildNode({
          id: "impostor",
          title: "Test Anime Alpha",
          season: "winter",
          startDate: "2020-01-05",
          episodeCount: 12,
        }),
      ],
    });

    const graded = gradeCase(testCase);

    expect(graded.expectedReachable).toBe(false);
    expect(graded.classification).toBe("wrong");
    expect(graded.selectedKitsuId).toBe("impostor");
    expect(computeMetrics([graded]).precision).toBe(0);
  });

  test("strips anilistId from the hints before scoring so the authoritative shortcut cannot fire", () => {
    const testCase = buildCase({
      hints: buildHints({ titleRomaji: "Test Anime Alpha", anilistId: "999" }),
      expectedKitsuId: "expected-1",
      candidates: [
        buildNode({
          id: "expected-1",
          title: "Completely Different Title",
        }),
      ],
    });

    const graded = gradeCase(testCase);

    // Title similarity is far below the minimum, so without the authoritative
    // shortcut this candidate cannot score above the conflicting-mapping floor.
    expect(graded.classification).toBe("abstained");
  });
});

describe("computeMetrics", () => {
  function graded(
    classification: GradedCase["classification"],
    format = "TV",
    expectedReachable = true,
  ): GradedCase {
    return {
      classification,
      expectedReachable,
      format,
      animeTitle: "Some Anime",
      expectedKitsuId: "1",
      selectedKitsuId: classification === "correct" || classification === "wrong" ? "1" : null,
      expectedTitle: null,
      selectedTitle: null,
      expectedScore: null,
      selectedScore: null,
      bestScore: null,
      margin: null,
    };
  }

  test("computes precision, recall, abstention rate and unreachable rate", () => {
    const cases = [
      graded("correct"),
      graded("correct"),
      graded("wrong"),
      graded("abstained"),
      // Reachability is orthogonal to the outcome: this case abstained AND the
      // correct record was never a candidate.
      graded("abstained", "TV", false),
    ];

    const metrics = computeMetrics(cases);

    expect(metrics).toEqual({
      total: 5,
      correct: 2,
      wrong: 1,
      abstained: 2,
      unreachable: 1,
      precision: 2 / 3,
      recall: 2 / 5,
      abstentionRate: 2 / 5,
      unreachableRate: 1 / 5,
    });
  });

  test("returns null precision when there are no correct or wrong cases (divide by zero)", () => {
    const metrics = computeMetrics([graded("abstained"), graded("abstained", "TV", false)]);

    expect(metrics.precision).toBeNull();
    expect(metrics.recall).toBe(0);
  });

  test("returns null for every rate on an empty case list", () => {
    const metrics = computeMetrics([]);

    expect(metrics).toEqual({
      total: 0,
      correct: 0,
      wrong: 0,
      abstained: 0,
      unreachable: 0,
      precision: null,
      recall: null,
      abstentionRate: null,
      unreachableRate: null,
    });
  });

  test("aggregates per format", () => {
    const cases = [
      graded("correct", "TV"),
      graded("wrong", "TV"),
      graded("correct", "MOVIE"),
    ];

    const breakdown = computeFormatBreakdown(cases);

    expect(breakdown.map((row) => row.format)).toEqual(["MOVIE", "TV"]);
    expect(breakdown.find((row) => row.format === "TV")).toMatchObject({
      total: 2,
      correct: 1,
      wrong: 1,
      precision: 0.5,
    });
    expect(breakdown.find((row) => row.format === "MOVIE")).toMatchObject({
      total: 1,
      correct: 1,
      wrong: 0,
      precision: 1,
    });
  });
});

describe("collectWrongCases / collectTopAbstentions", () => {
  test("only includes wrong cases, sorted by anime title", () => {
    const cases: KitsuMatchingCorpusCase[] = [
      buildCase({
        hints: buildHints({ titleRomaji: "Zeta Show", seasonYear: 2020 }),
        expectedKitsuId: "z-1",
        candidates: [
          buildNode({ id: "z-1", title: "Zeta Show" }),
          buildNode({ id: "z-2", title: "Zeta Shows", startDate: "2020-01-01" }),
        ],
      }),
      buildCase({
        hints: buildHints({ titleRomaji: "Alpha Show", seasonYear: 2020 }),
        expectedKitsuId: "a-1",
        candidates: [
          buildNode({ id: "a-1", title: "Alpha Show" }),
          buildNode({ id: "a-2", title: "Alpha Shows", startDate: "2020-01-01" }),
        ],
      }),
      buildCase({
        hints: buildHints({ titleRomaji: "Correct Show", seasonYear: 2020 }),
        expectedKitsuId: "c-1",
        candidates: [buildNode({ id: "c-1", title: "Correct Show", startDate: "2020-01-01" })],
      }),
    ];

    const graded = cases.map(gradeCase);
    const wrong = collectWrongCases(graded);

    expect(wrong.map((w) => w.animeTitle)).toEqual(["Alpha Show", "Zeta Show"]);
    expect(wrong.every((w) => w.selectedKitsuId !== w.expectedKitsuId)).toBe(true);
  });

  test("ranks abstentions by best score, descending, and respects the limit", () => {
    const cases: KitsuMatchingCorpusCase[] = [
      buildCase({
        hints: buildHints({ titleRomaji: "Low Score Show" }),
        expectedKitsuId: "low-1",
        candidates: [buildNode({ id: "low-1", title: "Low Score Show" })],
      }),
      buildCase({
        hints: buildHints({ titleRomaji: "High Score Show", episodeCount: 12 }),
        expectedKitsuId: "high-1",
        // Exact title match (35) plus a near-match episode count (+5) = 40,
        // still under the 45 threshold but higher than the plain title-only case.
        candidates: [buildNode({ id: "high-1", title: "High Score Show", episodeCount: 13 })],
      }),
    ];

    const graded = cases.map(gradeCase);
    const top = collectTopAbstentions(graded, 1);

    expect(top).toHaveLength(1);
    expect(top[0]!.expectedKitsuId).toBe("high-1");
  });
});

describe("passesMinPrecision", () => {
  const baseMetrics = computeMetrics([]);

  test("passes when no threshold is set", () => {
    expect(passesMinPrecision({ ...baseMetrics, precision: null }, null)).toBe(true);
    expect(passesMinPrecision({ ...baseMetrics, precision: 0 }, null)).toBe(true);
  });

  test("passes when precision meets or exceeds the threshold", () => {
    expect(passesMinPrecision({ ...baseMetrics, precision: 0.9 }, 0.9)).toBe(true);
    expect(passesMinPrecision({ ...baseMetrics, precision: 0.95 }, 0.9)).toBe(true);
  });

  test("fails when precision is below the threshold", () => {
    expect(passesMinPrecision({ ...baseMetrics, precision: 0.5 }, 0.9)).toBe(false);
  });

  test("fails closed when precision could not be computed (divide by zero) but a threshold is set", () => {
    expect(passesMinPrecision({ ...baseMetrics, precision: null }, 0.9)).toBe(false);
  });
});

describe("buildEvaluationReport", () => {
  function corpus(cases: KitsuMatchingCorpusCase[]): KitsuMatchingCorpus {
    return { generatedAt: "2026-01-01T00:00:00.000Z", seed: 1, sampleSize: cases.length, cases };
  }

  test("ok reflects the min-precision decision end to end", () => {
    const cases: KitsuMatchingCorpusCase[] = [
      buildCase({
        hints: buildHints({ titleRomaji: "Correct Show", seasonYear: 2020 }),
        expectedKitsuId: "c-1",
        candidates: [buildNode({ id: "c-1", title: "Correct Show", startDate: "2020-01-01" })],
      }),
    ];

    const passingReport = buildEvaluationReport(corpus(cases), 0.5);
    expect(passingReport.ok).toBe(true);
    expect(passingReport.overall.precision).toBe(1);

    const failingReport = buildEvaluationReport(corpus(cases), 1.1);
    expect(failingReport.ok).toBe(false);
  });

  test("ok is true when no threshold is requested, even with zero scored cases", () => {
    const cases: KitsuMatchingCorpusCase[] = [
      buildCase({
        hints: buildHints({ titleRomaji: "Unreachable Show" }),
        expectedKitsuId: "missing",
        candidates: [buildNode({ id: "other", title: "Unrelated" })],
      }),
    ];

    const report = buildEvaluationReport(corpus(cases), null);
    expect(report.ok).toBe(true);
    expect(report.overall.precision).toBeNull();
  });
});
