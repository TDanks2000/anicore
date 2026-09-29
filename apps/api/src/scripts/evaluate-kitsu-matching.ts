import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { KitsuSearchNode } from "@anicore/providers/kitsu/client";

// `matching.ts` is intentionally not exported from @anicore/providers' package.json
// exports map, so it is reached with a relative path into the package's source
// instead of inventing a new public subpath for a one-off measurement script.
import {
  type MatchHints,
  scoreKitsuCandidates,
  selectKitsuMatch,
} from "../../../../packages/providers/src/providers/kitsu/matching";

const DEFAULT_CORPUS_PATH = "data/eval/kitsu-matching-corpus.json";
const DEFAULT_REPORT_PATH = "data/eval/kitsu-matching-report.json";
const TOP_ABSTENTIONS_LIMIT = 20;

export interface KitsuMatchingCorpusCase {
  hints: MatchHints;
  expectedKitsuId: string;
  candidates: KitsuSearchNode[];
}

export interface KitsuMatchingCorpus {
  generatedAt: string;
  seed: number;
  sampleSize: number;
  cases: KitsuMatchingCorpusCase[];
}

/**
 * What the matcher actually did. Reachability is deliberately NOT one of these
 * values: a case whose correct answer was missing from the candidate list can
 * still select a wrong node, and that is a wrong mapping shipped to users, not
 * a search-recall footnote. Folding it into the outcome would overstate
 * precision. Reachability is tracked separately on `expectedReachable`.
 */
export type CaseClassification = "correct" | "wrong" | "abstained";

export interface GradedCase {
  classification: CaseClassification;
  /** False when the correct Kitsu record never appeared in the candidate list. */
  expectedReachable: boolean;
  format: string;
  animeTitle: string;
  expectedKitsuId: string;
  selectedKitsuId: string | null;
  expectedTitle: string | null;
  selectedTitle: string | null;
  expectedScore: number | null;
  selectedScore: number | null;
  bestScore: number | null;
  margin: number | null;
}

export interface Metrics {
  total: number;
  correct: number;
  wrong: number;
  abstained: number;
  unreachable: number;
  precision: number | null;
  recall: number | null;
  abstentionRate: number | null;
  unreachableRate: number | null;
}

export interface FormatMetrics extends Metrics {
  format: string;
}

export interface WrongCaseDetail {
  animeTitle: string;
  format: string;
  expectedKitsuId: string;
  selectedKitsuId: string;
  expectedTitle: string | null;
  selectedTitle: string | null;
  expectedScore: number | null;
  selectedScore: number | null;
  margin: number | null;
}

export interface AbstentionDetail {
  animeTitle: string;
  format: string;
  expectedKitsuId: string;
  bestScore: number | null;
}

export interface EvaluationReport {
  ok: boolean;
  generatedAt: string;
  corpus: { generatedAt: string; seed: number; sampleSize: number };
  minPrecision: number | null;
  overall: Metrics;
  byFormat: FormatMetrics[];
  wrongCases: WrongCaseDetail[];
  topAbstentions: AbstentionDetail[];
}

function titleOf(node: KitsuSearchNode): string {
  return (
    node.titles.romanized ?? node.titles.translated ?? node.titles.original ?? node.slug ?? node.id
  );
}

function normalizeFormatKey(format: string | null | undefined): string {
  return format?.trim() || "UNKNOWN";
}

/**
 * Grades the FUZZY matching path for one corpus case: the AniList id is
 * stripped from the hints so neither `scoreKitsuCandidate`'s authoritative
 * shortcut nor its conflicting-mapping rule can fire, then every candidate is
 * re-scored and `selectKitsuMatch` decides. This is the only place matcher
 * behavior is exercised — everything else here is pure aggregation.
 */
export function gradeCase(testCase: KitsuMatchingCorpusCase): GradedCase {
  const hints: MatchHints = { ...testCase.hints, anilistId: undefined };

  // Must mirror the production path: scoring is candidate-set aware, so grading
  // node-by-node would measure an algorithm that never runs.
  const scored = scoreKitsuCandidates(testCase.candidates, hints);

  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const bestScore = ranked[0]?.score ?? null;

  const expectedEntry = scored.find((entry) => entry.node.id === testCase.expectedKitsuId) ?? null;

  const selectedNode = selectKitsuMatch(scored);
  const selectedEntry = selectedNode
    ? (scored.find((entry) => entry.node.id === selectedNode.id) ?? null)
    : null;

  let classification: CaseClassification;
  if (!selectedNode) {
    classification = "abstained";
  } else if (selectedNode.id === testCase.expectedKitsuId) {
    classification = "correct";
  } else {
    classification = "wrong";
  }

  const expectedScore = expectedEntry?.score ?? null;
  const selectedScore = selectedEntry?.score ?? null;

  return {
    classification,
    expectedReachable: expectedEntry !== null,
    format: normalizeFormatKey(testCase.hints.format),
    animeTitle: testCase.hints.titleRomaji,
    expectedKitsuId: testCase.expectedKitsuId,
    selectedKitsuId: selectedNode?.id ?? null,
    expectedTitle: expectedEntry ? titleOf(expectedEntry.node) : null,
    selectedTitle: selectedEntry ? titleOf(selectedEntry.node) : null,
    expectedScore,
    selectedScore,
    bestScore,
    margin:
      classification === "wrong" && expectedScore !== null && selectedScore !== null
        ? selectedScore - expectedScore
        : null,
  };
}

