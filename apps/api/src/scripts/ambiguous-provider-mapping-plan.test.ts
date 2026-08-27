import { describe, expect, test } from "bun:test";

import {
  diagnoseAmbiguousMappingGroup,
  type AmbiguousMappingAnimeIdentity,
  type AmbiguousMappingGroupDiagnosis,
  type AmbiguousMappingProviderEvidence,
} from "./ambiguous-provider-mapping-diagnosis";
import type {
  AuthoritativeProviderEpisode,
} from "./ambiguous-provider-mapping-evidence";
import {
  planAmbiguousMappingRepair,
  type AmbiguousMappingCandidateState,
  type AmbiguousMappingGroupState,
  type AmbiguousMappingLegacyRow,
  type AmbiguousMappingMappedEpisodeRow,
  type AmbiguousMappingV2AssociationRow,
} from "./ambiguous-provider-mapping-plan";

const taikoAnime: AmbiguousMappingAnimeIdentity = {
  animeId: 6471,
  titleRomaji: "Taiko no Tatsujin",
  titleEnglish: null,
  titleNative: null,
  titleUserPreferred: null,
  synonymsJson: "[]",
  episodeCount: 26,
  startDate: "2005-04-04",
  format: "SPECIAL",
  seasonYear: 2005,
};

function keepEvidence(): AmbiguousMappingProviderEvidence {
  return {
    status: "ok",
    providerSeriesName: "Taiko no Tatsujin: Clay Anime",
    providerSlug: "taiko-no-tatsujin",
    providerFirstAired: null,
    providerSeasonFirstAired: "2005-04-04",
    providerSeasonEpisodeCount: 26,
    providerShowEpisodeCount: null,
  };
}

function retireEvidence(): AmbiguousMappingProviderEvidence {
  return {
    status: "ok",
    providerSeriesName: "太陽の使者 鉄人28号",
    providerSlug: "new-gigantor",
    providerFirstAired: "1980-10-03",
    providerSeasonFirstAired: null,
    providerSeasonEpisodeCount: 51,
    providerShowEpisodeCount: null,
  };
}

function buildRepairSafeGroup(anime: AmbiguousMappingAnimeIdentity = taikoAnime): AmbiguousMappingGroupDiagnosis {
  const group = diagnoseAmbiguousMappingGroup({
    anime,
    candidates: [
      {
        provider: "thetvdb",
        providerId: "150771:1",
        providerUrl: null,
        source: "api",
        confidence: 85,
        isPrimary: false,
        evidence: keepEvidence(),
      },
      {
        provider: "thetvdb",
        providerId: "251746:1",
        providerUrl: null,
        source: "api",
        confidence: 85,
        isPrimary: false,
        evidence: retireEvidence(),
      },
    ],
  });
  expect(group.repairSafe).toBe(true);
  return group;
}

const KEEP_EPISODES: AuthoritativeProviderEpisode[] = [
  { providerEpisodeId: "100", providerEpisodeNumber: 1, seasonNumber: 1 },
  { providerEpisodeId: "101", providerEpisodeNumber: 2, seasonNumber: 1 },
];
const RETIRE_EPISODES: AuthoritativeProviderEpisode[] = [
  { providerEpisodeId: "200", providerEpisodeNumber: 1, seasonNumber: 1 },
  { providerEpisodeId: "201", providerEpisodeNumber: 2, seasonNumber: 1 },
];

function legacyRow(providerId: string, overrides: Partial<AmbiguousMappingLegacyRow> = {}): AmbiguousMappingLegacyRow {
  return {
    id: providerId === "150771:1" ? 25036 : 88066,
    animeId: taikoAnime.animeId,
    provider: "thetvdb",
    providerId,
    providerSlug: providerId === "150771:1" ? "taiko-no-tatsujin" : "new-gigantor",
    source: "api",
    confidence: 85,
    isPrimary: false,
    ...overrides,
  };
}

function v2Association(
  providerId: string,
  overrides: Partial<AmbiguousMappingV2AssociationRow> = {},
): AmbiguousMappingV2AssociationRow {
  return {
    id: providerId === "150771:1" ? 16837 : 17283,
    animeId: taikoAnime.animeId,
    providerEntityId: providerId === "150771:1" ? 9025 : 9509,
    source: "api",
    confidence: 85,
    isPrimary: false,
    segmentCount: 0,
    ...overrides,
  };
}

