export type MappingSource = "manual" | "api" | "import" | "fuzzy" | "system";

/**
 * Shared confidence levels for identity mappings.
 *
 * 100: identity is directly verified or explicitly curated.
 * 90: strong fuzzy match with multiple agreeing signals.
 * 85: heuristic season/episode-source match that is useful but must remain
 *     visibly weaker than a direct cross-reference.
 */
export const MAPPING_CONFIDENCE = {
  curated: 100,
  authoritative: 100,
  strongFuzzy: 90,
  heuristicFuzzy: 85,
} as const;

export const MAPPING_SOURCE_PRIORITY: Readonly<Record<MappingSource, number>> = {
  manual: 5,
  system: 4,
  api: 3,
  import: 3,
  fuzzy: 1,
};

export function compareMappingStrength(
  a: { source: MappingSource; confidence: number },
  b: { source: MappingSource; confidence: number },
): number {
  const sourceDifference =
    MAPPING_SOURCE_PRIORITY[a.source] - MAPPING_SOURCE_PRIORITY[b.source];
  if (sourceDifference !== 0) return sourceDifference;
  return a.confidence - b.confidence;
}

export function isAuthoritativeMapping(input: {
  source: MappingSource;
  confidence: number;
}): boolean {
  return (
    input.confidence >= MAPPING_CONFIDENCE.authoritative &&
    input.source !== "fuzzy"
  );
}
