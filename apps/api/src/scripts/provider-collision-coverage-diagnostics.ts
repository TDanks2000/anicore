export type CoverageProvider = "thetvdb" | "tmdb";

export interface CoverageDiagnosticRow {
  episodeMappingId: number;
  animeId: number;
  provider: CoverageProvider;
  localEpisodeNumber: number;
  localNormalEpisodeCount: number;
  providerEpisodeNumber: string | null;
}

export type CoverageGapPosition =
  | "complete"
  | "trailing"
  | "leading"
  | "both-ends"
  | "internal-or-nonlinear";

export interface CoverageGroupDiagnostic {
  animeId: number;
  provider: CoverageProvider;
  expectedLocalEpisodeCount: number | null;
  mappedEpisodeCount: number;
  localEpisodeStart: number | null;
  localEpisodeEnd: number | null;
  providerEpisodeStart: number | null;
  providerEpisodeEnd: number | null;
  missingLocalEpisodeNumbers: number[];
  missingLocalEpisodeCount: number;
  completeCoverage: boolean;
  evidenceBackedLinear: boolean;
  offset: number | null;
  gapPosition: CoverageGapPosition;
  invalidReason:
    | "invalid-expected-count"
    | "invalid-local-number"
    | "invalid-provider-number"
    | "duplicate-local-number"
    | "duplicate-provider-number"
    | null;
}

function positiveInteger(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function analyzeCollisionCoverageGroup(
  rows: CoverageDiagnosticRow[],
): CoverageGroupDiagnostic {
  if (rows.length === 0) {
    throw new Error("Cannot diagnose an empty provider collision group");
  }

  const first = rows[0]!;
  const expectedCounts = new Set(
    rows.map((row) => positiveInteger(row.localNormalEpisodeCount)),
  );
  if (expectedCounts.has(null) || expectedCounts.size !== 1) {
    return invalid(first, rows.length, "invalid-expected-count");
  }
  const expectedLocalEpisodeCount = [...expectedCounts][0]!;

  const normalized = rows.map((row) => ({
    local: positiveInteger(row.localEpisodeNumber),
    provider: positiveInteger(row.providerEpisodeNumber),
  }));
  if (normalized.some((row) => row.local === null)) {
    return invalid(
      first,
      rows.length,
      "invalid-local-number",
      expectedLocalEpisodeCount,
    );
  }
  if (normalized.some((row) => row.provider === null)) {
    return invalid(
      first,
      rows.length,
      "invalid-provider-number",
      expectedLocalEpisodeCount,
    );
  }

  const ordered = normalized
    .map((row) => ({ local: row.local!, provider: row.provider! }))
    .sort((a, b) => a.local - b.local || a.provider - b.provider);
  const localNumbers = ordered.map((row) => row.local);
  const providerNumbers = ordered.map((row) => row.provider);

  if (new Set(localNumbers).size !== localNumbers.length) {
    return invalid(
      first,
      rows.length,
      "duplicate-local-number",
      expectedLocalEpisodeCount,
    );
  }
  if (new Set(providerNumbers).size !== providerNumbers.length) {
    return invalid(
      first,
      rows.length,
      "duplicate-provider-number",
      expectedLocalEpisodeCount,
    );
  }

  const mappedLocalSet = new Set(localNumbers);
  const missingLocalEpisodeNumbers: number[] = [];
  for (let number = 1; number <= expectedLocalEpisodeCount; number += 1) {
    if (!mappedLocalSet.has(number)) missingLocalEpisodeNumbers.push(number);
  }

  const localEpisodeStart = localNumbers[0] ?? null;
  const localEpisodeEnd = localNumbers[localNumbers.length - 1] ?? null;
  const providerEpisodeStart = providerNumbers[0] ?? null;
  const providerEpisodeEnd = providerNumbers[providerNumbers.length - 1] ?? null;

  const localContiguous = localNumbers.every(
    (number, index) => index === 0 || number === localNumbers[index - 1]! + 1,
  );
  const providerContiguous = providerNumbers.every(
    (number, index) =>
      index === 0 || number === providerNumbers[index - 1]! + 1,
  );
  const offset =
    localEpisodeStart !== null && providerEpisodeStart !== null
      ? providerEpisodeStart - localEpisodeStart
      : null;
  const constantOffset =
    offset !== null &&
    ordered.every((row) => row.provider - row.local === offset);
  const evidenceBackedLinear =
    localContiguous && providerContiguous && constantOffset;

  const completeCoverage =
    missingLocalEpisodeNumbers.length === 0 &&
    localEpisodeStart === 1 &&
    localEpisodeEnd === expectedLocalEpisodeCount;

  let gapPosition: CoverageGapPosition = "internal-or-nonlinear";
  if (completeCoverage) {
    gapPosition = "complete";
  } else if (evidenceBackedLinear && localEpisodeStart !== null && localEpisodeEnd !== null) {
    if (localEpisodeStart === 1 && localEpisodeEnd < expectedLocalEpisodeCount) {
      gapPosition = "trailing";
    } else if (
      localEpisodeStart > 1 &&
      localEpisodeEnd === expectedLocalEpisodeCount
    ) {
      gapPosition = "leading";
    } else if (
      localEpisodeStart > 1 &&
      localEpisodeEnd < expectedLocalEpisodeCount
    ) {
      gapPosition = "both-ends";
    }
  }

  return {
    animeId: first.animeId,
    provider: first.provider,
    expectedLocalEpisodeCount,
    mappedEpisodeCount: rows.length,
    localEpisodeStart,
    localEpisodeEnd,
    providerEpisodeStart,
    providerEpisodeEnd,
    missingLocalEpisodeNumbers,
    missingLocalEpisodeCount: missingLocalEpisodeNumbers.length,
    completeCoverage,
    evidenceBackedLinear,
    offset: evidenceBackedLinear ? offset : null,
    gapPosition,
    invalidReason: null,
  };
}

function invalid(
  first: CoverageDiagnosticRow,
  mappedEpisodeCount: number,
  invalidReason: NonNullable<CoverageGroupDiagnostic["invalidReason"]>,
  expectedLocalEpisodeCount: number | null = null,
): CoverageGroupDiagnostic {
  return {
    animeId: first.animeId,
    provider: first.provider,
    expectedLocalEpisodeCount,
    mappedEpisodeCount,
    localEpisodeStart: null,
    localEpisodeEnd: null,
    providerEpisodeStart: null,
    providerEpisodeEnd: null,
    missingLocalEpisodeNumbers: [],
    missingLocalEpisodeCount: 0,
    completeCoverage: false,
    evidenceBackedLinear: false,
    offset: null,
    gapPosition: "internal-or-nonlinear",
    invalidReason,
  };
}
