import type {
  AnimeLanguageStatusRow,
  EpisodeLanguageStatusRow,
  LanguageMediaType,
} from "./anime-api";

export type LanguageStatusTone =
  | "success"
  | "default"
  | "warning"
  | "secondary"
  | "outline"
  | "destructive";

const ANIME_STATUS_LABELS: Record<string, string> = {
  unknown: "Unknown",
  possible: "Possible",
  likely: "Likely",
  confirmed: "Confirmed",
  partial: "Partial",
  not_available: "Not available",
};

const EPISODE_STATUS_LABELS: Record<string, string> = {
  unknown: "Unknown",
  available: "Available",
  missing: "Missing",
  partial: "Partial",
};

export function animeLanguageStatusLabel(status: string): string {
  return ANIME_STATUS_LABELS[status] ?? status;
}

export function animeLanguageStatusTone(status: string): LanguageStatusTone {
  switch (status) {
    case "confirmed":
      return "success";
    case "likely":
      return "default";
    case "possible":
      return "outline";
    case "partial":
      return "warning";
    case "not_available":
      return "secondary";
    default:
      return "outline";
  }
}

export function episodeLanguageStatusLabel(status: string): string {
  return EPISODE_STATUS_LABELS[status] ?? status;
}

export function episodeLanguageStatusTone(
  status: string,
): "success" | "warning" | "destructive" | "outline" {
  switch (status) {
    case "available":
      return "success";
    case "partial":
      return "warning";
    case "missing":
      return "destructive";
    default:
      return "outline";
  }
}

/** Human-readable language name for a BCP-47-ish code, English names always. */
export function formatLanguageName(code: string): string {
  try {
    const name = new Intl.DisplayNames("en", { type: "language" }).of(code);
    // Unknown codes are echoed back unchanged; show them uppercased instead.
    if (name && name.toLowerCase() !== code.toLowerCase()) return name;
  } catch {
    // Malformed code; fall through to the uppercase form.
  }
  return code.toUpperCase();
}

export interface LanguageCoverage {
  languageCode: string;
  audio: AnimeLanguageStatusRow | null;
  subtitle: AnimeLanguageStatusRow | null;
}

export function groupAnimeLanguageStatuses(statuses: AnimeLanguageStatusRow[]): LanguageCoverage[] {
  const byLanguage = new Map<string, LanguageCoverage>();
  for (const row of statuses) {
    const entry = byLanguage.get(row.languageCode) ?? {
      languageCode: row.languageCode,
      audio: null,
      subtitle: null,
    };
    if (row.mediaType === "audio") entry.audio = row;
    else entry.subtitle = row;
    byLanguage.set(row.languageCode, entry);
  }
  return [...byLanguage.values()].sort((a, b) => a.languageCode.localeCompare(b.languageCode));
}

/** Every language that has any anime- or episode-level status recorded. */
export function episodeLanguages(
  rows: EpisodeLanguageStatusRow[],
  statuses: AnimeLanguageStatusRow[],
): string[] {
  const codes = new Set<string>();
  for (const row of statuses) codes.add(row.languageCode);
  for (const row of rows) codes.add(row.languageCode);
  return [...codes].sort((a, b) => a.localeCompare(b));
}

export function episodeStatusKey(
  episodeNumber: number,
  languageCode: string,
  mediaType: LanguageMediaType,
): string {
  return `${episodeNumber}|${languageCode}|${mediaType}`;
}

export function buildEpisodeStatusMap(
  rows: EpisodeLanguageStatusRow[],
): Map<string, EpisodeLanguageStatusRow> {
  const grouped = new Map<string, EpisodeLanguageStatusRow[]>();
  for (const row of rows) {
    const key = episodeStatusKey(row.episodeNumber, row.languageCode, row.mediaType);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return new Map(
    [...grouped].map(([key, evidence]) => {
      const manual = evidence.filter((row) => row.provider === "manual");
      const known = evidence.filter((row) => row.status !== "unknown");
      const candidates = (manual.length ? manual : known.length ? known : evidence).sort(
        (a, b) =>
          b.confidence - a.confidence || a.provider.localeCompare(b.provider) || a.id - b.id,
      );
      const best = candidates[0]!;
      const tied = candidates.filter((row) => row.confidence === best.confidence);
      const states = new Set(tied.map((row) => row.status));
      if (states.has("missing") && (states.has("available") || states.has("partial")))
        return [key, { ...best, status: "unknown", confidence: 0 }];
      return [key, { ...best, status: states.has("partial") ? "partial" : best.status }];
    }),
  );
}

export interface EpisodeCoverage {
  available: number;
  total: number;
  known: number;
}

/** Episodes with confirmed or partial coverage of a language and medium. */
export function episodeCoverage(
  rows: EpisodeLanguageStatusRow[],
  languageCode: string,
  mediaType: LanguageMediaType,
  totalEpisodes: number,
  episodeNumbers?: Set<number>,
): EpisodeCoverage {
  const resolved = [...buildEpisodeStatusMap(rows).values()].filter(
    (row) =>
      row.languageCode === languageCode &&
      row.mediaType === mediaType &&
      (episodeNumbers
        ? episodeNumbers.has(row.episodeNumber)
        : row.episodeNumber > 0 && row.episodeNumber <= totalEpisodes),
  );
  const available = resolved.filter(
    (row) => row.status === "available" || row.status === "partial",
  ).length;
  const known = resolved.filter((row) => row.status !== "unknown").length;
  return { available, total: totalEpisodes, known };
}

export function languageEvidenceSource(sourceUrl: string | null, source: string): string {
  if (sourceUrl?.startsWith("https://anilist.co/")) return "AniList voice cast";
  if (sourceUrl?.startsWith("https://api.jikan.moe/")) return "MyAnimeList voice cast";
  if (sourceUrl?.startsWith("https://animeschedule.net/")) return "AnimeSchedule";
  if (sourceUrl?.startsWith("https://kitsu.io/")) return "Kitsu streaming catalogue";
  if (sourceUrl?.startsWith("https://www.crunchyroll.com/")) return "Crunchyroll episode tracks";
  if (sourceUrl?.includes(":derived-airdate")) return "Original audio inferred from air date";
  return source === "manual" ? "Manual verification" : source.replaceAll("_", " ");
}

export function evidenceLink(sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  try {
    const url = new URL(sourceUrl);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
