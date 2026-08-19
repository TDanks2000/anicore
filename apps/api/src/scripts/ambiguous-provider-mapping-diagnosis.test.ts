import { describe, expect, test } from "bun:test";

import {
  assessCandidateRepairSafety,
  classifyAmbiguousMappingCandidate,
  diagnoseAmbiguousMappingGroup,
  parseProviderSeasonId,
  type AmbiguousMappingAnimeIdentity,
  type AmbiguousMappingProviderEvidence,
} from "./ambiguous-provider-mapping-diagnosis";

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

const maoAnime: AmbiguousMappingAnimeIdentity = {
  animeId: 19093,
  titleRomaji: "MAO",
  titleEnglish: null,
  titleNative: null,
  titleUserPreferred: null,
  synonymsJson: "[]",
  episodeCount: 26,
  startDate: "2026-04-04",
  format: "TV",
  seasonYear: 2026,
};

describe("parseProviderSeasonId", () => {
  test("accepts exactly two positive integer components", () => {
    expect(parseProviderSeasonId("150771:1")).toEqual({ showId: 150771, seasonNumber: 1 });
  });

  test("rejects extra colon components", () => {
    expect(parseProviderSeasonId("150771:1:extra")).toBeNull();
    expect(parseProviderSeasonId("150771:1:2")).toBeNull();
  });

  test("rejects missing, non-numeric, or non-positive components", () => {
    expect(parseProviderSeasonId("150771")).toBeNull();
    expect(parseProviderSeasonId(":1")).toBeNull();
    expect(parseProviderSeasonId("150771:")).toBeNull();
    expect(parseProviderSeasonId("abc:1")).toBeNull();
    expect(parseProviderSeasonId("150771:abc")).toBeNull();
    expect(parseProviderSeasonId("150771:0")).toBeNull();
    expect(parseProviderSeasonId("-1:1")).toBeNull();
  });
});

