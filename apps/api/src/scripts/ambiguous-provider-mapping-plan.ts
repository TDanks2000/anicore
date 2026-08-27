import type {
  AmbiguousMappingCandidateDiagnosis,
  AmbiguousMappingGroupDiagnosis,
  AmbiguousMappingProviderEvidence,
} from "./ambiguous-provider-mapping-diagnosis";
import type {
  AuthoritativeSeasonFetchState,
  AuthoritativeProviderEpisode,
} from "./ambiguous-provider-mapping-evidence";

export const PROPOSED_UPGRADE_SOURCE = "system" as const;
export const PROPOSED_UPGRADE_CONFIDENCE = 95;
export const PROPOSED_UPGRADE_IS_PRIMARY = true;

export type AmbiguousMappingPlanBlockReason =
  | "group-not-repair-safe"
  | "provider-fetch-failed"
  | "authoritative-episode-fetch-incomplete"
  | "keep-legacy-mapping-missing"
  | "keep-legacy-ownership-ambiguous"
  | "retire-legacy-ownership-ambiguous"
  | "manual-legacy-mapping-would-be-retired"
  | "keep-v2-association-missing"
  | "keep-v2-association-ambiguous"
  | "retire-v2-association-ambiguous"
  | "manual-v2-association-would-be-retired"
  | "explicit-segments-on-keep-association"
  | "explicit-segments-on-retire-association"
  | "unhandled-same-provider-v2-associations"
  | "retire-season-episode-mappings-present"
  | "keep-retire-episode-id-overlap"
  | "identity-mismatch-with-diagnostic-evidence";

export interface AmbiguousMappingLegacyRow {
  id: number;
  animeId: number;
  provider: string;
  providerId: string;
  providerSlug: string | null;
  source: string;
  confidence: number;
  isPrimary: boolean;
}

export interface AmbiguousMappingProviderEntityRow {
  id: number;
  provider: string;
  providerId: string;
  providerSlug: string | null;
  providerUrl: string | null;
}

export interface AmbiguousMappingV2AssociationRow {
  id: number;
  animeId: number;
  providerEntityId: number;
  source: string;
  confidence: number;
  isPrimary: boolean;
  segmentCount: number;
}

export interface AmbiguousMappingMappedEpisodeRow {
  episodeMappingId: number;
  episodeId: number;
  animeId: number;
  localEpisodeNumber: number | null;
  localKind: string;
  providerEpisodeId: string;
  providerEpisodeNumber: string | null;
  source: string;
  confidence: number;
}

export interface AmbiguousMappingCandidateState {
  provider: string;
  providerId: string;
  legacyRows: AmbiguousMappingLegacyRow[];
  entities: AmbiguousMappingProviderEntityRow[];
  v2Associations: AmbiguousMappingV2AssociationRow[];
  authoritativeState: AuthoritativeSeasonFetchState;
  authoritativeEpisodes: AuthoritativeProviderEpisode[];
  mappedProviderEpisodes: AmbiguousMappingMappedEpisodeRow[];
}

export interface AmbiguousMappingGroupState {
  animeId: number;
  candidates: AmbiguousMappingCandidateState[];
  sameProviderV2Associations: AmbiguousMappingV2AssociationRow[];
}

export interface AmbiguousMappingProposedRowUpdate {
  id: number;
  old: { source: string; confidence: number; isPrimary: boolean };
  proposed: {
    source: typeof PROPOSED_UPGRADE_SOURCE;
    confidence: typeof PROPOSED_UPGRADE_CONFIDENCE;
    isPrimary: typeof PROPOSED_UPGRADE_IS_PRIMARY;
  };
}

export interface AmbiguousMappingProposedWrites {
  legacyMappingsToRetire: AmbiguousMappingLegacyRow[];
  v2AssociationsToRetire: AmbiguousMappingV2AssociationRow[];
  legacyMappingsToUpdate: AmbiguousMappingProposedRowUpdate[];
  v2AssociationsToUpdate: AmbiguousMappingProposedRowUpdate[];
  providerEntitiesKept: AmbiguousMappingProviderEntityRow[];
}

