import {
  isWeakAutomaticOrphanEpisodeMapping,
  type ExistingProviderIdentity,
  type OrphanEpisodeMappingRow,
} from "./orphan-episode-parent-repair";

export interface TvdbSlugEpisodeEvidence {
  seriesRef:
    | { kind: "slug"; slug: string }
    | { kind: "id"; seriesId: number };
  seasonNumber: number;
  providerEpisodeId: number;
  providerEpisodeNumber: number;
}

export interface TvdbSlugResolutionGroup {
  animeId: number;
  slug: string;
  seasonNumber: number;
  expectedSeriesIds: number[];
  confidence: number;
  episodeMappingIds: number[];
  episodes: Array<{
    providerEpisodeId: number;
    providerEpisodeNumber: number;
  }>;
}

export interface TvdbSlugRepairCandidate {
  animeId: number;
  provider: "thetvdb";
  providerId: string;
  providerSlug: string;
  providerUrl: string;
  source: "fuzzy";
  confidence: number;
  episodeMappingCount: number;
  episodeMappingIds: number[];
}

export interface TvdbSlugGroupPlan {
  totalTvdbOrphanGroups: number;
  totalTvdbOrphanEpisodeMappings: number;
  groups: TvdbSlugResolutionGroup[];
  skippedInvalidEvidenceGroups: number;
  skippedInvalidEvidenceEpisodeMappings: number;
}

export interface TvdbCandidateCollisionResult {
  candidates: TvdbSlugRepairCandidate[];
  skippedCollisionGroups: number;
  skippedCollisionEpisodeMappings: number;
}