function mappedEpisode(providerEpisodeId: string, overrides: Partial<AmbiguousMappingMappedEpisodeRow> = {}): AmbiguousMappingMappedEpisodeRow {
  return {
    episodeMappingId: 1,
    episodeId: 11,
    animeId: taikoAnime.animeId,
    localEpisodeNumber: 1,
    localKind: "normal",
    providerEpisodeId,
    providerEpisodeNumber: providerEpisodeId,
    source: "api",
    confidence: 85,
    ...overrides,
  };
}

interface CandidateStateOverrides {
  legacyRows?: AmbiguousMappingLegacyRow[];
  v2Associations?: AmbiguousMappingV2AssociationRow[];
  authoritativeState?: AmbiguousMappingCandidateState["authoritativeState"];
  authoritativeEpisodes?: AuthoritativeProviderEpisode[];
  mappedProviderEpisodes?: AmbiguousMappingMappedEpisodeRow[];
  entities?: AmbiguousMappingCandidateState["entities"];
}

function defaultState(group: AmbiguousMappingGroupDiagnosis): AmbiguousMappingGroupState {
  const state: AmbiguousMappingGroupState = {
    animeId: group.animeId,
    candidates: group.candidates.map((candidate) => {
      const isKeep = candidate.repair.status === "verified-keep";
      const providerId = candidate.providerId;
      return {
        provider: candidate.provider,
        providerId,
        legacyRows: [legacyRow(providerId)],
        entities: [
          {
            id: providerId === "150771:1" ? 9025 : 9509,
            provider: "thetvdb",
            providerId,
            providerSlug: providerId === "150771:1" ? "taiko-no-tatsujin" : "new-gigantor",
            providerUrl: null,
          },
        ],
        v2Associations: [v2Association(providerId)],
        authoritativeState: "ok",
        authoritativeEpisodes: isKeep ? KEEP_EPISODES : RETIRE_EPISODES,
        mappedProviderEpisodes: [],
      };
    }),
    sameProviderV2Associations: [],
  };
  return state;
}

function withCandidateState(
  state: AmbiguousMappingGroupState,
  providerId: string,
  overrides: CandidateStateOverrides,
): AmbiguousMappingGroupState {
  return {
    ...state,
    candidates: state.candidates.map((candidate) =>
      candidate.providerId === providerId
        ? { ...candidate, ...overrides }
        : candidate,
    ),
  };
}