export interface AmbiguousMappingEpisodeTarget {
  animeId: number;
  localEpisodeNumber: number | null;
  localKind: string;
  count: number;
}

export interface AmbiguousMappingEpisodeScopeAnalysis {
  keepAuthoritativeEpisodeCount: number;
  keepMappedEpisodeCount: number;
  keepMappedEpisodeTargets: AmbiguousMappingEpisodeTarget[];
  retireAuthoritativeEpisodeCount: number;
  retireMappedEpisodeCount: number;
  retireMappedEpisodeTargets: AmbiguousMappingEpisodeTarget[];
  keepRetireOverlappingProviderEpisodeIds: string[];
  seasonFetchStates: Array<{
    providerId: string;
    state: AuthoritativeSeasonFetchState;
    episodeCount: number;
  }>;
}

export interface AmbiguousMappingPlanResult {
  animeId: number;
  plannable: boolean;
  blockReason: AmbiguousMappingPlanBlockReason | null;
  keep: AmbiguousMappingCandidateDiagnosis;
  retirees: AmbiguousMappingCandidateDiagnosis[];
  episodeScope: AmbiguousMappingEpisodeScopeAnalysis;
  proposedWrites: AmbiguousMappingProposedWrites | null;
}

export interface AmbiguousMappingPlanInput {
  group: AmbiguousMappingGroupDiagnosis;
  state: AmbiguousMappingGroupState;
}

function evidenceFor(
  candidate: AmbiguousMappingCandidateDiagnosis,
): AmbiguousMappingProviderEvidence | null {
  return candidate.evidence;
}

function isManualSource(source: string): boolean {
  return source === "manual";
}

function isAutomaticSource(source: string): boolean {
  return ["api", "fuzzy", "import", "system"].includes(source);
}

function slugMismatch(rowSlug: string | null, evidenceSlug: string | null): boolean {
  if (!rowSlug || !evidenceSlug) return false;
  return rowSlug.trim().toLocaleLowerCase() !== evidenceSlug.trim().toLocaleLowerCase();
}

function aggregateEpisodeTargets(
  rows: AmbiguousMappingMappedEpisodeRow[],
): AmbiguousMappingEpisodeTarget[] {
  const byKey = new Map<string, AmbiguousMappingEpisodeTarget>();
  for (const row of rows) {
    const key = `${row.animeId}\u0000${row.localEpisodeNumber ?? "?"}\u0000${row.localKind}`;
    const target = byKey.get(key) ?? {
      animeId: row.animeId,
      localEpisodeNumber: row.localEpisodeNumber,
      localKind: row.localKind,
      count: 0,
    };
    target.count += 1;
    byKey.set(key, target);
  }
  return [...byKey.values()].sort(
    (a, b) => a.animeId - b.animeId || (a.localEpisodeNumber ?? 0) - (b.localEpisodeNumber ?? 0),
  );
}

/**
 * Fail-closed plan classification for one repair-safe ambiguous mapping group.
 *
 * The current-state snapshot (legacy rows, v2 entities/associations,
 * authoritative season episodes, mapped provider episodes) is validated
 * against the live diagnostic group before any write is proposed:
 *
 * - exactly one verified-keep and every sibling verified-retire
 * - keep requires exactly one legacy row and exactly one zero-segment v2
 *   association; retirees require at most one of each, never manual-sourced
 * - explicit segments anywhere, unhandled same-provider v2 associations,
 *   identity mismatches vs the diagnostic evidence, fetch failures,
 *   incomplete authoritative seasons, keep/retire episode ID overlap, and any
 *   mapped provider episode belonging to a retire season all fail closed.
 *
 * Proposed parent-level writes never touch provider_entities and never
 * touch episode_mappings.
 */
