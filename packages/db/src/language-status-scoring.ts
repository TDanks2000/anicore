export const languageMediaTypes = ["audio", "subtitle"] as const;
export type LanguageMediaType = (typeof languageMediaTypes)[number];

export const animeLanguageStatuses = [
  "unknown",
  "possible",
  "likely",
  "confirmed",
  "partial",
  "not_available",
] as const;
export type AnimeLanguageStatusValue = (typeof animeLanguageStatuses)[number];

export const episodeLanguageStatuses = ["unknown", "available", "missing", "partial"] as const;
export type EpisodeLanguageStatusValue = (typeof episodeLanguageStatuses)[number];

export const languageEvidenceSources = [
  "ann",
  "official_site",
  "provider",
  "home_video",
  "community",
  "manual",
  "other",
] as const;
export type LanguageEvidenceSource = (typeof languageEvidenceSources)[number];

export const languageEvidenceTypes = [
  "voice_cast",
  "provider_audio",
  "provider_subtitle",
  "official_announcement",
  "home_video_release",
  "manual_verified",
  "community_submission",
  "other",
] as const;
export type LanguageEvidenceType = (typeof languageEvidenceTypes)[number];

export type LegacyAudioStatusValue = "unknown" | "unavailable" | "available" | "partial";

export function clampConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.max(0, Math.min(100, Math.round(confidence)));
}

// Deprecated, macro-language and dialect subtags folded into the code the
// rest of the catalogue uses for the same spoken or written language.
const LANGUAGE_ALIASES: Record<string, string> = {
  iw: "he",
  in: "id",
  ji: "yi",
  jw: "jv",
  tl: "fil",
  nb: "no",
  nn: "no",
  cmn: "zh",
  yue: "zh",
};

/**
 * Canonical language key: the primary language subtag only.
 *
 * Providers disagree on regional precision for the same track (AniList says
 * "Portuguese", MAL "Portuguese (BR)", Crunchyroll "pt-BR"), so keeping the
 * region would split one dub into several rows that each look incomplete.
 * Every language is therefore stored and queried by its base subtag.
 */
export function normalizeLanguageCode(languageCode: string): string {
  const normalized = languageCode.trim().toLowerCase().replaceAll("_", "-");
  if (!normalized) throw new Error("languageCode must not be empty");
  const [base] = normalized.split("-");
  if (!base || !/^[a-z]{2,3}$/.test(base)) return normalized;
  return LANGUAGE_ALIASES[base] ?? base;
}

export function defaultEvidenceConfidence(input: {
  source: LanguageEvidenceSource;
  evidenceType: LanguageEvidenceType;
  sourceUrl?: string | null;
}): number {
  if (input.source === "manual" && input.evidenceType === "manual_verified") {
    return 100;
  }

  if (
    input.evidenceType === "provider_audio" ||
    input.evidenceType === "provider_subtitle" ||
    input.evidenceType === "official_announcement"
  ) {
    return 90;
  }

  if (input.evidenceType === "home_video_release" || input.evidenceType === "voice_cast") {
    return 75;
  }

  if (input.evidenceType === "community_submission" && input.sourceUrl) {
    return 50;
  }

  return 20;
}

export function resolveStatusFromConfidence(
  confidence: number,
): Exclude<AnimeLanguageStatusValue, "partial" | "not_available"> {
  const score = clampConfidence(confidence);
  if (score >= 90) return "confirmed";
  if (score >= 65) return "likely";
  if (score >= 40) return "possible";
  return "unknown";
}

export function isExplicitNegativeEvidence(input: {
  source: LanguageEvidenceSource;
  evidenceType: LanguageEvidenceType;
  value: string;
  confidence: number;
}): boolean {
  if (input.source === "community" || input.source === "other") return false;
  if (clampConfidence(input.confidence) < 75) return false;

  return isNegativeValue(input.value);
}

function isNegativeValue(value: string): boolean {
  return [
    "not_available",
    "unavailable",
    "missing",
    "no_dub",
    "no_subtitle",
    "no_subtitles",
    "no_audio",
    "no_language_track",
    "explicitly_not_available",
  ].includes(value.trim().toLowerCase());
}

export function isPartialEvidence(input: { value: string; confidence: number }) {
  const value = input.value.trim().toLowerCase();
  return value === "partial" && clampConfidence(input.confidence) >= 75;
}

