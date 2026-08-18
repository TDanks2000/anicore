export type ProviderLocalCountMismatchClassification =
  | "local-short-metadata-exact"
  | "local-long-metadata-exact"
  | "local-mismatch-metadata-missing"
  | "local-mismatch-metadata-differs";

export interface ProviderLocalCountMismatchResult {
  classification: ProviderLocalCountMismatchClassification;
  authoritativeEpisodeCount: number;
  localNormalEpisodeCount: number;
  metadataEpisodeCount: number | null;
  missingLocalNumbers: number[];
  extraLocalNumbers: number[];
  localNormalNumbersContiguousFromOne: boolean;
}

function contiguousOneToN(values: number[]): boolean {
  const sorted = [...values].sort((a, b) => a - b);
  if (new Set(sorted).size !== sorted.length) return false;
  return sorted.every((value, index) => value === index + 1);
}

export function classifyProviderLocalCountMismatch(input: {
  authoritativeEpisodeNumbers: number[];
  targetLocalNormalEpisodeNumbers: number[];
  targetMetadataEpisodeCount: number | null;
}): ProviderLocalCountMismatchResult | null {
  const authoritative = [...input.authoritativeEpisodeNumbers].sort((a, b) => a - b);
  const local = [...input.targetLocalNormalEpisodeNumbers].sort((a, b) => a - b);

  if (authoritative.length === local.length) return null;

  const authoritativeSet = new Set(authoritative);
  const localSet = new Set(local);
  const missingLocalNumbers = authoritative.filter((number) => !localSet.has(number));
  const extraLocalNumbers = local.filter((number) => !authoritativeSet.has(number));

  let classification: ProviderLocalCountMismatchClassification;
  if (input.targetMetadataEpisodeCount == null) {
    classification = "local-mismatch-metadata-missing";
  } else if (input.targetMetadataEpisodeCount !== authoritative.length) {
    classification = "local-mismatch-metadata-differs";
  } else if (local.length < authoritative.length) {
    classification = "local-short-metadata-exact";
  } else {
    classification = "local-long-metadata-exact";
  }

  return {
    classification,
    authoritativeEpisodeCount: authoritative.length,
    localNormalEpisodeCount: local.length,
    metadataEpisodeCount: input.targetMetadataEpisodeCount,
    missingLocalNumbers,
    extraLocalNumbers,
    localNormalNumbersContiguousFromOne: contiguousOneToN(local),
  };
}