describe("planAmbiguousMappingRepair", () => {
  test("clean repair-safe group produces the exact proposed parent-level writes", () => {
    const group = buildRepairSafeGroup();
    const plan = planAmbiguousMappingRepair({ group, state: defaultState(group) });

    expect(plan.plannable).toBe(true);
    expect(plan.blockReason).toBeNull();
    expect(plan.keep.providerId).toBe("150771:1");
    expect(plan.retirees.map((candidate) => candidate.providerId)).toEqual(["251746:1"]);

    expect(plan.episodeScope.keepAuthoritativeEpisodeCount).toBe(2);
    expect(plan.episodeScope.keepMappedEpisodeCount).toBe(0);
    expect(plan.episodeScope.retireAuthoritativeEpisodeCount).toBe(2);
    expect(plan.episodeScope.retireMappedEpisodeCount).toBe(0);
    expect(plan.episodeScope.keepRetireOverlappingProviderEpisodeIds).toEqual([]);

    expect(plan.proposedWrites?.legacyMappingsToRetire).toEqual([legacyRow("251746:1")]);
    expect(plan.proposedWrites?.v2AssociationsToRetire).toEqual([v2Association("251746:1")]);
    expect(plan.proposedWrites?.legacyMappingsToUpdate).toEqual([
      {
        id: 25036,
        old: { source: "api", confidence: 85, isPrimary: false },
        proposed: { source: "system", confidence: 95, isPrimary: true },
      },
    ]);
    expect(plan.proposedWrites?.v2AssociationsToUpdate).toEqual([
      {
        id: 16837,
        old: { source: "api", confidence: 85, isPrimary: false },
        proposed: { source: "system", confidence: 95, isPrimary: true },
      },
    ]);
    expect(plan.proposedWrites?.providerEntitiesKept.map((entity) => entity.id).sort()).toEqual([
      9025, 9509,
    ]);
  });

  test("group that is no longer repair-safe fails closed", () => {
    const anime: AmbiguousMappingAnimeIdentity = {
      ...taikoAnime,
      synonymsJson: '["Taiko no Tatsujin: Clay Anime"]',
    };
    const group = diagnoseAmbiguousMappingGroup({
      anime,
      candidates: [
        {
          provider: "thetvdb",
          providerId: "150771:1",
          providerUrl: null,
          source: "api",
          confidence: 85,
          isPrimary: false,
          evidence: keepEvidence(),
        },
        {
          provider: "thetvdb",
          providerId: "251746:1",
          providerUrl: null,
          source: "api",
          confidence: 85,
          isPrimary: false,
          evidence: {
            status: "ok",
            providerSeriesName: "Taiko no Tatsujin: Clay Anime",
            providerSlug: "taiko-no-tatsujin",
            providerFirstAired: "2005-04-04",
            providerSeasonFirstAired: null,
            providerSeasonEpisodeCount: 26,
            providerShowEpisodeCount: null,
          },
        },
      ],
    });
    expect(group.repairSafe).toBe(false);

    const plan = planAmbiguousMappingRepair({ group, state: defaultState(group) });
    expect(plan.plannable).toBe(false);
    expect(plan.blockReason).toBe("group-not-repair-safe");
    expect(plan.proposedWrites).toBeNull();
  });

  test("mapped provider episodes on a retire season fail closed", () => {
    const group = buildRepairSafeGroup();
    const state = withCandidateState(defaultState(group), "251746:1", {
      mappedProviderEpisodes: [mappedEpisode("200", { episodeMappingId: 7, animeId: 9999 })],
    });
    const plan = planAmbiguousMappingRepair({ group, state });

    expect(plan.plannable).toBe(false);
    expect(plan.blockReason).toBe("retire-season-episode-mappings-present");
    expect(plan.episodeScope.retireMappedEpisodeCount).toBe(1);
    expect(plan.episodeScope.retireMappedEpisodeTargets).toEqual([
      { animeId: 9999, localEpisodeNumber: 1, localKind: "normal", count: 1 },
    ]);
  });

  test("keep/retire episode ID overlap fails closed", () => {
    const group = buildRepairSafeGroup();
    const state = withCandidateState(defaultState(group), "251746:1", {
      authoritativeEpisodes: [
        { providerEpisodeId: "200", providerEpisodeNumber: 1, seasonNumber: 1 },
        { providerEpisodeId: "100", providerEpisodeNumber: 2, seasonNumber: 1 },
      ],
    });
    const plan = planAmbiguousMappingRepair({ group, state });

    expect(plan.plannable).toBe(false);
    expect(plan.blockReason).toBe("keep-retire-episode-id-overlap");
    expect(plan.episodeScope.keepRetireOverlappingProviderEpisodeIds).toEqual(["100"]);
  });

  test("manual legacy mapping on a retire candidate fails closed", () => {
    const group = buildRepairSafeGroup();
    const state = withCandidateState(defaultState(group), "251746:1", {
      legacyRows: [legacyRow("251746:1", { source: "manual" })],
    });
    const plan = planAmbiguousMappingRepair({ group, state });
    expect(plan.plannable).toBe(false);
    expect(plan.blockReason).toBe("manual-legacy-mapping-would-be-retired");
  });

  test("manual v2 association on a retire candidate fails closed", () => {
    const group = buildRepairSafeGroup();
    const state = withCandidateState(defaultState(group), "251746:1", {
      v2Associations: [v2Association("251746:1", { source: "manual" })],
    });
    const plan = planAmbiguousMappingRepair({ group, state });
    expect(plan.plannable).toBe(false);
    expect(plan.blockReason).toBe("manual-v2-association-would-be-retired");
  });

  test("explicit segments on the keep association fail closed", () => {
    const group = buildRepairSafeGroup();
    const state = withCandidateState(defaultState(group), "150771:1", {
      v2Associations: [v2Association("150771:1", { segmentCount: 2 })],
    });
    const plan = planAmbiguousMappingRepair({ group, state });
    expect(plan.plannable).toBe(false);
    expect(plan.blockReason).toBe("explicit-segments-on-keep-association");
  });

  test("explicit segments on a retire association fail closed", () => {
    const group = buildRepairSafeGroup();
    const state = withCandidateState(defaultState(group), "251746:1", {
      v2Associations: [v2Association("251746:1", { segmentCount: 1 })],
    });
    const plan = planAmbiguousMappingRepair({ group, state });
    expect(plan.plannable).toBe(false);
    expect(plan.blockReason).toBe("explicit-segments-on-retire-association");
  });

  test("missing keep legacy mapping fails closed", () => {
    const group = buildRepairSafeGroup();
    const state = withCandidateState(defaultState(group), "150771:1", {
      legacyRows: [],
    });
    const plan = planAmbiguousMappingRepair({ group, state });
    expect(plan.plannable).toBe(false);
    expect(plan.blockReason).toBe("keep-legacy-mapping-missing");
  });

  test("multiple keep legacy mappings fail closed", () => {
    const group = buildRepairSafeGroup();
    const state = withCandidateState(defaultState(group), "150771:1", {
      legacyRows: [legacyRow("150771:1"), legacyRow("150771:1", { id: 99999 })],
    });
    const plan = planAmbiguousMappingRepair({ group, state });
    expect(plan.plannable).toBe(false);
    expect(plan.blockReason).toBe("keep-legacy-ownership-ambiguous");
  });

  test("missing keep v2 association fails closed", () => {
    const group = buildRepairSafeGroup();
    const state = withCandidateState(defaultState(group), "150771:1", {
      v2Associations: [],
    });
    const plan = planAmbiguousMappingRepair({ group, state });
    expect(plan.plannable).toBe(false);
    expect(plan.blockReason).toBe("keep-v2-association-missing");
  });

  test("conflicting keep v2 associations fail closed", () => {
    const group = buildRepairSafeGroup();
    const state = withCandidateState(defaultState(group), "150771:1", {
      v2Associations: [
        v2Association("150771:1"),
        v2Association("150771:1", { id: 99999 }),
      ],
    });
    const plan = planAmbiguousMappingRepair({ group, state });
    expect(plan.plannable).toBe(false);
    expect(plan.blockReason).toBe("keep-v2-association-ambiguous");
  });

  test("unhandled same-provider v2 association fails closed", () => {
    const group = buildRepairSafeGroup();
    const state: AmbiguousMappingGroupState = {
      ...defaultState(group),
      sameProviderV2Associations: [v2Association("999999:1", { id: 55555, providerEntityId: 77777 })],
    };
    const plan = planAmbiguousMappingRepair({ group, state });
    expect(plan.plannable).toBe(false);
    expect(plan.blockReason).toBe("unhandled-same-provider-v2-associations");
  });

  test("incomplete authoritative season fails closed", () => {
    const group = buildRepairSafeGroup();
    const state = withCandidateState(defaultState(group), "251746:1", {
      authoritativeState: "empty",
      authoritativeEpisodes: [],
    });
    const plan = planAmbiguousMappingRepair({ group, state });
    expect(plan.plannable).toBe(false);
    expect(plan.blockReason).toBe("authoritative-episode-fetch-incomplete");
    expect(plan.episodeScope.seasonFetchStates).toContainEqual({
      providerId: "251746:1",
      state: "empty",
      episodeCount: 0,
    });
  });

  test("provider fetch failure fails closed", () => {
    const group = buildRepairSafeGroup();
    const state = withCandidateState(defaultState(group), "150771:1", {
      authoritativeState: "fetch-failed",
      authoritativeEpisodes: [],
    });
    const plan = planAmbiguousMappingRepair({ group, state });
    expect(plan.plannable).toBe(false);
    expect(plan.blockReason).toBe("provider-fetch-failed");
  });

  test("identity mismatch between current-state rows and diagnostic evidence fails closed", () => {
    const group = buildRepairSafeGroup();
    const state = withCandidateState(defaultState(group), "150771:1", {
      legacyRows: [legacyRow("150771:1", { providerSlug: "different-slug" })],
    });
    const plan = planAmbiguousMappingRepair({ group, state });
    expect(plan.plannable).toBe(false);
    expect(plan.blockReason).toBe("identity-mismatch-with-diagnostic-evidence");
  });

  test("retire candidate with no legacy rows but a clean v2 association stays plannable", () => {
    const group = buildRepairSafeGroup();
    const state = withCandidateState(defaultState(group), "251746:1", {
      legacyRows: [],
    });
    const plan = planAmbiguousMappingRepair({ group, state });

    expect(plan.plannable).toBe(true);
    expect(plan.blockReason).toBeNull();
    expect(plan.proposedWrites?.legacyMappingsToRetire).toEqual([]);
    expect(plan.proposedWrites?.v2AssociationsToRetire).toEqual([v2Association("251746:1")]);
  });

  test("mapped keep-season episodes are reported but never block and never get proposed writes", () => {
    const group = buildRepairSafeGroup();
    const state = withCandidateState(defaultState(group), "150771:1", {
      mappedProviderEpisodes: [mappedEpisode("100")],
    });
    const plan = planAmbiguousMappingRepair({ group, state });

    expect(plan.plannable).toBe(true);
    expect(plan.episodeScope.keepMappedEpisodeCount).toBe(1);
    expect(plan.episodeScope.keepMappedEpisodeTargets).toEqual([
      { animeId: 6471, localEpisodeNumber: 1, localKind: "normal", count: 1 },
    ]);
    expect(plan.proposedWrites?.legacyMappingsToRetire).toEqual([legacyRow("251746:1")]);
  });
});