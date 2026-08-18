import {
  deriveOrphanParentEvidence,
  isWeakAutomaticOrphanEpisodeMapping,
  type ExistingProviderIdentity,
  type OrphanEpisodeMappingRow,
} from "./orphan-episode-parent-repair";

export type OrphanEvidenceFailureReason =
  | "missing-season-number"
  | "missing-provider-url"
  | "invalid-provider-url"
  | "unsupported-url-host"
  | "unsupported-url-path"
  | "invalid-provider-identity"
  | "missing-provider-episode-number"
  | "provider-season-mismatch"
  | "provider-episode-number-mismatch"
  | "provider-episode-id-mismatch"
  | "unclassified-incomplete-evidence";

export type OrphanDiagnosticCategory =
  | "reconstructable"
  | "unsupported-provider"
  | "stronger-or-manual-evidence"
  | "incomplete-parent-evidence"
  | "conflicting-parent-evidence"
  | "provider-identity-collision";

interface DiagnosticCount {
  groups: number;
  episodeMappings: number;
}

interface EvidenceFailureCount extends DiagnosticCount {
  rows: number;
}

export interface OrphanDiagnosticSample {
  animeId: number;
  provider: string;
  episodeMappingCount: number;
  episodeMappingIds: number[];
  sourceConfidenceSignatures: string[];
  seasonNumbers: Array<number | null>;
  providerUrlCount: number;
  providerEpisodeNumberCount: number;
  derivedParentIds: string[];
  evidenceFailureReasons: OrphanEvidenceFailureReason[];
}

export interface OrphanCategoryDiagnostic extends DiagnosticCount {
  samples: OrphanDiagnosticSample[];
}

export interface OrphanParentRepairDiagnostics {
  totalGroups: number;
  totalEpisodeMappings: number;
  coverage: {
    withSeasonNumber: number;
    withoutSeasonNumber: number;
    withProviderUrl: number;
    withoutProviderUrl: number;
    withProviderEpisodeNumber: number;
    withoutProviderEpisodeNumber: number;
  };
  byProvider: Array<{
    provider: string;
    groups: number;
    episodeMappings: number;
  }>;
  bySourceConfidence: Array<{
    source: string;
    confidence: number;
    episodeMappings: number;
  }>;
  incompleteEvidenceReasons: Partial<
    Record<OrphanEvidenceFailureReason, EvidenceFailureCount>
  >;
  categories: Record<OrphanDiagnosticCategory, OrphanCategoryDiagnostic>;
}

type ParentEvidence = NonNullable<
  ReturnType<typeof deriveOrphanParentEvidence>
>;

