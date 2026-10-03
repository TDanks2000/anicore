import type { AnimeEpisode, AnimeListItem } from "./anime-api";

export interface AnimeOption {
  value: string;
  label: string;
}

export const ANIME_FORMAT_OPTIONS: readonly AnimeOption[] = [
  { value: "TV", label: "TV" },
  { value: "TV_SHORT", label: "TV Short" },
  { value: "MOVIE", label: "Movie" },
  { value: "SPECIAL", label: "Special" },
  { value: "OVA", label: "OVA" },
  { value: "ONA", label: "ONA" },
  { value: "MUSIC", label: "Music" },
];

export const ANIME_STATUS_OPTIONS: readonly AnimeOption[] = [
  { value: "FINISHED", label: "Finished" },
  { value: "RELEASING", label: "Releasing" },
  { value: "NOT_YET_RELEASED", label: "Not yet released" },
  { value: "HIATUS", label: "Hiatus" },
  { value: "CANCELLED", label: "Cancelled" },
];

export const ANIME_SEASON_OPTIONS: readonly AnimeOption[] = [
  { value: "WINTER", label: "Winter" },
  { value: "SPRING", label: "Spring" },
  { value: "SUMMER", label: "Summer" },
  { value: "FALL", label: "Fall" },
];

function optionLabel(options: readonly AnimeOption[], value: string | null): string | null {
  if (!value) return null;
  return options.find((option) => option.value === value)?.label ?? value;
}

export function animeFormatLabel(value: string | null): string {
  return optionLabel(ANIME_FORMAT_OPTIONS, value) ?? "—";
}

export function animeStatusLabel(value: string | null): string {
  return optionLabel(ANIME_STATUS_OPTIONS, value) ?? "—";
}

export function animeSeasonLabel(value: string | null): string | null {
  return optionLabel(ANIME_SEASON_OPTIONS, value);
}

export function formatSeasonYear(season: string | null, year: number | null): string {
  const seasonLabel = animeSeasonLabel(season);
  if (seasonLabel && year !== null) return `${seasonLabel} ${year}`;
  if (seasonLabel) return seasonLabel;
  if (year !== null) return String(year);
  return "—";
}

/** The best alternative title to show under the romaji title, if any. */
export function animeSecondaryTitle(
  item: Pick<AnimeListItem, "titleRomaji" | "titleEnglish" | "titleNative">,
): string | null {
  for (const title of [item.titleEnglish, item.titleNative]) {
    if (title && title !== item.titleRomaji) return title;
  }
  return null;
}

const PROVIDER_LABELS: Record<string, string> = {
  anilist: "AniList",
  kitsu: "Kitsu",
  thetvdb: "TheTVDB",
  mal: "MyAnimeList",
  tmdb: "TMDB",
  simkl: "Simkl",
  anisearch: "AniSearch",
  animeplanet: "Anime-Planet",
  animeschedule: "AnimeSchedule",
  crunchyroll: "Crunchyroll",
  other: "Other",
};

export function animeProviderLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

export type AnimeScoreTone = "success" | "primary" | "warning" | "muted";

export function animeScoreTone(score: number | null): AnimeScoreTone {
  if (score === null) return "muted";
  if (score >= 75) return "success";
  if (score >= 60) return "primary";
  if (score >= 40) return "warning";
  return "muted";
}

export type AnimeFormatVariant = "default" | "secondary" | "outline";

export function animeFormatVariant(format: string | null): AnimeFormatVariant {
  if (format === "TV") return "default";
  if (format === "MOVIE") return "secondary";
  return "outline";
}

export type AnimeStatusVariant = "success" | "secondary" | "warning" | "destructive" | "outline";

export function animeStatusVariant(status: string | null): AnimeStatusVariant {
  switch (status) {
    case "RELEASING":
      return "success";
    case "FINISHED":
      return "secondary";
    case "NOT_YET_RELEASED":
    case "HIATUS":
      return "warning";
    case "CANCELLED":
      return "destructive";
    default:
      return "outline";
  }
}

/**
 * Provider descriptions carry simple HTML (`<br>`, `<i>`). Strip tags and turn
 * line breaks into newlines instead of injecting provider HTML into the page.
 */
export function animeDescriptionText(description: string | null): string | null {
  if (!description) return null;
  const text = description
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
  return text || null;
}

export function animeEpisodeTitle(
  episode: Pick<AnimeEpisode, "number" | "title" | "titleEnglish" | "titleRomaji">,
): string {
  return (
    episode.title ?? episode.titleEnglish ?? episode.titleRomaji ?? `Episode ${episode.number}`
  );
}

/** Newest first, plus one year ahead for announced seasons. */
export function animeYearOptions(currentYear = new Date().getFullYear()): number[] {
  const years: number[] = [];
  for (let year = currentYear + 1; year >= 1940; year--) years.push(year);
  return years;
}

/** "eps 50–59 → 1–10" style label for a provider episode range. */
export function segmentRangeLabel(segment: {
  providerEpisodeStart: number;
  providerEpisodeEnd: number;
  localEpisodeStart: number;
  localEpisodeEnd: number;
}): string {
  const range = (start: number, end: number) => (start === end ? `${start}` : `${start}–${end}`);
  const provider = range(segment.providerEpisodeStart, segment.providerEpisodeEnd);
  const local = range(segment.localEpisodeStart, segment.localEpisodeEnd);
  return provider === local ? `eps ${local}` : `eps ${provider} → ${local}`;
}