describe("classifyAmbiguousMappingCandidate", () => {
  test("missing provider evidence is indeterminate", () => {
    const { classification, signal } = classifyAmbiguousMappingCandidate(taikoAnime, null);
    expect(classification).toBe("indeterminate");
    expect(signal).toBeNull();
  });

  test("exact title, exact date, matching count is a strong match", () => {
    const { classification, signal } = classifyAmbiguousMappingCandidate(taikoAnime, {
      status: "ok",
      providerSeriesName: "Taiko no Tatsujin: Clay Anime",
      providerSlug: "taiko-no-tatsujin",
      providerFirstAired: "2005-04-04",
      providerSeasonFirstAired: null,
      providerSeasonEpisodeCount: 26,
      providerShowEpisodeCount: null,
    });
    expect(classification).toBe("strong-match");
    expect(signal?.titleMatch).toBe(true);
    expect(signal?.dateExact).toBe(true);
    expect(signal?.countMatch).toBe(true);
  });

  test("totally unrelated series in a different year is a mismatch", () => {
    const { classification, signal } = classifyAmbiguousMappingCandidate(taikoAnime, {
      status: "ok",
      providerSeriesName: "太陽の使者 鉄人28号",
      providerSlug: "new-gigantor",
      providerFirstAired: "1980-10-03",
      providerSeasonFirstAired: null,
      providerSeasonEpisodeCount: 51,
      providerShowEpisodeCount: null,
    });
    expect(classification).toBe("mismatch");
    expect(signal?.titleMatch).toBe(false);
    expect(signal?.yearDistance).toBe(25);
  });

  test("placeholder slug with unrelated name and far date is a mismatch", () => {
    const { classification } = classifyAmbiguousMappingCandidate(maoAnime, {
      status: "ok",
      providerSeriesName: "Mio Mao",
      providerSlug: "284361-show",
      providerFirstAired: "1974-01-01",
      providerSeasonFirstAired: null,
      providerSeasonEpisodeCount: 13,
      providerShowEpisodeCount: null,
    });
    expect(classification).toBe("mismatch");
  });

  test("title mismatch with matching year stays indeterminate", () => {
    const { classification } = classifyAmbiguousMappingCandidate(taikoAnime, {
      status: "ok",
      providerSeriesName: "Another 2005 Short",
      providerSlug: "another-2005-short",
      providerFirstAired: "2005-01-01",
      providerSeasonFirstAired: null,
      providerSeasonEpisodeCount: 26,
      providerShowEpisodeCount: null,
    });
    expect(classification).toBe("indeterminate");
  });

  test("matching title with far date and far count is indeterminate", () => {
    const { classification } = classifyAmbiguousMappingCandidate(maoAnime, {
      status: "ok",
      providerSeriesName: "MAO",
      providerSlug: "mao",
      providerFirstAired: "1974-01-01",
      providerSeasonFirstAired: null,
      providerSeasonEpisodeCount: 13,
      providerShowEpisodeCount: null,
    });
    expect(classification).toBe("indeterminate");
  });

  test("title match plus year match but count unknown is likely", () => {
    const { classification } = classifyAmbiguousMappingCandidate(maoAnime, {
      status: "ok",
      providerSeriesName: "MAO",
      providerSlug: "mao",
      providerFirstAired: "2026-06-01",
      providerSeasonFirstAired: null,
      providerSeasonEpisodeCount: null,
      providerShowEpisodeCount: null,
    });
    expect(classification).toBe("likely-match");
  });
  test("show-level exact date wins even when the season airs later", () => {
    const anime: AmbiguousMappingAnimeIdentity = {
      animeId: 5559,
      titleRomaji: "Doraemon (1979)",
      titleEnglish: null,
      titleNative: null,
      titleUserPreferred: null,
      synonymsJson: "[]",
      episodeCount: 1787,
      startDate: "1979-04-02",
      format: "TV_SHORT",
      seasonYear: 1979,
    };
    const { classification, signal } = classifyAmbiguousMappingCandidate(anime, {
      status: "ok",
      providerSeriesName: "Doraemon",
      providerSlug: "doraemon-1979",
      providerFirstAired: "1979-04-02",
      providerSeasonFirstAired: "1980-01-04",
      providerSeasonEpisodeCount: 264,
      providerShowEpisodeCount: null,
    });
    expect(classification).toBe("strong-match");
    expect(signal?.dateExact).toBe(true);
    expect(signal?.yearDistance).toBe(0);
  });

  test("season-level exact date matches when the show started earlier", () => {
    const anime: AmbiguousMappingAnimeIdentity = {
      animeId: 4966,
      titleRomaji: "Bishoujo Senshi Sailor Moon: Crystal - Death Busters-hen",
      titleEnglish: null,
      titleNative: null,
      titleUserPreferred: null,
      synonymsJson: '["Sailor Moon Crystal", "Bishoujo Senshi Sailor Moon Crystal"]',
      episodeCount: 13,
      startDate: "2016-04-04",
      format: "TV",
      seasonYear: 2016,
    };
    const { classification, signal } = classifyAmbiguousMappingCandidate(anime, {
      status: "ok",
      providerSeriesName: "Sailor Moon Crystal",
      providerSlug: "sailor-moon-crystal",
      providerFirstAired: "2014-07-05",
      providerSeasonFirstAired: "2016-04-04",
      providerSeasonEpisodeCount: 13,
      providerShowEpisodeCount: null,
    });
    expect(classification).toBe("strong-match");
    expect(signal?.dateExact).toBe(true);
    expect(signal?.yearDistance).toBe(0);
  });

  test("evidence with a fetch-failed status is indeterminate, not a match", () => {
    const { classification, signal } = classifyAmbiguousMappingCandidate(maoAnime, {
      status: "fetch-failed",
      providerSeriesName: null,
      providerSlug: null,
      providerFirstAired: null,
      providerSeasonFirstAired: null,
      providerSeasonEpisodeCount: null,
      providerShowEpisodeCount: null,
    });
    expect(classification).toBe("indeterminate");
    expect(signal).toBeNull();
  });
});

