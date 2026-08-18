export type ProviderSeasonOwnershipClassification =
  | "owner-then-orphan-adjacent"
  | "orphan-then-owner-adjacent"
  | "owner-orphan-with-gap"
  | "fragmented-between-owner-and-orphan"
  | "orphan-only"
  | "owner-only"
  | "other-anime-involved"
  | "unmapped-only";

export interface ProviderSeasonEpisodeOwnership {
  providerEpisodeId: string;
  providerEpisodeNumber: number;
  animeId: number | null;
}

export interface ProviderSeasonOwnershipDiagnostic {
  classification: ProviderSeasonOwnershipClassification;
  providerEpisodeStart: number | null;
  providerEpisodeEnd: number | null;
  orphanOwnedEpisodeCount: number;
  ownerOwnedEpisodeCount: number;
  otherAnimeOwnedEpisodeCount: number;
  unmappedEpisodeCount: number;
  orphanRanges: string[];
  ownerRanges: string[];
  unmappedRanges: string[];
  otherAnimeIds: number[];
}

function contiguousRanges(numbers: number[]): Array<[number, number]> {
  const sorted = [...new Set(numbers)]
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  let start = sorted[0]!;
  let end = start;
  for (const value of sorted.slice(1)) {
    if (value === end + 1) {
      end = value;
      continue;
    }
    ranges.push([start, end]);
    start = value;
    end = value;
  }
  ranges.push([start, end]);
  return ranges;
}

function formatRanges(ranges: Array<[number, number]>): string[] {
  return ranges.map(([start, end]) => (start === end ? String(start) : `${start}-${end}`));
}

export function classifyProviderSeasonOwnership(
  episodes: ProviderSeasonEpisodeOwnership[],
  orphanAnimeId: number,
  ownerAnimeIds: number[],
): ProviderSeasonOwnershipDiagnostic {
  const ownerSet = new Set(ownerAnimeIds);
  const normalized = episodes
    .filter(
      (episode) =>
        Number.isInteger(episode.providerEpisodeNumber) &&
        episode.providerEpisodeNumber > 0,
    )
    .sort((a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber);

  const orphanNumbers: number[] = [];
  const ownerNumbers: number[] = [];
  const unmappedNumbers: number[] = [];
  const otherNumbers: number[] = [];
  const otherAnimeIds = new Set<number>();

  for (const episode of normalized) {
    if (episode.animeId === orphanAnimeId) {
      orphanNumbers.push(episode.providerEpisodeNumber);
    } else if (episode.animeId !== null && ownerSet.has(episode.animeId)) {
      ownerNumbers.push(episode.providerEpisodeNumber);
    } else if (episode.animeId === null) {
      unmappedNumbers.push(episode.providerEpisodeNumber);
    } else {
      otherNumbers.push(episode.providerEpisodeNumber);
      otherAnimeIds.add(episode.animeId);
    }
  }

  const orphanRanges = contiguousRanges(orphanNumbers);
  const ownerRanges = contiguousRanges(ownerNumbers);
  let classification: ProviderSeasonOwnershipClassification;

  if (otherNumbers.length > 0) {
    classification = "other-anime-involved";
  } else if (orphanNumbers.length === 0 && ownerNumbers.length === 0) {
    classification = "unmapped-only";
  } else if (ownerNumbers.length === 0) {
    classification = "orphan-only";
  } else if (orphanNumbers.length === 0) {
    classification = "owner-only";
  } else if (orphanRanges.length === 1 && ownerRanges.length === 1) {
    const [orphanStart, orphanEnd] = orphanRanges[0]!;
    const [ownerStart, ownerEnd] = ownerRanges[0]!;
    if (ownerEnd + 1 === orphanStart) {
      classification = "owner-then-orphan-adjacent";
    } else if (orphanEnd + 1 === ownerStart) {
      classification = "orphan-then-owner-adjacent";
    } else {
      classification = "owner-orphan-with-gap";
    }
  } else {
    classification = "fragmented-between-owner-and-orphan";
  }

  return {
    classification,
    providerEpisodeStart: normalized[0]?.providerEpisodeNumber ?? null,
    providerEpisodeEnd: normalized[normalized.length - 1]?.providerEpisodeNumber ?? null,
    orphanOwnedEpisodeCount: orphanNumbers.length,
    ownerOwnedEpisodeCount: ownerNumbers.length,
    otherAnimeOwnedEpisodeCount: otherNumbers.length,
    unmappedEpisodeCount: unmappedNumbers.length,
    orphanRanges: formatRanges(orphanRanges),
    ownerRanges: formatRanges(ownerRanges),
    unmappedRanges: formatRanges(contiguousRanges(unmappedNumbers)),
    otherAnimeIds: [...otherAnimeIds].sort((a, b) => a - b),
  };
}
