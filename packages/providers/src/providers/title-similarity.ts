export function normalizeComparableTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenJaccard(a: string, b: string): number {
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection++;
  }

  const union = new Set([...aTokens, ...bTokens]).size;
  return union ? intersection / union : 0;
}

function ngrams(value: string, size = 3): Set<string> {
  const compact = value.replace(/\s+/g, " ");
  if (!compact) return new Set();
  if (compact.length <= size) return new Set([compact]);

  const grams = new Set<string>();
  for (let index = 0; index <= compact.length - size; index++) {
    grams.add(compact.slice(index, index + size));
  }
  return grams;
}

function diceCoefficient(a: string, b: string): number {
  const aGrams = ngrams(a);
  const bGrams = ngrams(b);
  if (!aGrams.size || !bGrams.size) return 0;

  let intersection = 0;
  for (const gram of aGrams) {
    if (bGrams.has(gram)) intersection++;
  }

  return (2 * intersection) / (aGrams.size + bGrams.size);
}

/**
 * Conservative title similarity for identity matching.
 *
 * Exact normalized titles score 1. Otherwise we combine token-set overlap with
 * character trigrams. Token Jaccard avoids the old short-title failure where a
 * single shared word in two two-word titles scored 50%, while trigrams retain
 * tolerance for small spelling/transliteration differences.
 */
export function titleSimilarity(a: string, b: string): number {
  const normalizedA = normalizeComparableTitle(a);
  const normalizedB = normalizeComparableTitle(b);
  if (!normalizedA || !normalizedB) return 0;
  if (normalizedA === normalizedB) return 1;

  return Math.max(
    tokenJaccard(normalizedA, normalizedB),
    diceCoefficient(normalizedA, normalizedB),
  );
}