export function resolveAnimeStatusFromEvidence(
  evidence: Array<{
    source: LanguageEvidenceSource;
    evidenceType: LanguageEvidenceType;
    value: string;
    confidence: number;
  }>,
): { status: AnimeLanguageStatusValue; confidence: number } {
  if (evidence.length === 0) {
    return { status: "unknown", confidence: 0 };
  }

  const reliableNegative = evidence
    .filter(isExplicitNegativeEvidence)
    .sort((a, b) => clampConfidence(b.confidence) - clampConfidence(a.confidence))[0];

  const partialEvidence = evidence
    .filter(isPartialEvidence)
    .sort((a, b) => clampConfidence(b.confidence) - clampConfidence(a.confidence))[0];

  const positiveEvidence = evidence
    .filter(
      (item) =>
        !isNegativeValue(item.value) &&
        !["partial", "unknown", "scheduled", "announced", "", "null"].includes(
          item.value.trim().toLowerCase(),
        ),
    )
    .sort((a, b) => clampConfidence(b.confidence) - clampConfidence(a.confidence))[0];

  const negativeConfidence = reliableNegative ? clampConfidence(reliableNegative.confidence) : -1;
  const partialConfidence = partialEvidence ? clampConfidence(partialEvidence.confidence) : -1;
  const positiveConfidence = positiveEvidence ? clampConfidence(positiveEvidence.confidence) : -1;

  // Contradictory reliable sources need review; equal scores do not prove absence.
  if (
    negativeConfidence >= 75 &&
    positiveConfidence >= 75 &&
    negativeConfidence === positiveConfidence
  )
    return { status: "unknown", confidence: 0 };
  if (
    negativeConfidence >= 75 &&
    partialConfidence >= 75 &&
    negativeConfidence === partialConfidence
  )
    return { status: "unknown", confidence: 0 };

  if (
    negativeConfidence >= 75 &&
    negativeConfidence >= partialConfidence &&
    negativeConfidence >= positiveConfidence
  ) {
    return { status: "not_available", confidence: negativeConfidence };
  }

  if (partialConfidence >= 75) {
    return { status: "partial", confidence: partialConfidence };
  }

  if (!positiveEvidence) {
    return { status: "unknown", confidence: 0 };
  }

  return {
    status: resolveStatusFromConfidence(positiveConfidence),
    confidence: positiveConfidence,
  };
}

export function resolveAnimeStatus(input: {
  manualOverride?: {
    status: AnimeLanguageStatusValue;
    confidence: number;
  } | null;
  evidence: Parameters<typeof resolveAnimeStatusFromEvidence>[0];
}): { status: AnimeLanguageStatusValue; confidence: number } {
  if (input.manualOverride) {
    return {
      status: input.manualOverride.status,
      confidence: clampConfidence(input.manualOverride.confidence),
    };
  }

  return resolveAnimeStatusFromEvidence(input.evidence);
}

export interface EpisodeStatusVote {
  episodeNumber: number;
  status: EpisodeLanguageStatusValue;
  confidence: number;
  provider: string;
}

/**
 * One status per episode across providers: a manual verification wins, then
 * the most confident known status. Equally confident providers that disagree
 * on presence leave the episode unknown rather than picking a side.
 */
export function resolveEpisodeStatuses(rows: EpisodeStatusVote[]): EpisodeStatusVote[] {
  const byEpisode = new Map<number, EpisodeStatusVote[]>();
  for (const row of rows)
    byEpisode.set(row.episodeNumber, [...(byEpisode.get(row.episodeNumber) ?? []), row]);
  return [...byEpisode]
    .sort(([a], [b]) => a - b)
    .map(([episodeNumber, votes]) => {
      const manual = votes.filter((vote) => vote.provider === "manual");
      const known = votes.filter((vote) => vote.status !== "unknown");
      const candidates = (manual.length ? manual : known.length ? known : votes).sort(
        (a, b) =>
          clampConfidence(b.confidence) - clampConfidence(a.confidence) ||
          a.provider.localeCompare(b.provider),
      );
      const best = candidates[0]!;
      const tied = new Set(
        candidates
          .filter((vote) => clampConfidence(vote.confidence) === clampConfidence(best.confidence))
          .map((vote) => vote.status),
      );
      if (tied.has("missing") && (tied.has("available") || tied.has("partial")))
        return {
          episodeNumber,
          status: "unknown" as const,
          confidence: 0,
          provider: best.provider,
        };
      return {
        episodeNumber,
        status: tied.has("partial") ? ("partial" as const) : best.status,
        confidence: clampConfidence(best.confidence),
        provider: best.provider,
      };
    });
}

export function summarizeEpisodeCoverage(
  resolved: EpisodeStatusVote[],
  episodeNumbers: number[],
): { totalEpisodes: number; available: number; missing: number; unknown: number } {
  const canonical = new Set(episodeNumbers);
  const relevant = resolved.filter((row) => canonical.has(row.episodeNumber));
  const available = relevant.filter(
    (row) => row.status === "available" || row.status === "partial",
  ).length;
  const missing = relevant.filter((row) => row.status === "missing").length;
  return {
    totalEpisodes: canonical.size,
    available,
    missing,
    unknown: canonical.size - available - missing,
  };
}

export function mapLegacyAudioStatusToEpisodeStatus(
  status: LegacyAudioStatusValue,
): EpisodeLanguageStatusValue {
  if (status === "unavailable") return "missing";
  return status;
}

export interface LegacyEpisodeLike {
  id: number;
}

export interface EpisodeLanguageStatusLike {
  languageCode: string;
  mediaType: LanguageMediaType;
  status: EpisodeLanguageStatusValue;
  provider: string;
}

export function toLegacyEpisodeAudioResponse<T extends EpisodeLanguageStatusLike>(
  episode: LegacyEpisodeLike,
  rows: T[],
) {
  return rows
    .filter((row) => row.mediaType === "audio")
    .map((row) => ({
      ...row,
      episodeId: episode.id,
      audioMode: row.languageCode === "ja" ? "original" : "dub",
      locale: row.languageCode,
      status: row.status === "missing" ? "unavailable" : row.status,
      sourceProvider: row.provider,
    }));
}