export function planAmbiguousMappingRepair(
  input: AmbiguousMappingPlanInput,
): AmbiguousMappingPlanResult {
  const { group, state } = input;

  const keep = group.candidates.find(
    (candidate) => candidate.repair.status === "verified-keep",
  );
  const retirees = group.candidates.filter(
    (candidate) => candidate.repair.status === "verified-retire",
  );

  const stateByProviderId = new Map(
    state.candidates.map((candidate) => [`${candidate.provider}:${candidate.providerId}`, candidate]),
  );
  const keepState = keep
    ? stateByProviderId.get(`${keep.provider}:${keep.providerId}`)
    : undefined;
  const retireStates = retirees.map(
    (candidate) => stateByProviderId.get(`${candidate.provider}:${candidate.providerId}`)!,
  );

  const keepEpisodeIds = new Set(
    keepState?.authoritativeEpisodes.map((episode) => episode.providerEpisodeId) ?? [],
  );
  const retireEpisodeIds = new Set(
    retireStates.flatMap((candidate) =>
      candidate.authoritativeEpisodes.map((episode) => episode.providerEpisodeId),
    ),
  );
  const overlappingEpisodeIds = [...keepEpisodeIds].filter((id) => retireEpisodeIds.has(id)).sort();

  const seasonFetchStates = [...(keepState ? [keepState] : []), ...retireStates].map(
    (candidate) => ({
      providerId: candidate.providerId,
      state: candidate.authoritativeState,
      episodeCount: candidate.authoritativeEpisodes.length,
    }),
  );

  const episodeScope: AmbiguousMappingEpisodeScopeAnalysis = {
    keepAuthoritativeEpisodeCount: keepState?.authoritativeEpisodes.length ?? 0,
    keepMappedEpisodeCount: keepState?.mappedProviderEpisodes.length ?? 0,
    keepMappedEpisodeTargets: aggregateEpisodeTargets(
      keepState?.mappedProviderEpisodes ?? [],
    ),
    retireAuthoritativeEpisodeCount: retireStates.reduce(
      (sum, candidate) => sum + candidate.authoritativeEpisodes.length,
      0,
    ),
    retireMappedEpisodeCount: retireStates.reduce(
      (sum, candidate) => sum + candidate.mappedProviderEpisodes.length,
      0,
    ),
    retireMappedEpisodeTargets: aggregateEpisodeTargets(
      retireStates.flatMap((candidate) => candidate.mappedProviderEpisodes),
    ),
    keepRetireOverlappingProviderEpisodeIds: overlappingEpisodeIds,
    seasonFetchStates,
  };

  const block = (
    blockReason: AmbiguousMappingPlanBlockReason,
  ): AmbiguousMappingPlanResult => ({
    animeId: group.animeId,
    plannable: false,
    blockReason,
    keep: keep ?? group.candidates[0]!,
    retirees,
    episodeScope,
    proposedWrites: null,
  });

  if (!group.repairSafe || !keep || !keepState || retirees.length === 0) {
    return block("group-not-repair-safe");
  }
  if (retireStates.some((candidate) => !candidate)) {
    return block("group-not-repair-safe");
  }

  if (
    keepState.authoritativeState === "fetch-failed" ||
    retireStates.some((candidate) => candidate.authoritativeState === "fetch-failed")
  ) {
    return block("provider-fetch-failed");
  }
  if (
    keepState.authoritativeState !== "ok" ||
    retireStates.some((candidate) => candidate.authoritativeState !== "ok")
  ) {
    return block("authoritative-episode-fetch-incomplete");
  }

  if (keepState.legacyRows.length === 0) {
    return block("keep-legacy-mapping-missing");
  }
  if (keepState.legacyRows.length > 1) {
    return block("keep-legacy-ownership-ambiguous");
  }
  for (const retireState of retireStates) {
    if (retireState.legacyRows.length > 1) {
      return block("retire-legacy-ownership-ambiguous");
    }
  }
  for (const retireState of retireStates) {
    for (const row of retireState.legacyRows) {
      if (isManualSource(row.source)) {
        return block("manual-legacy-mapping-would-be-retired");
      }
    }
  }

  const keepEvidence = evidenceFor(keep);
  const keepLegacyRow = keepState.legacyRows[0]!;
  if (keepEvidence && slugMismatch(keepLegacyRow.providerSlug, keepEvidence.providerSlug)) {
    return block("identity-mismatch-with-diagnostic-evidence");
  }

  const keepV2Associations = keepState.v2Associations;
  if (keepV2Associations.length === 0) {
    return block("keep-v2-association-missing");
  }
  if (keepV2Associations.length > 1 || keepState.entities.length > 1) {
    return block("keep-v2-association-ambiguous");
  }
  if (keepV2Associations[0]!.segmentCount > 0) {
    return block("explicit-segments-on-keep-association");
  }
  const keepEntity = keepState.entities[0]!;
  if (keepEvidence && slugMismatch(keepEntity.providerSlug, keepEvidence.providerSlug)) {
    return block("identity-mismatch-with-diagnostic-evidence");
  }

  for (const retireState of retireStates) {
    if (retireState.v2Associations.length > 1 || retireState.entities.length > 1) {
      return block("retire-v2-association-ambiguous");
    }
    for (const association of retireState.v2Associations) {
      if (isManualSource(association.source)) {
        return block("manual-v2-association-would-be-retired");
      }
      if (association.segmentCount > 0) {
        return block("explicit-segments-on-retire-association");
      }
    }
  }

  const candidateEntityIds = new Set(
    [keepState, ...retireStates].flatMap((candidate) =>
      candidate.entities.map((entity) => entity.id),
    ),
  );
  const unhandledAssociations = state.sameProviderV2Associations.filter(
    (association) => !candidateEntityIds.has(association.providerEntityId),
  );
  if (unhandledAssociations.length > 0) {
    return block("unhandled-same-provider-v2-associations");
  }

  if (overlappingEpisodeIds.length > 0) {
    return block("keep-retire-episode-id-overlap");
  }
  if (episodeScope.retireMappedEpisodeCount > 0) {
    return block("retire-season-episode-mappings-present");
  }

  const legacyMappingsToRetire = retireStates.flatMap((candidate) => candidate.legacyRows);
  const v2AssociationsToRetire = retireStates.flatMap((candidate) => candidate.v2Associations);
  const legacyMappingsToUpdate: AmbiguousMappingProposedRowUpdate[] = [
    {
      id: keepLegacyRow.id,
      old: {
        source: keepLegacyRow.source,
        confidence: keepLegacyRow.confidence,
        isPrimary: keepLegacyRow.isPrimary,
      },
      proposed: {
        source: PROPOSED_UPGRADE_SOURCE,
        confidence: PROPOSED_UPGRADE_CONFIDENCE,
        isPrimary: PROPOSED_UPGRADE_IS_PRIMARY,
      },
    },
  ];
  const v2AssociationsToUpdate: AmbiguousMappingProposedRowUpdate[] = keepV2Associations.map(
    (association) => ({
      id: association.id,
      old: {
        source: association.source,
        confidence: association.confidence,
        isPrimary: association.isPrimary,
      },
      proposed: {
        source: PROPOSED_UPGRADE_SOURCE,
        confidence: PROPOSED_UPGRADE_CONFIDENCE,
        isPrimary: PROPOSED_UPGRADE_IS_PRIMARY,
      },
    }),
  );
  const providerEntitiesKept = [keepState, ...retireStates].flatMap(
    (candidate) => candidate.entities,
  );

  return {
    animeId: group.animeId,
    plannable: true,
    blockReason: null,
    keep,
    retirees,
    episodeScope,
    proposedWrites: {
      legacyMappingsToRetire,
      v2AssociationsToRetire,
      legacyMappingsToUpdate,
      v2AssociationsToUpdate,
      providerEntitiesKept,
    },
  };
}