import { titleSimilarity } from "@anicore/providers/title-similarity";

export const MIN_PROVIDER_TITLE_SIMILARITY = 0.72;

export interface AnimeIdentityMetadata {
  titleRomaji: string;
  titleEnglish: string | null;
  titleNative: string | null;
  titleUserPreferred: string | null;
  synonymsJson: string;
  episodeCount: number | null;
}

export interface ProviderSeasonIdentityInput {
  anime: AnimeIdentityMetadata;
  authoritativeEpisodeCount: number;
  providerTitles: string[];
}

export type ProviderSeasonIdentityRejectReason =
  | "target-metadata-count-mismatch"
  | "provider-title-unavailable"
  | "provider-title-mismatch";

export interface ProviderSeasonIdentityResult {
  ok: boolean;
  reason: ProviderSeasonIdentityRejectReason | null;
  targetTitles: string[];
  providerTitles: string[];
  bestTargetTitle: string | null;
  bestProviderTitle: string | null;
  bestTitleSimilarity: number;
}

function parseSynonyms(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  } catch {
    return [];
  }
}

function uniqueTitles(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(trimmed);
  }
  return titles;
}

export function animeIdentityTitles(meta: AnimeIdentityMetadata): string[] {
  return uniqueTitles([
    meta.titleRomaji,
    meta.titleEnglish,
    meta.titleNative,
    meta.titleUserPreferred,
    ...parseSynonyms(meta.synonymsJson),
  ]);
}

export function verifyProviderSeasonIdentity(
  input: ProviderSeasonIdentityInput,
): ProviderSeasonIdentityResult {
  const targetTitles = animeIdentityTitles(input.anime);
  const providerTitles = uniqueTitles(input.providerTitles);

  if (
    input.anime.episodeCount === null ||
    input.anime.episodeCount !== input.authoritativeEpisodeCount
  ) {
    return {
      ok: false,
      reason: "target-metadata-count-mismatch",
      targetTitles,
      providerTitles,
      bestTargetTitle: null,
      bestProviderTitle: null,
      bestTitleSimilarity: 0,
    };
  }

  if (providerTitles.length === 0) {
    return {
      ok: false,
      reason: "provider-title-unavailable",
      targetTitles,
      providerTitles,
      bestTargetTitle: null,
      bestProviderTitle: null,
      bestTitleSimilarity: 0,
    };
  }

  let bestTitleSimilarity = 0;
  let bestTargetTitle: string | null = null;
  let bestProviderTitle: string | null = null;
  for (const providerTitle of providerTitles) {
    for (const targetTitle of targetTitles) {
      const score = titleSimilarity(providerTitle, targetTitle);
      if (score > bestTitleSimilarity) {
        bestTitleSimilarity = score;
        bestTargetTitle = targetTitle;
        bestProviderTitle = providerTitle;
      }
    }
  }

  if (bestTitleSimilarity < MIN_PROVIDER_TITLE_SIMILARITY) {
    return {
      ok: false,
      reason: "provider-title-mismatch",
      targetTitles,
      providerTitles,
      bestTargetTitle,
      bestProviderTitle,
      bestTitleSimilarity,
    };
  }

  return {
    ok: true,
    reason: null,
    targetTitles,
    providerTitles,
    bestTargetTitle,
    bestProviderTitle,
    bestTitleSimilarity,
  };
}