function parsePositiveInteger(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function diagnoseOrphanParentEvidence(
  row: OrphanEpisodeMappingRow,
): { evidence: ParentEvidence | null; reason: OrphanEvidenceFailureReason | null } {
  const seasonNumber = parsePositiveInteger(row.episodeSeasonNumber);
  if (!seasonNumber) {
    return { evidence: null, reason: "missing-season-number" };
  }

  if (!row.providerUrl) {
    return { evidence: null, reason: "missing-provider-url" };
  }

  const providerUrl = parseHttpUrl(row.providerUrl);
  if (!providerUrl) {
    return { evidence: null, reason: "invalid-provider-url" };
  }

  const path = providerUrl.pathname.split("/").filter(Boolean);
  const host = providerUrl.hostname.toLowerCase();

  if (row.provider === "tmdb") {
    if (host !== "themoviedb.org" && host !== "www.themoviedb.org") {
      return { evidence: null, reason: "unsupported-url-host" };
    }
    if (
      path.length !== 6 ||
      path[0] !== "tv" ||
      path[2] !== "season" ||
      path[4] !== "episode"
    ) {
      return { evidence: null, reason: "unsupported-url-path" };
    }

    const showId = parsePositiveInteger(path[1] ?? null);
    const urlSeasonNumber = parsePositiveInteger(path[3] ?? null);
    const urlEpisodeNumber = parsePositiveInteger(path[5] ?? null);
    if (!showId || !urlSeasonNumber || !urlEpisodeNumber) {
      return { evidence: null, reason: "invalid-provider-identity" };
    }

    const providerEpisodeNumber = parsePositiveInteger(
      row.providerEpisodeNumber,
    );
    if (!providerEpisodeNumber) {
      return { evidence: null, reason: "missing-provider-episode-number" };
    }
    if (urlSeasonNumber !== seasonNumber) {
      return { evidence: null, reason: "provider-season-mismatch" };
    }
    if (urlEpisodeNumber !== providerEpisodeNumber) {
      return { evidence: null, reason: "provider-episode-number-mismatch" };
    }
  } else if (row.provider === "thetvdb") {
    if (host !== "thetvdb.com" && host !== "www.thetvdb.com") {
      return { evidence: null, reason: "unsupported-url-host" };
    }
    if (
      path.length !== 4 ||
      path[0] !== "series" ||
      path[2] !== "episodes"
    ) {
      return { evidence: null, reason: "unsupported-url-path" };
    }

    const seriesId = parsePositiveInteger(path[1] ?? null);
    const urlEpisodeId = parsePositiveInteger(path[3] ?? null);
    const storedEpisodeId = parsePositiveInteger(row.providerId);
    if (!seriesId || !urlEpisodeId || !storedEpisodeId) {
      return { evidence: null, reason: "invalid-provider-identity" };
    }
    if (urlEpisodeId !== storedEpisodeId) {
      return { evidence: null, reason: "provider-episode-id-mismatch" };
    }
  }

  const evidence = deriveOrphanParentEvidence(row);
  if (evidence) return { evidence, reason: null };
  return { evidence: null, reason: "unclassified-incomplete-evidence" };
}

function groupKey(row: OrphanEpisodeMappingRow): string {
  return `${row.animeId}\u0000${row.provider}`;
}

function identityKey(provider: string, providerId: string): string {
  return `${provider}\u0000${providerId}`;
}

function emptyCategory(): OrphanCategoryDiagnostic {
  return { groups: 0, episodeMappings: 0, samples: [] };
}

function recordCategory(
  category: OrphanCategoryDiagnostic,
  rows: OrphanEpisodeMappingRow[],
  derivedParentIds: string[],
  evidenceFailureReasons: OrphanEvidenceFailureReason[],
): void {
  category.groups += 1;
  category.episodeMappings += rows.length;
  if (category.samples.length >= 10) return;

  category.samples.push({
    animeId: rows[0]!.animeId,
    provider: rows[0]!.provider,
    episodeMappingCount: rows.length,
    episodeMappingIds: rows
      .map((row) => row.episodeMappingId)
      .sort((a, b) => a - b)
      .slice(0, 10),
    sourceConfidenceSignatures: [
      ...new Set(rows.map((row) => `${row.source}/${row.confidence}`)),
    ].sort(),
    seasonNumbers: [
      ...new Set(rows.map((row) => row.episodeSeasonNumber)),
    ].sort((a, b) => (a ?? -1) - (b ?? -1)),
    providerUrlCount: rows.filter((row) => Boolean(row.providerUrl)).length,
    providerEpisodeNumberCount: rows.filter((row) =>
      Boolean(row.providerEpisodeNumber),
    ).length,
    derivedParentIds: [...new Set(derivedParentIds)].sort(),
    evidenceFailureReasons: [...new Set(evidenceFailureReasons)].sort(),
  });
}

function incrementFailureReason(
  target: OrphanParentRepairDiagnostics["incompleteEvidenceReasons"],
  reason: OrphanEvidenceFailureReason,
  groupEpisodeCount: number,
  rowCount: number,
): void {
  const current = target[reason] ?? { groups: 0, episodeMappings: 0, rows: 0 };
  current.groups += 1;
  current.episodeMappings += groupEpisodeCount;
  current.rows += rowCount;
  target[reason] = current;
}

export function buildOrphanParentRepairDiagnostics(
  orphanRows: OrphanEpisodeMappingRow[],
  existingIdentities: ExistingProviderIdentity[],
): OrphanParentRepairDiagnostics {
  const categories: Record<OrphanDiagnosticCategory, OrphanCategoryDiagnostic> = {
    reconstructable: emptyCategory(),
    "unsupported-provider": emptyCategory(),
    "stronger-or-manual-evidence": emptyCategory(),
    "incomplete-parent-evidence": emptyCategory(),
    "conflicting-parent-evidence": emptyCategory(),
    "provider-identity-collision": emptyCategory(),
  };

  const groups = new Map<string, OrphanEpisodeMappingRow[]>();
  for (const row of orphanRows) {
    const key = groupKey(row);
    const rows = groups.get(key) ?? [];
    rows.push(row);
    groups.set(key, rows);
  }

  const existingOwners = new Map<string, Set<number>>();
  for (const mapping of existingIdentities) {
    const key = identityKey(mapping.provider, mapping.providerId);
    const owners = existingOwners.get(key) ?? new Set<number>();
    owners.add(mapping.animeId);
    existingOwners.set(key, owners);
  }

  type PreliminaryGroup = {
    rows: OrphanEpisodeMappingRow[];
    parentId: string;
  };
  const preliminary: PreliminaryGroup[] = [];
  const incompleteEvidenceReasons: OrphanParentRepairDiagnostics["incompleteEvidenceReasons"] = {};

  for (const rows of groups.values()) {
    const provider = rows[0]!.provider;
    if (provider !== "thetvdb" && provider !== "tmdb") {
      recordCategory(categories["unsupported-provider"], rows, [], []);
      continue;
    }

    if (!rows.every(isWeakAutomaticOrphanEpisodeMapping)) {
      recordCategory(categories["stronger-or-manual-evidence"], rows, [], []);
      continue;
    }

    const diagnoses = rows.map(diagnoseOrphanParentEvidence);
    const failures = diagnoses.filter(
      (diagnosis): diagnosis is {
        evidence: null;
        reason: OrphanEvidenceFailureReason;
      } => diagnosis.evidence === null && diagnosis.reason !== null,
    );
    if (failures.length > 0) {
      const reasons = [...new Set(failures.map((failure) => failure.reason))];
      recordCategory(categories["incomplete-parent-evidence"], rows, [], reasons);
      for (const reason of reasons) {
        incrementFailureReason(
          incompleteEvidenceReasons,
          reason,
          rows.length,
          failures.filter((failure) => failure.reason === reason).length,
        );
      }
      continue;
    }

    const parentIds = diagnoses.map((diagnosis) => diagnosis.evidence!.providerId);
    if (new Set(parentIds).size !== 1) {
      recordCategory(categories["conflicting-parent-evidence"], rows, parentIds, []);
      continue;
    }

    preliminary.push({ rows, parentId: parentIds[0]! });
  }

  const candidateOwners = new Map<string, Set<number>>();
  for (const group of preliminary) {
    const first = group.rows[0]!;
    const key = identityKey(first.provider, group.parentId);
    const owners = candidateOwners.get(key) ?? new Set<number>();
    owners.add(first.animeId);
    candidateOwners.set(key, owners);
  }

  for (const group of preliminary) {
    const first = group.rows[0]!;
    const key = identityKey(first.provider, group.parentId);
    const existing = existingOwners.get(key);
    const plannedOwners = candidateOwners.get(key);
    if (
      (existing && existing.size > 0) ||
      (plannedOwners && plannedOwners.size > 1)
    ) {
      recordCategory(
        categories["provider-identity-collision"],
        group.rows,
        [group.parentId],
        [],
      );
      continue;
    }

    recordCategory(
      categories.reconstructable,
      group.rows,
      [group.parentId],
      [],
    );
  }

  const providerGroups = new Map<string, Set<string>>();
  const providerRows = new Map<string, number>();
  const sourceConfidenceRows = new Map<string, number>();
  for (const row of orphanRows) {
    const groupSet = providerGroups.get(row.provider) ?? new Set<string>();
    groupSet.add(groupKey(row));
    providerGroups.set(row.provider, groupSet);
    providerRows.set(row.provider, (providerRows.get(row.provider) ?? 0) + 1);

    const signature = `${row.source}\u0000${row.confidence}`;
    sourceConfidenceRows.set(
      signature,
      (sourceConfidenceRows.get(signature) ?? 0) + 1,
    );
  }

  return {
    totalGroups: groups.size,
    totalEpisodeMappings: orphanRows.length,
    coverage: {
      withSeasonNumber: orphanRows.filter((row) => row.episodeSeasonNumber !== null)
        .length,
      withoutSeasonNumber: orphanRows.filter(
        (row) => row.episodeSeasonNumber === null,
      ).length,
      withProviderUrl: orphanRows.filter((row) => Boolean(row.providerUrl)).length,
      withoutProviderUrl: orphanRows.filter((row) => !row.providerUrl).length,
      withProviderEpisodeNumber: orphanRows.filter((row) =>
        Boolean(row.providerEpisodeNumber),
      ).length,
      withoutProviderEpisodeNumber: orphanRows.filter(
        (row) => !row.providerEpisodeNumber,
      ).length,
    },
    byProvider: [...providerRows.entries()]
      .map(([provider, episodeMappings]) => ({
        provider,
        groups: providerGroups.get(provider)?.size ?? 0,
        episodeMappings,
      }))
      .sort(
        (a, b) =>
          b.episodeMappings - a.episodeMappings ||
          a.provider.localeCompare(b.provider),
      ),
    bySourceConfidence: [...sourceConfidenceRows.entries()]
      .map(([signature, episodeMappings]) => {
        const [source, confidence] = signature.split("\u0000");
        return {
          source: source!,
          confidence: Number(confidence),
          episodeMappings,
        };
      })
      .sort(
        (a, b) =>
          b.episodeMappings - a.episodeMappings ||
          a.source.localeCompare(b.source) ||
          b.confidence - a.confidence,
      ),
    incompleteEvidenceReasons,
    categories,
  };
}