function parsePositiveInteger(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function groupKey(row: Pick<OrphanEpisodeMappingRow, "animeId" | "provider">): string {
  return `${row.animeId}\u0000${row.provider}`;
}

function identityKey(provider: string, providerId: string): string {
  return `${provider}\u0000${providerId}`;
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

export function deriveTvdbSlugEpisodeEvidence(
  row: OrphanEpisodeMappingRow,
): TvdbSlugEpisodeEvidence | null {
  if (row.provider !== "thetvdb") return null;

  const seasonNumber = parsePositiveInteger(row.episodeSeasonNumber);
  const providerEpisodeId = parsePositiveInteger(row.providerId);
  const providerEpisodeNumber = parsePositiveInteger(row.providerEpisodeNumber);
  if (!seasonNumber || !providerEpisodeId || !providerEpisodeNumber) return null;
  if (!row.providerUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(row.providerUrl);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "thetvdb.com" && host !== "www.thetvdb.com") return null;

  const path = parsed.pathname.split("/").filter(Boolean);
  if (path.length !== 4 || path[0] !== "series" || path[2] !== "episodes") {
    return null;
  }

  const urlEpisodeId = parsePositiveInteger(path[3] ?? null);
  if (!urlEpisodeId || urlEpisodeId !== providerEpisodeId) return null;

  let seriesSegment: string;
  try {
    seriesSegment = decodeURIComponent(path[1] ?? "").trim();
  } catch {
    return null;
  }
  if (!seriesSegment) return null;

  const numericSeriesId = parsePositiveInteger(seriesSegment);
  const seriesRef = numericSeriesId
    ? ({ kind: "id", seriesId: numericSeriesId } as const)
    : ({ kind: "slug", slug: seriesSegment } as const);

  return {
    seriesRef,
    seasonNumber,
    providerEpisodeId,
    providerEpisodeNumber,
  };
}

export function buildTvdbSlugResolutionGroups(
  orphanRows: OrphanEpisodeMappingRow[],
): TvdbSlugGroupPlan {
  const groups = new Map<string, OrphanEpisodeMappingRow[]>();
  for (const row of orphanRows) {
    if (row.provider !== "thetvdb") continue;
    const key = groupKey(row);
    const rows = groups.get(key) ?? [];
    rows.push(row);
    groups.set(key, rows);
  }

  const result: TvdbSlugResolutionGroup[] = [];
  let skippedInvalidEvidenceGroups = 0;
  let skippedInvalidEvidenceEpisodeMappings = 0;

  for (const rows of groups.values()) {
    if (!rows.every(isWeakAutomaticOrphanEpisodeMapping)) {
      skippedInvalidEvidenceGroups += 1;
      skippedInvalidEvidenceEpisodeMappings += rows.length;
      continue;
    }

    const evidence = rows.map(deriveTvdbSlugEpisodeEvidence);
    if (evidence.some((item) => item === null)) {
      skippedInvalidEvidenceGroups += 1;
      skippedInvalidEvidenceEpisodeMappings += rows.length;
      continue;
    }

    const validEvidence = evidence as TvdbSlugEpisodeEvidence[];
    const slugEvidence = validEvidence.filter(
      (item): item is TvdbSlugEpisodeEvidence & {
        seriesRef: { kind: "slug"; slug: string };
      } => item.seriesRef.kind === "slug",
    );
    const numericEvidence = validEvidence.filter(
      (item): item is TvdbSlugEpisodeEvidence & {
        seriesRef: { kind: "id"; seriesId: number };
      } => item.seriesRef.kind === "id",
    );

    const slugs = new Map<string, string>();
    for (const item of slugEvidence) {
      slugs.set(normalizeSlug(item.seriesRef.slug), item.seriesRef.slug);
    }
    const seasons = new Set(validEvidence.map((item) => item.seasonNumber));
    const expectedSeriesIds = [
      ...new Set(numericEvidence.map((item) => item.seriesRef.seriesId)),
    ].sort((a, b) => a - b);

    // Numeric-only groups are handled by the original local repair planner. This
    // operation exists specifically to resolve legacy textual TVDB slugs. Mixed
    // slug/numeric groups are allowed, but the remote series ID must later agree
    // with every numeric ID already preserved in the group.
    if (slugs.size !== 1 || seasons.size !== 1 || expectedSeriesIds.length > 1) {
      skippedInvalidEvidenceGroups += 1;
      skippedInvalidEvidenceEpisodeMappings += rows.length;
      continue;
    }

    const slug = [...slugs.values()][0]!;
    const first = validEvidence[0]!;
    result.push({
      animeId: rows[0]!.animeId,
      slug,
      seasonNumber: first.seasonNumber,
      expectedSeriesIds,
      confidence: Math.min(85, ...rows.map((row) => row.confidence)),
      episodeMappingIds: rows
        .map((row) => row.episodeMappingId)
        .sort((a, b) => a - b),
      episodes: validEvidence
        .map((item) => ({
          providerEpisodeId: item.providerEpisodeId,
          providerEpisodeNumber: item.providerEpisodeNumber,
        }))
        .sort(
          (a, b) =>
            a.providerEpisodeNumber - b.providerEpisodeNumber ||
            a.providerEpisodeId - b.providerEpisodeId,
        ),
    });
  }

  result.sort((a, b) => a.animeId - b.animeId);

  return {
    totalTvdbOrphanGroups: groups.size,
    totalTvdbOrphanEpisodeMappings: [...groups.values()].reduce(
      (total, rows) => total + rows.length,
      0,
    ),
    groups: result,
    skippedInvalidEvidenceGroups,
    skippedInvalidEvidenceEpisodeMappings,
  };
}

export function verifyResolvedTvdbSlugGroup(
  group: TvdbSlugResolutionGroup,
  series: { id: number; slug?: string },
  seasonEpisodes: Array<{ id: number; number?: number }>,
): TvdbSlugRepairCandidate | null {
  if (!Number.isInteger(series.id) || series.id <= 0) return null;
  if (series.slug && normalizeSlug(series.slug) !== normalizeSlug(group.slug)) {
    return null;
  }
  if (
    group.expectedSeriesIds.length > 0 &&
    !group.expectedSeriesIds.every((id) => id === series.id)
  ) {
    return null;
  }

  const byId = new Map<number, number>();
  for (const episode of seasonEpisodes) {
    if (
      Number.isInteger(episode.id) &&
      episode.id > 0 &&
      Number.isInteger(episode.number) &&
      (episode.number ?? 0) > 0
    ) {
      byId.set(episode.id, episode.number!);
    }
  }

  if (
    !group.episodes.every(
      (expected) =>
        byId.get(expected.providerEpisodeId) === expected.providerEpisodeNumber,
    )
  ) {
    return null;
  }

  return {
    animeId: group.animeId,
    provider: "thetvdb",
    providerId: `${series.id}:${group.seasonNumber}`,
    providerSlug: group.slug,
    providerUrl: `https://thetvdb.com/series/${encodeURIComponent(group.slug)}/seasons/official/${group.seasonNumber}`,
    source: "fuzzy",
    confidence: group.confidence,
    episodeMappingCount: group.episodeMappingIds.length,
    episodeMappingIds: [...group.episodeMappingIds],
  };
}

export function filterTvdbSlugCandidateCollisions(
  preliminary: TvdbSlugRepairCandidate[],
  existingIdentities: ExistingProviderIdentity[],
): TvdbCandidateCollisionResult {
  const existingOwners = new Map<string, Set<number>>();
  for (const mapping of existingIdentities) {
    if (mapping.provider !== "thetvdb") continue;
    const key = identityKey(mapping.provider, mapping.providerId);
    const owners = existingOwners.get(key) ?? new Set<number>();
    owners.add(mapping.animeId);
    existingOwners.set(key, owners);
  }

  const plannedOwners = new Map<string, Set<number>>();
  for (const candidate of preliminary) {
    const key = identityKey(candidate.provider, candidate.providerId);
    const owners = plannedOwners.get(key) ?? new Set<number>();
    owners.add(candidate.animeId);
    plannedOwners.set(key, owners);
  }

  const candidates: TvdbSlugRepairCandidate[] = [];
  let skippedCollisionGroups = 0;
  let skippedCollisionEpisodeMappings = 0;

  for (const candidate of preliminary) {
    const key = identityKey(candidate.provider, candidate.providerId);
    const existing = existingOwners.get(key);
    const planned = plannedOwners.get(key);
    const collides = Boolean(
      (existing && existing.size > 0) || (planned && planned.size > 1),
    );

    if (collides) {
      skippedCollisionGroups += 1;
      skippedCollisionEpisodeMappings += candidate.episodeMappingCount;
      continue;
    }
    candidates.push(candidate);
  }

  return {
    candidates,
    skippedCollisionGroups,
    skippedCollisionEpisodeMappings,
  };
}