export function computeMetrics(cases: GradedCase[]): Metrics {
  const total = cases.length;
  const correct = cases.filter((c) => c.classification === "correct").length;
  const wrong = cases.filter((c) => c.classification === "wrong").length;
  const abstained = cases.filter((c) => c.classification === "abstained").length;
  const unreachable = cases.filter((c) => !c.expectedReachable).length;
  const scored = correct + wrong;

  return {
    total,
    correct,
    wrong,
    abstained,
    unreachable,
    precision: scored > 0 ? correct / scored : null,
    recall: total > 0 ? correct / total : null,
    abstentionRate: total > 0 ? abstained / total : null,
    unreachableRate: total > 0 ? unreachable / total : null,
  };
}

export function computeFormatBreakdown(cases: GradedCase[]): FormatMetrics[] {
  const byFormat = new Map<string, GradedCase[]>();
  for (const graded of cases) {
    const list = byFormat.get(graded.format) ?? [];
    list.push(graded);
    byFormat.set(graded.format, list);
  }

  return [...byFormat.keys()].sort().map((format) => ({
    format,
    ...computeMetrics(byFormat.get(format)!),
  }));
}

export function collectWrongCases(cases: GradedCase[]): WrongCaseDetail[] {
  return cases
    .filter(
      (c): c is GradedCase & { selectedKitsuId: string } =>
        c.classification === "wrong" && c.selectedKitsuId !== null,
    )
    .map((c) => ({
      animeTitle: c.animeTitle,
      format: c.format,
      expectedKitsuId: c.expectedKitsuId,
      selectedKitsuId: c.selectedKitsuId,
      expectedTitle: c.expectedTitle,
      selectedTitle: c.selectedTitle,
      expectedScore: c.expectedScore,
      selectedScore: c.selectedScore,
      margin: c.margin,
    }))
    .sort((a, b) => a.animeTitle.localeCompare(b.animeTitle));
}

export function collectTopAbstentions(
  cases: GradedCase[],
  limit = TOP_ABSTENTIONS_LIMIT,
): AbstentionDetail[] {
  return cases
    .filter((c) => c.classification === "abstained")
    .sort((a, b) => (b.bestScore ?? -Infinity) - (a.bestScore ?? -Infinity))
    .slice(0, limit)
    .map((c) => ({
      animeTitle: c.animeTitle,
      format: c.format,
      expectedKitsuId: c.expectedKitsuId,
      bestScore: c.bestScore,
    }));
}

/**
 * A precision that could not be computed (no correct/wrong cases at all)
 * cannot be proven to meet the threshold, so it fails closed rather than
 * silently passing.
 */
export function passesMinPrecision(overall: Metrics, minPrecision: number | null): boolean {
  if (minPrecision === null) return true;
  return overall.precision !== null && overall.precision >= minPrecision;
}

export function buildEvaluationReport(
  corpus: KitsuMatchingCorpus,
  minPrecision: number | null,
): EvaluationReport {
  const graded = corpus.cases.map(gradeCase);
  const overall = computeMetrics(graded);

  return {
    ok: passesMinPrecision(overall, minPrecision),
    generatedAt: new Date().toISOString(),
    corpus: {
      generatedAt: corpus.generatedAt,
      seed: corpus.seed,
      sampleSize: corpus.sampleSize,
    },
    minPrecision,
    overall,
    byFormat: computeFormatBreakdown(graded),
    wrongCases: collectWrongCases(graded),
    topAbstentions: collectTopAbstentions(graded),
  };
}

export interface EvaluateCommandOptions {
  corpusPath: string;
  writePath: string | null;
  minPrecision: number | null;
  verbose: boolean;
}