function seasonProofKeep(): AmbiguousMappingProviderEvidence {
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

describe("repair-safe eligibility (fail-closed, stricter than classification)", () => {
  test("title match + exact date + wildly wrong count stays strong-match diagnostically but is NOT repair-safe", () => {
    const evidence: AmbiguousMappingProviderEvidence = {
      status: "ok",
      providerSeriesName: "MAO",
      providerSlug: "mao",
      providerFirstAired: "2026-04-04",
      providerSeasonFirstAired: "2026-04-04",
      providerSeasonEpisodeCount: 1,
      providerShowEpisodeCount: 1,
    };
    const { classification, signal } = classifyAmbiguousMappingCandidate(maoAnime, evidence);
    expect(classification).toBe("strong-match");
    expect(signal?.countMatch).toBe(false);
    const assessment = assessCandidateRepairSafety(maoAnime, evidence, signal);
    expect(assessment.status).toBe("not-repair-safe");
  });

  test("title match + year within 1 + count within 2 is NOT repair-safe", () => {
    const evidence: AmbiguousMappingProviderEvidence = {
      status: "ok",
      providerSeriesName: "Taiko no Tatsujin: Clay Anime",
      providerSlug: "taiko-no-tatsujin",
      providerFirstAired: "2006-01-01",
      providerSeasonFirstAired: null,
      providerSeasonEpisodeCount: 27,
      providerShowEpisodeCount: null,
    };
    const { classification, signal } = classifyAmbiguousMappingCandidate(taikoAnime, evidence);
    expect(classification).toBe("strong-match");
    expect(signal?.yearMatch).toBe(true);
    expect(signal?.countMatch).toBe(true);
    const assessment = assessCandidateRepairSafety(taikoAnime, evidence, signal);
    expect(assessment.status).toBe("not-repair-safe");
  });

  test("exact season date + exact season count + strong title is a repair-safe verified-keep (season proof)", () => {
    const evidence: AmbiguousMappingProviderEvidence = {
      status: "ok",
      providerSeriesName: "MAO",
      providerSlug: "mao",
      providerFirstAired: null,
      providerSeasonFirstAired: "2026-04-04",
      providerSeasonEpisodeCount: 26,
      providerShowEpisodeCount: null,
    };
    const { signal } = classifyAmbiguousMappingCandidate(maoAnime, evidence);
    const assessment = assessCandidateRepairSafety(maoAnime, evidence, signal);
    expect(assessment.status).toBe("verified-keep");
    expect(assessment.proofScope).toBe("season");
  });

  test("exact show date + exact show count + strong title is a repair-safe verified-keep (show proof)", () => {
    const evidence: AmbiguousMappingProviderEvidence = {
      status: "ok",
      providerSeriesName: "Taiko no Tatsujin: Clay Anime",
      providerSlug: "taiko-no-tatsujin",
      providerFirstAired: "2005-04-04",
      providerSeasonFirstAired: null,
      providerSeasonEpisodeCount: null,
      providerShowEpisodeCount: 26,
    };
    const { signal } = classifyAmbiguousMappingCandidate(taikoAnime, evidence);
    const assessment = assessCandidateRepairSafety(taikoAnime, evidence, signal);
    expect(assessment.status).toBe("verified-keep");
    expect(assessment.proofScope).toBe("show");
  });

  test("exact show date + exact show count + mismatching season count uses the show scope, never mixes scopes", () => {
    const evidence: AmbiguousMappingProviderEvidence = {
      status: "ok",
      providerSeriesName: "Taiko no Tatsujin: Clay Anime",
      providerSlug: "taiko-no-tatsujin",
      providerFirstAired: "2005-04-04",
      providerSeasonFirstAired: "2005-04-04",
      providerSeasonEpisodeCount: 13,
      providerShowEpisodeCount: 26,
    };
    const { signal } = classifyAmbiguousMappingCandidate(taikoAnime, evidence);
    const assessment = assessCandidateRepairSafety(taikoAnime, evidence, signal);
    expect(assessment.status).toBe("verified-keep");
    expect(assessment.proofScope).toBe("show");
  });

  test("exact show date + exact season count but no show count is NOT repair-safe (mixing scopes)", () => {
    const evidence: AmbiguousMappingProviderEvidence = {
      status: "ok",
      providerSeriesName: "Taiko no Tatsujin: Clay Anime",
      providerSlug: "taiko-no-tatsujin",
      providerFirstAired: "2005-04-04",
      providerSeasonFirstAired: null,
      providerSeasonEpisodeCount: 26,
      providerShowEpisodeCount: null,
    };
    const { signal } = classifyAmbiguousMappingCandidate(taikoAnime, evidence);
    const assessment = assessCandidateRepairSafety(taikoAnime, evidence, signal);
    expect(assessment.status).toBe("not-repair-safe");
  });

  test("missing exact episode-count evidence is NOT repair-safe", () => {
    const evidence: AmbiguousMappingProviderEvidence = {
      status: "ok",
      providerSeriesName: "MAO",
      providerSlug: "mao",
      providerFirstAired: null,
      providerSeasonFirstAired: "2026-04-04",
      providerSeasonEpisodeCount: null,
      providerShowEpisodeCount: null,
    };
    const { classification, signal } = classifyAmbiguousMappingCandidate(maoAnime, evidence);
    expect(classification).toBe("strong-match");
    const assessment = assessCandidateRepairSafety(maoAnime, evidence, signal);
    expect(assessment.status).toBe("not-repair-safe");
  });

  test("malformed provider ID yields no evidence and is NOT repair-safe", () => {
    expect(parseProviderSeasonId("150771:1:extra")).toBeNull();
    const { classification, signal } = classifyAmbiguousMappingCandidate(taikoAnime, {
      status: "malformed",
      providerSeriesName: null,
      providerSlug: null,
      providerFirstAired: null,
      providerSeasonFirstAired: null,
      providerSeasonEpisodeCount: null,
      providerShowEpisodeCount: null,
    });
    expect(classification).toBe("indeterminate");
    const assessment = assessCandidateRepairSafety(taikoAnime, null, signal);
    expect(assessment.status).toBe("not-repair-safe");
    expect(assessment.blockReason).toBe("missing-provider-evidence");
  });

  test("verified-retire requires positive contradiction, not merely a failed title threshold", () => {
    const closeEvidence: AmbiguousMappingProviderEvidence = {
      status: "ok",
      providerSeriesName: "Another 2005 Short",
      providerSlug: "another-2005-short",
      providerFirstAired: "2005-01-01",
      providerSeasonFirstAired: null,
      providerSeasonEpisodeCount: 26,
      providerShowEpisodeCount: null,
    };
    const { signal: closeSignal } = classifyAmbiguousMappingCandidate(taikoAnime, closeEvidence);
    const closeAssessment = assessCandidateRepairSafety(taikoAnime, closeEvidence, closeSignal);
    expect(closeAssessment.status).toBe("not-repair-safe");

    const contradictedEvidence: AmbiguousMappingProviderEvidence = {
      status: "ok",
      providerSeriesName: "太陽の使者 鉄人28号",
      providerSlug: "new-gigantor",
      providerFirstAired: "1980-10-03",
      providerSeasonFirstAired: null,
      providerSeasonEpisodeCount: 51,
      providerShowEpisodeCount: null,
    };
    const { signal: contradictedSignal } = classifyAmbiguousMappingCandidate(
      taikoAnime,
      contradictedEvidence,
    );
    const contradictedAssessment = assessCandidateRepairSafety(
      taikoAnime,
      contradictedEvidence,
      contradictedSignal,
    );
    expect(contradictedAssessment.status).toBe("verified-retire");
  });
});

describe("diagnoseAmbiguousMappingGroup", () => {
  test("one strong match among mismatches is exactly-one-strong-match", () => {
    const group = diagnoseAmbiguousMappingGroup({
      anime: taikoAnime,
      candidates: [
        {
          provider: "thetvdb",
          providerId: "150771:1",
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
        {
          provider: "thetvdb",
          providerId: "251746:1",
          providerUrl: null,
          source: "api",
          confidence: 85,
          isPrimary: false,
          evidence: {
            status: "ok",
            providerSeriesName: "太陽の使者 鉄人28号",
            providerSlug: "new-gigantor",
            providerFirstAired: "1980-10-03",
            providerSeasonFirstAired: null,
            providerSeasonEpisodeCount: 51,
            providerShowEpisodeCount: null,
          },
        },
      ],
    });
    expect(group.verdict).toBe("exactly-one-strong-match");
    expect(group.strongMatchCount).toBe(1);
    expect(group.mismatchCount).toBe(1);
  });

  test("two strong matches is multiple-strong-match", () => {
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
        {
          provider: "thetvdb",
          providerId: "251746:1",
          providerUrl: null,
          source: "api",
          confidence: 85,
          isPrimary: false,
          evidence: {
            status: "ok",
            providerSeriesName: "Taiko no Tatsujin",
            providerSlug: "taiko-no-tatsujin",
            providerFirstAired: "2005-04-04",
            providerSeasonFirstAired: null,
            providerSeasonEpisodeCount: 26,
            providerShowEpisodeCount: null,
          },
        },
      ],
    });
    expect(group.verdict).toBe("multiple-strong-match");
    expect(group.strongMatchCount).toBe(2);
  });

  test("no strong match but mismatches present is no-strong-match", () => {
    const group = diagnoseAmbiguousMappingGroup({
      anime: taikoAnime,
      candidates: [
        {
          provider: "thetvdb",
          providerId: "251746:1",
          providerUrl: null,
          source: "api",
          confidence: 85,
          isPrimary: false,
          evidence: {
            status: "ok",
            providerSeriesName: "太陽の使者 鉄人28号",
            providerSlug: "new-gigantor",
            providerFirstAired: "1980-10-03",
            providerSeasonFirstAired: null,
            providerSeasonEpisodeCount: 51,
            providerShowEpisodeCount: null,
          },
        },
        {
          provider: "thetvdb",
          providerId: "999999:1",
          providerUrl: null,
          source: "api",
          confidence: 85,
          isPrimary: false,
          evidence: {
            status: "ok",
            providerSeriesName: "Unrelated",
            providerSlug: "unrelated",
            providerFirstAired: "1990-01-01",
            providerSeasonFirstAired: null,
            providerSeasonEpisodeCount: 10,
            providerShowEpisodeCount: null,
          },
        },
      ],
    });
    expect(group.verdict).toBe("no-strong-match");
    expect(group.mismatchCount).toBe(2);
  });

  test("no candidates is no-candidates", () => {
    const group = diagnoseAmbiguousMappingGroup({ anime: taikoAnime, candidates: [] });
    expect(group.verdict).toBe("no-candidates");
    expect(group.repairSafe).toBe(false);
  });

  test("one verified-keep with a verified-retire sibling is a repair-safe group", () => {
    const group = diagnoseAmbiguousMappingGroup({
      anime: taikoAnime,
      candidates: [
        {
          provider: "thetvdb",
          providerId: "150771:1",
          providerUrl: null,
          source: "api",
          confidence: 85,
          isPrimary: false,
          evidence: seasonProofKeep(),
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
            providerSeriesName: "太陽の使者 鉄人28号",
            providerSlug: "new-gigantor",
            providerFirstAired: "1980-10-03",
            providerSeasonFirstAired: null,
            providerSeasonEpisodeCount: 51,
            providerShowEpisodeCount: null,
          },
        },
      ],
    });
    expect(group.repairSafe).toBe(true);
    expect(group.repairBlockReason).toBeNull();
    expect(group.verifiedKeepCount).toBe(1);
    expect(group.verifiedRetireCount).toBe(1);
  });

  test("one repair-safe candidate with an indeterminate sibling is NOT repair-safe", () => {
    const group = diagnoseAmbiguousMappingGroup({
      anime: taikoAnime,
      candidates: [
        {
          provider: "thetvdb",
          providerId: "150771:1",
          providerUrl: null,
          source: "api",
          confidence: 85,
          isPrimary: false,
          evidence: seasonProofKeep(),
        },
        {
          provider: "thetvdb",
          providerId: "999999:1",
          providerUrl: null,
          source: "api",
          confidence: 85,
          isPrimary: false,
          evidence: {
            status: "ok",
            providerSeriesName: "Another 2005 Short",
            providerSlug: "another-2005-short",
            providerFirstAired: "2005-01-01",
            providerSeasonFirstAired: null,
            providerSeasonEpisodeCount: 26,
            providerShowEpisodeCount: null,
          },
        },
      ],
    });
    expect(group.repairSafe).toBe(false);
    expect(group.repairBlockReason).toContain("not-repair-safe-sibling");
  });

  test("one repair-safe candidate with a provider fetch-failure sibling is NOT repair-safe", () => {
    const group = diagnoseAmbiguousMappingGroup({
      anime: taikoAnime,
      candidates: [
        {
          provider: "thetvdb",
          providerId: "150771:1",
          providerUrl: null,
          source: "api",
          confidence: 85,
          isPrimary: false,
          evidence: seasonProofKeep(),
        },
        {
          provider: "thetvdb",
          providerId: "999999:1",
          providerUrl: null,
          source: "api",
          confidence: 85,
          isPrimary: false,
          evidence: {
            status: "fetch-failed",
            providerSeriesName: null,
            providerSlug: null,
            providerFirstAired: null,
            providerSeasonFirstAired: null,
            providerSeasonEpisodeCount: null,
            providerShowEpisodeCount: null,
          },
        },
      ],
    });
    expect(group.repairSafe).toBe(false);
    expect(group.repairBlockReason).toContain("provider-fetch-failed");
  });

  test("two repair-safe candidates is NOT repair-safe", () => {
    const group = diagnoseAmbiguousMappingGroup({
      anime: taikoAnime,
      candidates: [
        {
          provider: "thetvdb",
          providerId: "150771:1",
          providerUrl: null,
          source: "api",
          confidence: 85,
          isPrimary: false,
          evidence: seasonProofKeep(),
        },
        {
          provider: "thetvdb",
          providerId: "250000:1",
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
            providerSeasonEpisodeCount: null,
            providerShowEpisodeCount: 26,
          },
        },
      ],
    });
    expect(group.repairSafe).toBe(false);
    expect(group.repairBlockReason).toContain("multiple-verified-keep-candidates");
  });
});