import type { AnimeEpisode, EpisodeLanguageStatusRow, LanguageMediaType } from "./anime-api";
import { buildEpisodeStatusMap } from "./language-status";

/** Summarize recorded normal episodes without treating a sparse catalogue as complete. */
export function inspectCoverage(
  episodes: Pick<AnimeEpisode, "number" | "kind">[],
  rows: EpisodeLanguageStatusRow[],
  languageCode: string,
  mediaType: LanguageMediaType,
  expectedEpisodes: number | null,
) {
  const canonical = new Set(
    episodes.filter((episode) => episode.kind === "normal").map((e) => e.number),
  );
  const resolved = [...buildEpisodeStatusMap(rows).values()].filter(
    (row) =>
      canonical.has(row.episodeNumber) &&
      row.languageCode === languageCode &&
      row.mediaType === mediaType,
  );
  const available = resolved.filter(
    (row) => row.status === "available" || row.status === "partial",
  ).length;
  const partial = resolved.filter((row) => row.status === "partial").length;
  const missing = resolved.filter((row) => row.status === "missing").length;
  const unknown = canonical.size - available - missing;
  const expected =
    expectedEpisodes !== null && Number.isInteger(expectedEpisodes) && expectedEpisodes > 0
      ? expectedEpisodes
      : null;
  const fullCatalogue =
    expected !== null &&
    canonical.size === expected &&
    [...canonical].every((number) => Number.isInteger(number) && number >= 1 && number <= expected);
  return {
    recorded: canonical.size,
    expected,
    available,
    partial,
    missing,
    unknown,
    complete: fullCatalogue && available === canonical.size && partial === 0,
    unrecorded: expected === null ? null : Math.max(0, expected - canonical.size),
  };
}
