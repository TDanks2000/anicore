export interface OrphanEpisodeMappingRow {
  episodeMappingId: number;
  animeId: number;
  episodeId: number;
  provider: string;
  providerId: string;
  providerUrl: string | null;
  providerEpisodeNumber: string | null;
  episodeSeasonNumber: number | null;
  source: string;
  confidence: number;
}

export interface ExistingProviderIdentity {
  animeId: number;
  provider: string;
  providerId: string;
}

export interface OrphanParentRepairCandidate {
  animeId: number;
  provider: "thetvdb" | "tmdb";
  providerId: string;
  providerUrl: string | null;
  source: "fuzzy";
  confidence: number;
  episodeMappingCount: number;
  episodeMappingIds: number[];
}

export interface RepairSkipStat {
  groups: number;
  episodeMappings: number;
}

export interface OrphanParentRepairPlan {
  totalOrphanGroups: number;
  totalOrphanEpisodeMappings: number;
  candidates: OrphanParentRepairCandidate[];
  skipped: {
    unsupportedProvider: RepairSkipStat;
    strongerOrManualEvidence: RepairSkipStat;
    incompleteParentEvidence: RepairSkipStat;
    conflictingParentEvidence: RepairSkipStat;
    providerIdentityCollision: RepairSkipStat;
  };
}

type SupportedProvider = OrphanParentRepairCandidate["provider"];

type ParentEvidence = {
  providerId: string;
  providerUrl: string | null;
};

function emptySkipStat(): RepairSkipStat {
  return { groups: 0, episodeMappings: 0 };
}

function recordSkip(stat: RepairSkipStat, episodeMappingCount: number): void {
  stat.groups += 1;
  stat.episodeMappings += episodeMappingCount;
}

