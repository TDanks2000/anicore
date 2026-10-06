import { expect, test } from "bun:test";
import { buildEvaluationReport, parseEvaluateCommandArgs } from "./evaluate-kitsu-matching";
import { corpusCohort, stratifiedSample } from "./evaluate-kitsu-matching-corpus";

test("coverage sampling retains rare film, special, sequel and segmented cohorts", () => {
  const rows = Array.from({ length: 100 }, (_, id) => ({
    animeId: id,
    titleRomaji: "Base title",
    titleEnglish: null,
    titleNative: null,
    synonymsJson: "[]",
    season: null,
    seasonYear: null,
    startDate: null,
    episodeCount: 12,
    format: "TV",
    anilistId: String(id),
    expectedKitsuId: String(id),
    hasSegments: 0,
  }));
  rows[0]!.format = "MOVIE";
  rows[1]!.format = "SPECIAL";
  rows[2]!.titleRomaji = "Title II";
  rows[3]!.hasSegments = 1;
  const sample = stratifiedSample(rows, 5, 7, true);
  expect(sample).toHaveLength(5);
  expect(new Set(sample.map(corpusCohort)).size).toBe(5);
  expect(stratifiedSample(rows, 5, 7, true)).toEqual(sample);
  expect(() => stratifiedSample(rows, 4, 7, true)).toThrow("at least 5");
});

test("cohort gates fail closed when no labelled cases are available", () => {
  const options = parseEvaluateCommandArgs([
    "--min-cohort-precision=0.99",
    "--min-cohort-cases=10",
  ]);
  expect(options.cohortGate).toEqual({ minPrecision: 0.99, minCases: 10 });
  const corpus = { generatedAt: "2026-01-01", seed: 7, sampleSize: 0, cases: [] };
  expect(buildEvaluationReport(corpus, null, options.cohortGate).ok).toBe(false);
  expect(() => parseEvaluateCommandArgs(["--min-cohort-precision=1.1"])).toThrow();
});