export function parseEvaluateCommandArgs(
  args: string[],
  cwd = process.cwd(),
): EvaluateCommandOptions {
  let corpusPath = resolve(cwd, DEFAULT_CORPUS_PATH);
  let writePath: string | null = null;
  let minPrecision: number | null = null;
  let verbose = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg.startsWith("--corpus=")) {
      const value = arg.slice("--corpus=".length).trim();
      if (!value) throw new Error("--corpus= requires a non-empty file path");
      corpusPath = isAbsolute(value) ? value : resolve(cwd, value);
      continue;
    }

    if (arg === "--write") {
      const possiblePath = args[index + 1];
      if (possiblePath && !possiblePath.startsWith("-")) {
        writePath = isAbsolute(possiblePath) ? possiblePath : resolve(cwd, possiblePath);
        index += 1;
      } else {
        writePath = resolve(cwd, DEFAULT_REPORT_PATH);
      }
      continue;
    }

    if (arg.startsWith("--write=")) {
      const value = arg.slice("--write=".length).trim();
      if (!value) throw new Error("--write= requires a non-empty file path");
      writePath = isAbsolute(value) ? value : resolve(cwd, value);
      continue;
    }

    if (arg.startsWith("--min-precision=")) {
      const value = Number(arg.slice("--min-precision=".length));
      if (!Number.isFinite(value)) {
        throw new Error(`--min-precision must be a number, received: ${arg}`);
      }
      minPrecision = value;
      continue;
    }

    if (arg === "--verbose") {
      verbose = true;
      continue;
    }

    throw new Error(`Unknown evaluate-kitsu-matching argument: ${arg}`);
  }

  return { corpusPath, writePath, minPrecision, verbose };
}

function isValidCorpusCase(value: unknown): value is KitsuMatchingCorpusCase {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.expectedKitsuId === "string" &&
    Array.isArray(record.candidates) &&
    typeof record.hints === "object" &&
    record.hints !== null
  );
}

function isValidCorpus(value: unknown): value is KitsuMatchingCorpus {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.generatedAt === "string" &&
    typeof record.seed === "number" &&
    typeof record.sampleSize === "number" &&
    Array.isArray(record.cases) &&
    record.cases.every(isValidCorpusCase)
  );
}

export async function loadCorpus(path: string): Promise<KitsuMatchingCorpus> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Corpus file not found: ${path}`);
  }

  const parsed: unknown = JSON.parse(await file.text());
  if (!isValidCorpus(parsed)) {
    throw new Error(`Corpus file is not a valid kitsu-matching corpus: ${path}`);
  }

  return parsed;
}

function formatRate(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatScore(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

export function printReport(report: EvaluationReport, verbose: boolean): void {
  console.log(
    `Kitsu matching evaluation — corpus seed=${report.corpus.seed} sampleSize=${report.corpus.sampleSize}`,
  );
  console.log("");
  console.log("Overall:");
  console.log(
    `  total=${report.overall.total} correct=${report.overall.correct} wrong=${report.overall.wrong} abstained=${report.overall.abstained} unreachable=${report.overall.unreachable}`,
  );
  console.log(
    `  precision=${formatRate(report.overall.precision)} recall=${formatRate(report.overall.recall)} abstentionRate=${formatRate(report.overall.abstentionRate)} unreachableRate=${formatRate(report.overall.unreachableRate)}`,
  );

  console.log("");
  console.log("By format:");
  for (const row of report.byFormat) {
    console.log(
      `  ${row.format.padEnd(10)} total=${row.total} correct=${row.correct} wrong=${row.wrong} abstained=${row.abstained} unreachable=${row.unreachable} precision=${formatRate(row.precision)} recall=${formatRate(row.recall)}`,
    );
  }

  if (verbose) {
    console.log("");
    console.log(`Wrong cases (${report.wrongCases.length}):`);
    for (const wrongCase of report.wrongCases) {
      console.log(
        `  [${wrongCase.format}] "${wrongCase.animeTitle}" — expected ${wrongCase.expectedKitsuId} "${wrongCase.expectedTitle ?? "?"}" (score=${formatScore(wrongCase.expectedScore)}) vs selected ${wrongCase.selectedKitsuId} "${wrongCase.selectedTitle ?? "?"}" (score=${formatScore(wrongCase.selectedScore)}), margin=${formatScore(wrongCase.margin)}`,
      );
    }

    console.log("");
    console.log(`Top abstentions (${report.topAbstentions.length}):`);
    for (const abstention of report.topAbstentions) {
      console.log(
        `  [${abstention.format}] "${abstention.animeTitle}" — expected ${abstention.expectedKitsuId}, bestScore=${formatScore(abstention.bestScore)}`,
      );
    }
  }

  if (report.minPrecision !== null) {
    console.log("");
    console.log(
      `min-precision=${formatRate(report.minPrecision)} -> ${report.ok ? "PASS" : "FAIL"}`,
    );
  }
}

async function main(): Promise<void> {
  const { corpusPath, writePath, minPrecision, verbose } = parseEvaluateCommandArgs(
    Bun.argv.slice(2),
  );

  const corpus = await loadCorpus(corpusPath);
  const report = buildEvaluationReport(corpus, minPrecision);

  printReport(report, verbose);

  if (writePath) {
    await mkdir(dirname(writePath), { recursive: true });
    await Bun.write(writePath, `${JSON.stringify(report, null, 2)}\n`);
    console.error(`Evaluation report written to ${writePath}`);
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