function parsePositiveInteger(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseProviderUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function isWeakAutomaticOrphanEpisodeMapping(
  row: Pick<OrphanEpisodeMappingRow, "source" | "confidence">,
): boolean {
  if (!Number.isInteger(row.confidence) || row.confidence < 0) return false;
  if (row.source === "fuzzy") return row.confidence <= 85;
  return row.source === "api" && row.confidence <= 85;
}

export function deriveOrphanParentEvidence(
  row: OrphanEpisodeMappingRow,
): ParentEvidence | null {
  const seasonNumber = parsePositiveInteger(row.episodeSeasonNumber);
  if (!seasonNumber) return null;

  const providerUrl = parseProviderUrl(row.providerUrl);
  if (!providerUrl) return null;
  const path = providerUrl.pathname.split("/").filter(Boolean);
  const host = providerUrl.hostname.toLowerCase();

  if (row.provider === "tmdb") {
    if (host !== "themoviedb.org" && host !== "www.themoviedb.org") {
      return null;
    }
    if (
      path.length !== 6 ||
      path[0] !== "tv" ||
      path[2] !== "season" ||
      path[4] !== "episode"
    ) {
      return null;
    }

    const showId = parsePositiveInteger(path[1] ?? null);
    const urlSeasonNumber = parsePositiveInteger(path[3] ?? null);
    const urlEpisodeNumber = parsePositiveInteger(path[5] ?? null);
    const providerEpisodeNumber = parsePositiveInteger(
      row.providerEpisodeNumber,
    );
    if (
      !showId ||
      !urlSeasonNumber ||
      !urlEpisodeNumber ||
      !providerEpisodeNumber ||
      urlSeasonNumber !== seasonNumber ||
      urlEpisodeNumber !== providerEpisodeNumber
    ) {
      return null;
    }

    return {
      providerId: `${showId}:${seasonNumber}`,
      providerUrl: `https://www.themoviedb.org/tv/${showId}/season/${seasonNumber}`,
    };
  }

  if (row.provider === "thetvdb") {
    if (host !== "thetvdb.com" && host !== "www.thetvdb.com") return null;
    if (
      path.length !== 4 ||
      path[0] !== "series" ||
      path[2] !== "episodes"
    ) {
      return null;
    }

    const seriesId = parsePositiveInteger(path[1] ?? null);
    const urlEpisodeId = parsePositiveInteger(path[3] ?? null);
    const storedEpisodeId = parsePositiveInteger(row.providerId);
    if (!seriesId || !urlEpisodeId || !storedEpisodeId) return null;
    if (urlEpisodeId !== storedEpisodeId) return null;

    return {
      providerId: `${seriesId}:${seasonNumber}`,
      providerUrl: null,
    };
  }

  return null;
}

function groupKey(row: Pick<OrphanEpisodeMappingRow, "animeId" | "provider">): string {
  return `${row.animeId}\u0000${row.provider}`;
}

function identityKey(provider: string, providerId: string): string {
  return `${provider}\u0000${providerId}`;
}

export function buildOrphanParentRepairPlan(
  orphanRows: OrphanEpisodeMappingRow[],
  existingIdentities: ExistingProviderIdentity[],
): OrphanParentRepairPlan {
  const skipped = {
    unsupportedProvider: emptySkipStat(),
    strongerOrManualEvidence: emptySkipStat(),
    incompleteParentEvidence: emptySkipStat(),
    conflictingParentEvidence: emptySkipStat(),
    providerIdentityCollision: emptySkipStat(),
  };

  const groups = new Map<string, OrphanEpisodeMappingRow[]>();
  for (const row of orphanRows) {
    const key = groupKey(row);
    const rows = groups.get(key) ?? [];
    rows.push(row);
    groups.set(key, rows);
  }

  const preliminary: OrphanParentRepairCandidate[] = [];

  for (const rows of groups.values()) {
    const first = rows[0]!;
    const provider = first.provider;
    if (provider !== "thetvdb" && provider !== "tmdb") {
      recordSkip(skipped.unsupportedProvider, rows.length);
      continue;
    }

    if (!rows.every(isWeakAutomaticOrphanEpisodeMapping)) {
      recordSkip(skipped.strongerOrManualEvidence, rows.length);
      continue;
    }

    const evidence = rows.map(deriveOrphanParentEvidence);
    if (evidence.some((value) => value === null)) {
      recordSkip(skipped.incompleteParentEvidence, rows.length);
      continue;
    }

    const supportedEvidence = evidence as ParentEvidence[];
    const parentIds = new Set(supportedEvidence.map((value) => value.providerId));
    if (parentIds.size !== 1) {
      recordSkip(skipped.conflictingParentEvidence, rows.length);
      continue;
    }

    const parent = supportedEvidence[0]!;
    preliminary.push({
      animeId: first.animeId,
      provider: provider as SupportedProvider,
      providerId: parent.providerId,
      providerUrl: parent.providerUrl,
      source: "fuzzy",
      confidence: Math.min(85, ...rows.map((row) => row.confidence)),
      episodeMappingCount: rows.length,
      episodeMappingIds: rows
        .map((row) => row.episodeMappingId)
        .sort((a, b) => a - b),
    });
  }

  const existingOwners = new Map<string, Set<number>>();
  for (const mapping of existingIdentities) {
    const key = identityKey(mapping.provider, mapping.providerId);
    const owners = existingOwners.get(key) ?? new Set<number>();
    owners.add(mapping.animeId);
    existingOwners.set(key, owners);
  }

  const candidateOwners = new Map<string, Set<number>>();
  for (const candidate of preliminary) {
    const key = identityKey(candidate.provider, candidate.providerId);
    const owners = candidateOwners.get(key) ?? new Set<number>();
    owners.add(candidate.animeId);
    candidateOwners.set(key, owners);
  }

  const candidates: OrphanParentRepairCandidate[] = [];
  for (const candidate of preliminary) {
    const key = identityKey(candidate.provider, candidate.providerId);
    const existing = existingOwners.get(key);
    const plannedOwners = candidateOwners.get(key);
    const collidesWithExisting = Boolean(existing && existing.size > 0);
    const collidesWithAnotherAnime = Boolean(
      plannedOwners &&
        (plannedOwners.size > 1 || !plannedOwners.has(candidate.animeId)),
    );

    if (collidesWithExisting || collidesWithAnotherAnime) {
      recordSkip(
        skipped.providerIdentityCollision,
        candidate.episodeMappingCount,
      );
      continue;
    }

    candidates.push(candidate);
  }

  candidates.sort(
    (a, b) =>
      a.animeId - b.animeId ||
      a.provider.localeCompare(b.provider) ||
      a.providerId.localeCompare(b.providerId),
  );

  return {
    totalOrphanGroups: groups.size,
    totalOrphanEpisodeMappings: orphanRows.length,
    candidates,
    skipped,
  };
}
