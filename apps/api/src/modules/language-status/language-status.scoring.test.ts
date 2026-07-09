import { describe, expect, test } from "bun:test";

import {
  defaultEvidenceConfidence,
  mapLegacyAudioStatusToEpisodeStatus,
  resolveAnimeStatus,
  resolveAnimeStatusFromEvidence,
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
    ).toEqual({ status: "possible", confidence: 50 });

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

  test("legacy episode audio status maps to new episode language status", () => {
    expect(mapLegacyAudioStatusToEpisodeStatus("unavailable")).toBe("missing");
    expect(mapLegacyAudioStatusToEpisodeStatus("available")).toBe("available");
  });

  test("episode audio compatibility response is backed by language rows", () => {
    expect(
      toLegacyEpisodeAudioResponse(
        { id: 10 },
        [
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
        ],
      ),
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
});
