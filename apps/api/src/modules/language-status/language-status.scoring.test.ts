import { describe, expect, test } from "bun:test";

import {
  defaultEvidenceConfidence,
  mapLegacyAudioStatusToEpisodeStatus,
  resolveAnimeStatus,
  resolveAnimeStatusFromEvidence,
  resolveEpisodeStatuses,
  summarizeEpisodeCoverage,
  toLegacyEpisodeAudioResponse,
} from "./language-status.scoring";

describe("language status scoring", () => {
  test("missing evidence resolves to unknown", () => {
    expect(resolveAnimeStatusFromEvidence([])).toEqual({
      status: "unknown",
      confidence: 0,
    });
  });

  test("manual overrides beat automated evidence", () => {
    expect(
      resolveAnimeStatus({
        manualOverride: { status: "not_available", confidence: 100 },
        evidence: [
          {
            source: "provider",
            evidenceType: "provider_audio",
            value: "available",
            confidence: 90,
          },
        ],
      }),
    ).toEqual({ status: "not_available", confidence: 100 });
  });

  test("official provider evidence resolves to confirmed", () => {
    const confidence = defaultEvidenceConfidence({
      source: "provider",
      evidenceType: "provider_subtitle",
    });

    expect(confidence).toBe(90);
    expect(
      resolveAnimeStatusFromEvidence([
        {
          source: "provider",
          evidenceType: "provider_subtitle",
          value: "available",
          confidence,
        },
      ]),
    ).toEqual({ status: "confirmed", confidence: 90 });
  });

  test("only reliable explicit negative evidence resolves to not_available", () => {
    expect(
      resolveAnimeStatusFromEvidence([
        {
          source: "community",
          evidenceType: "community_submission",
          value: "not_available",
          confidence: 50,
        },
      ]),
    ).toEqual({ status: "unknown", confidence: 0 });

    expect(
      resolveAnimeStatusFromEvidence([
        {
          source: "official_site",
          evidenceType: "official_announcement",
          value: "not_available",
          confidence: 90,
        },
      ]),
    ).toEqual({ status: "not_available", confidence: 90 });
  });

  test("explicit partial evidence resolves to partial", () => {
    expect(
      resolveAnimeStatusFromEvidence([
        {
          source: "provider",
          evidenceType: "provider_audio",
          value: "partial",
          confidence: 80,
        },
      ]),
    ).toEqual({ status: "partial", confidence: 80 });
  });

  test("conflicting reliable availability resolves to unknown, independent of order", () => {
    const positive = {
      source: "provider" as const,
      evidenceType: "provider_audio" as const,
      value: "available",
      confidence: 90,
    };
    const negative = { ...positive, value: "not_available" };
    for (const evidence of [
      [positive, negative],
      [negative, positive],
    ])
      expect(resolveAnimeStatusFromEvidence(evidence)).toEqual({
        status: "unknown",
        confidence: 0,
      });
  });

  test("partial episode coverage is not upgraded by cast existence evidence", () => {
    expect(
      resolveAnimeStatusFromEvidence([
        { source: "provider", evidenceType: "provider_audio", value: "partial", confidence: 90 },
        { source: "provider", evidenceType: "voice_cast", value: "available", confidence: 75 },
      ]),
    ).toEqual({ status: "partial", confidence: 90 });
  });

  test("unknown and future schedules are never positive evidence", () => {
    for (const value of ["unknown", "scheduled", "announced", "", "missing"])
      expect(
        resolveAnimeStatusFromEvidence([
          { source: "community", evidenceType: "community_submission", value, confidence: 50 },
        ]),
      ).toEqual({ status: "unknown", confidence: 0 });
  });

  test("legacy episode audio status maps to new episode language status", () => {
    expect(mapLegacyAudioStatusToEpisodeStatus("unavailable")).toBe("missing");
    expect(mapLegacyAudioStatusToEpisodeStatus("available")).toBe("available");
  });

  test("episode audio compatibility response is backed by language rows", () => {
    expect(
      toLegacyEpisodeAudioResponse({ id: 10 }, [
        {
          languageCode: "en",
          mediaType: "audio",
          status: "available",
          provider: "manual",
        },
        {
          languageCode: "en",
          mediaType: "subtitle",
          status: "available",
          provider: "manual",
        },
      ]),
    ).toEqual([
      {
        languageCode: "en",
        mediaType: "audio",
        status: "available",
        provider: "manual",
        episodeId: 10,
        audioMode: "dub",
        locale: "en",
        sourceProvider: "manual",
      },
    ]);
  });

  test("episode statuses resolve to one per episode, manual first, ties abstain", () => {
    const vote = (
      episodeNumber: number,
      status: "available" | "missing" | "unknown" | "partial",
      confidence: number,
      provider: string,
    ) => ({ episodeNumber, status, confidence, provider });
    const resolved = resolveEpisodeStatuses([
      vote(2, "available", 95, "crunchyroll"),
      vote(1, "available", 75, "derived-airdate"),
      vote(1, "available", 95, "crunchyroll"),
      vote(3, "available", 90, "animeschedule"),
      vote(3, "missing", 90, "other"),
      vote(4, "missing", 50, "manual"),
      vote(4, "available", 95, "crunchyroll"),
      vote(5, "unknown", 99, "other"),
      vote(5, "partial", 60, "other"),
    ]);
    expect(resolved.map((row) => [row.episodeNumber, row.status, row.provider])).toEqual([
      [1, "available", "crunchyroll"],
      [2, "available", "crunchyroll"],
      [3, "unknown", "animeschedule"],
      [4, "missing", "manual"],
      [5, "partial", "other"],
    ]);
    expect(summarizeEpisodeCoverage(resolved, [1, 2, 3, 4, 5, 6])).toEqual({
      totalEpisodes: 6,
      available: 3,
      missing: 1,
      unknown: 2,
    });
  });
});
