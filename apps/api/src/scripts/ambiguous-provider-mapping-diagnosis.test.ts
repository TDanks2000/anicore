import { describe, expect, test } from "bun:test";

import {
  classifyAmbiguousMappingCandidate,
  diagnoseAmbiguousMappingGroup,
  type AmbiguousMappingAnimeIdentity,
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

describe("classifyAmbiguousMappingCandidate", () => {
  test("missing provider evidence is indeterminate", () => {
    const { classification, signal } = classifyAmbiguousMappingCandidate(taikoAnime, null);
    expect(classification).toBe("indeterminate");
    expect(signal).toBeNull();
  });

  test("exact title, exact date, matching count is a strong match", () => {
    const { classification, signal } = classifyAmbiguousMappingCandidate(taikoAnime, {
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
  });
});