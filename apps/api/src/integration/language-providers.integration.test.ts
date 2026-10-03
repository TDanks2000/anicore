import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeDb, db } from "@anicore/db";
import {
  replaceProviderLanguageSnapshot,
  syncAnimeLanguageEvidenceFromEpisodeStatuses,
} from "@anicore/db/language-status";
import {
  anime,
  animeLanguageEvidence,
  animeLanguageStatus,
  animeMappings,
  episodeLanguageStatus,
  episodes,
} from "@anicore/db/schema";
import { syncAnilistCastLanguages } from "@anicore/providers/anilist/languages";
import type { AnimeScheduleEntry } from "@anicore/providers/animeschedule/client";
import { syncDubStatus } from "@anicore/providers/animeschedule/sync";
import { syncVoiceCastLanguages } from "@anicore/providers/jikan/sync";
import { syncKitsuLanguages } from "@anicore/providers/kitsu/languages";
import { and, eq } from "drizzle-orm";
import { auditLanguageStatus } from "../scripts/audit-language-status";
import { resetTestDatabase } from "../test/database";

const ZERO = "0001-01-01T00:00:00Z";
function schedule(overrides: Partial<AnimeScheduleEntry> = {}): AnimeScheduleEntry {
  return {
    id: "NoXc",
    title: "Cowboy Bebop",
    route: "cowboy-bebop",
    premier: "1998-04-02T16:00:00Z",
    dubPremier: ZERO,
    subPremier: ZERO,
    jpnTime: "2020-06-14T16:00:00Z",
    dubTime: "2023-03-18T16:01:00Z",
    subTime: "2023-03-18T16:01:00Z",
    episodes: 26,
    status: "Finished",
    websites: { aniList: "anilist.co/anime/1", mal: "myanimelist.net/anime/1" },
    episodeOverride: { overrideDate: ZERO, overrideEpisode: 0, episodesAired: 0 },
    subEpisodeOverride: { overrideDate: ZERO, overrideEpisode: 0, episodesAired: 0 },
    dubEpisodeOverride: { overrideDate: ZERO, overrideEpisode: 0, episodesAired: 0 },
    ...overrides,
  };
}
const opts = {
  animeId: 1,
  anilistId: "1",
  slug: "cowboy-bebop",
  titleRomaji: "Cowboy Bebop",
  titleEnglish: "Cowboy Bebop",
};
let network: ReturnType<typeof spyOn> | undefined;

async function seed(count = 26) {
  await db.insert(anime).values({
    id: 1,
    slug: "cowboy-bebop",
    titleRomaji: "Cowboy Bebop",
    episodeCount: count,
    status: "FINISHED",
  });
  await db.insert(animeMappings).values([
    { animeId: 1, provider: "anilist", providerId: "1", source: "api", isPrimary: true },
    { animeId: 1, provider: "mal", providerId: "1", source: "api", isPrimary: true },
  ]);
  if (count)
    await db.insert(episodes).values(
      Array.from({ length: count }, (_, index) => ({
        animeId: 1,
        number: index + 1,
        sortNumber: index + 1,
      })),
    );
}
function fakeSchedule(entry: AnimeScheduleEntry, status = 200) {
  network = spyOn(globalThis, "fetch").mockImplementation((async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const body = url.search ? { page: 1, totalAmount: 1, anime: [entry] } : entry;
    return Response.json(body, { status });
  }) as typeof fetch);
}
async function status(languageCode = "en", mediaType: "audio" | "subtitle" = "audio") {
  return (
    await db
      .select()
      .from(animeLanguageStatus)
      .where(
        and(
          eq(animeLanguageStatus.animeId, 1),
          eq(animeLanguageStatus.languageCode, languageCode),
          eq(animeLanguageStatus.mediaType, mediaType),
        ),
      )
  )[0];
}
async function staleNegative() {
  await db.insert(episodeLanguageStatus).values(
    Array.from({ length: 26 }, (_, index) => ({
      animeId: 1,
      episodeNumber: index + 1,
      languageCode: "en",
      mediaType: "audio" as const,
      provider: "animeschedule",
      status: "missing" as const,
      confidence: 90,
    })),
  );
  await syncAnimeLanguageEvidenceFromEpisodeStatuses({
    animeId: 1,
    languageCode: "en",
    mediaType: "audio",
    provider: "animeschedule",
    sourceUrl: "https://animeschedule.net/anime/old-route",
  });
}

describe("verified language providers", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    await seed();
  });
  afterEach(() => {
    network?.mockRestore();
    network = undefined;
  });
  afterAll(closeDb);

  test("repairs Cowboy Bebop false negatives, retires old route evidence and confirms both tracks", async () => {
    await staleNegative();
    expect((await status())?.status).toBe("not_available");
    fakeSchedule(schedule());
    expect(await syncDubStatus(opts)).toMatchObject({
      status: "matched-dub",
      episodesMarked: 0,
      subtitlesMarked: 0,
    });
    expect((await status())?.status).toBe("confirmed");
    expect((await status("en", "subtitle"))?.status).toBe("confirmed");
    expect(await db.select().from(episodeLanguageStatus)).toHaveLength(0);
    const evidence = await db.select().from(animeLanguageEvidence);
    expect(evidence).toHaveLength(2);
    expect(
      evidence.every(
        (row) =>
          row.sourceUrl === "https://animeschedule.net/anime/cowboy-bebop" &&
          row.value === "available",
      ),
    ).toBe(true);
    expect(network).toHaveBeenCalledTimes(1);
    expect(String(network!.mock.calls[0]![0])).toContain("anilist-ids=1");
  });

  test("finished original broadcast plus first dub premiere marks only episode one", async () => {
    fakeSchedule(schedule({ dubPremier: "2026-01-01T00:00:00Z" }));
    expect(await syncDubStatus(opts)).toMatchObject({
      status: "matched-ongoing-dub",
      episodesMarked: 1,
    });
    expect(await db.select().from(episodeLanguageStatus)).toMatchObject([
      { episodeNumber: 1, status: "available" },
    ]);
    expect((await status())?.status).toBe("partial");
  });

  test("a full explicit released batch can confirm complete coverage", async () => {
    fakeSchedule(
      schedule({
        dubEpisodeOverride: {
          overrideDate: "2026-01-01T00:00:00Z",
          overrideEpisode: 26,
          episodesAired: 25,
        },
      }),
    );
    expect(await syncDubStatus(opts)).toMatchObject({
      status: "matched-fully-dubbed",
      episodesMarked: 26,
    });
    expect((await status())?.status).toBe("confirmed");
  });

  test("incompatible episode counts never transfer provider numbering", async () => {
    fakeSchedule(schedule({ episodes: 13, dubPremier: "2026-01-01T00:00:00Z" }));
    expect(await syncDubStatus(opts)).toMatchObject({ episodesMarked: 0 });
    expect(await db.select().from(episodeLanguageStatus)).toHaveLength(0);
    expect((await status())?.status).toBe("confirmed");
  });

  test("missing premiere and time data erase the old negative without replacing it with absence", async () => {
    await staleNegative();
    fakeSchedule(schedule({ dubTime: ZERO, subTime: ZERO }));
    expect(await syncDubStatus(opts)).toMatchObject({ status: "matched-unknown" });
    expect((await status())?.status).toBe("unknown");
    expect(await db.select().from(animeLanguageEvidence)).toHaveLength(0);
  });

  test("a server error preserves the previously verified identity and snapshot", async () => {
    fakeSchedule(schedule());
    await syncDubStatus(opts);
    network!.mockRestore();
    fakeSchedule(schedule(), 503);
    await expect(syncDubStatus(opts)).rejects.toThrow("503");
    expect((await status())?.status).toBe("confirmed");
    expect(
      await db.select().from(animeMappings).where(eq(animeMappings.provider, "animeschedule")),
    ).toHaveLength(1);
  });

  test("manual overrides and unrelated evidence survive provider replacements", async () => {
    await db.insert(animeLanguageStatus).values({
      animeId: 1,
      languageCode: "en",
      mediaType: "audio",
      status: "not_available",
      confidence: 100,
      isManualOverride: true,
    });
    await db.insert(animeLanguageEvidence).values({
      animeId: 1,
      languageCode: "fr",
      mediaType: "audio",
      source: "manual",
      evidenceType: "manual_verified",
      value: "available",
      confidence: 100,
    });
    fakeSchedule(schedule());
    await syncDubStatus(opts);
    expect(await status()).toMatchObject({ status: "not_available", isManualOverride: true });
    expect(
      await db
        .select()
        .from(animeLanguageEvidence)
        .where(eq(animeLanguageEvidence.source, "manual")),
    ).toHaveLength(1);
  });

  test("contradictory sibling IDs withdraw schedule evidence and are reported", async () => {
    fakeSchedule(schedule());
    await syncDubStatus(opts);
    network!.mockRestore();
    fakeSchedule(
      schedule({ websites: { aniList: "anilist.co/anime/1", mal: "myanimelist.net/anime/5" } }),
    );
    await expect(syncDubStatus(opts)).rejects.toThrow("conflicts with the stored MAL identity");
    expect((await status())?.status).toBe("unknown");
  });

  test("voice-cast fallback records multiple languages only at anime level", async () => {
    const cast = [
      {
        character: { mal_id: 1, name: "Spike" },
        role: "Main",
        voice_actors: [
          { language: "English", person: { mal_id: 12, name: "Steve Blum" } },
          { language: "Portuguese (BR)", person: { mal_id: 13, name: "Actor" } },
        ],
      },
    ];
    expect(await syncVoiceCastLanguages(1, async () => cast)).toEqual({
      status: "matched",
      languages: ["en", "pt"],
    });
    expect(await status()).toMatchObject({ status: "likely", confidence: 75 });
    expect((await status("pt"))?.status).toBe("likely");
    expect(await db.select().from(episodeLanguageStatus)).toHaveLength(0);
    await expect(
      syncVoiceCastLanguages(1, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect((await status())?.status).toBe("likely");
    await syncVoiceCastLanguages(1, async () => []);
    expect((await status())?.status).toBe("unknown");
  });

  test("voice-cast lookups refuse fuzzy identities and clear evidence on identity changes", async () => {
    await db
      .update(animeMappings)
      .set({ source: "fuzzy", confidence: 95 })
      .where(eq(animeMappings.provider, "mal"));
    let requests = 0;
    await syncVoiceCastLanguages(1, async () => {
      requests++;
      return [];
    });
    expect(requests).toBe(0);
  });

  test("provider snapshot replacement rolls back invalid episode data atomically", async () => {
    fakeSchedule(schedule());
    await syncDubStatus(opts);
    await expect(
      replaceProviderLanguageSnapshot({
        animeId: 1,
        provider: "animeschedule",
        sourceUrlPrefixes: ["https://animeschedule.net/anime/"],
        evidenceTypes: ["provider_audio", "provider_subtitle"],
        evidence: [],
        episodes: [
          {
            episodeNumber: 27,
            languageCode: "en",
            mediaType: "audio",
            status: "available",
            confidence: 90,
          },
        ],
      }),
    ).rejects.toThrow("non-canonical episode");
    expect((await status())?.status).toBe("confirmed");
    expect(await db.select().from(animeLanguageEvidence)).toHaveLength(2);
  });

  test("verified Kitsu streaming metadata provides subtitle fallback without episode guesses", async () => {
    await db
      .insert(animeMappings)
      .values({ animeId: 1, provider: "kitsu", providerId: "1", source: "api", isPrimary: true });
    const link = {
      id: "2260",
      type: "streamingLinks" as const,
      attributes: { url: "http://www.crunchyroll.com/cowboy-bebop", subs: ["en"], dubs: ["ja"] },
    };
    expect(await syncKitsuLanguages(1, async () => [link])).toMatchObject({
      status: "matched",
      evidenceCount: 2,
    });
    expect(await status("en", "subtitle")).toMatchObject({ status: "likely", confidence: 75 });
    expect((await status("ja"))?.status).toBe("likely");
    expect(await db.select().from(episodeLanguageStatus)).toHaveLength(0);
    await expect(
      syncKitsuLanguages(1, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect((await status("en", "subtitle"))?.status).toBe("likely");
    await syncKitsuLanguages(1, async () => []);
    expect((await status("en", "subtitle"))?.status).toBe("unknown");
  });

  test("episode rollups account for unknown canonical coverage and the weakest confidence", async () => {
    await db.insert(episodeLanguageStatus).values([
      {
        animeId: 1,
        episodeNumber: 1,
        languageCode: "en",
        mediaType: "audio",
        status: "available",
        provider: "sample",
        confidence: 90,
      },
      {
        animeId: 1,
        episodeNumber: 2,
        languageCode: "en",
        mediaType: "audio",
        status: "available",
        provider: "sample",
        confidence: 75,
      },
    ]);
    await syncAnimeLanguageEvidenceFromEpisodeStatuses({
      animeId: 1,
      languageCode: "en",
      mediaType: "audio",
      provider: "sample",
    });
    expect(await status()).toMatchObject({ status: "partial", confidence: 75 });
  });

  test("AniList cast establishes multilingual fallback independently of MAL availability", async () => {
    const cast = [
      {
        role: "MAIN",
        node: { id: 1 },
        voiceActors: [
          { id: 95012, name: { full: "Steven Blum" }, languageV2: "English" },
          { id: 95011, name: { full: "Kouichi Yamadera" }, languageV2: "Japanese" },
        ],
      },
    ];
    expect(await syncAnilistCastLanguages(1, async () => cast)).toEqual({
      status: "matched",
      languages: ["en", "ja"],
    });
    expect(await status()).toMatchObject({ status: "likely", confidence: 75 });
    expect(await db.select().from(animeLanguageEvidence)).toMatchObject([
      { sourceUrl: "https://anilist.co/anime/1/characters" },
      { sourceUrl: "https://anilist.co/anime/1/characters" },
    ]);
    await expect(
      syncAnilistCastLanguages(1, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect((await status())?.status).toBe("likely");
    await syncAnilistCastLanguages(1, async () => []);
    expect((await status())?.status).toBe("unknown");
  });

  test("retired AniList cast evidence is withdrawn before a replacement lookup fails", async () => {
    await syncAnilistCastLanguages(1, async () => [
      {
        role: "MAIN",
        node: { id: 1 },
        voiceActors: [{ id: 95012, name: { full: "Steven Blum" }, languageV2: "English" }],
      },
    ]);
    expect((await status())?.status).toBe("likely");
    await db
      .update(animeMappings)
      .set({ providerId: "5" })
      .where(and(eq(animeMappings.animeId, 1), eq(animeMappings.provider, "anilist")));
    await expect(
      syncAnilistCastLanguages(1, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect((await status())?.status).toBe("unknown");
    expect(await db.select().from(animeLanguageEvidence)).toEqual([]);
  });

  test("language audit flags unsupported negatives and unverified evidence identities", async () => {
    expect((await auditLanguageStatus()).ok).toBe(true);
    await staleNegative();
    const report = await auditLanguageStatus();
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain(
      "unsupported-schedule-negative",
    );
    expect(report.findings.map((finding) => finding.code)).toContain(
      "unsupported-schedule-episode-negative",
    );
    expect(report.findings.map((finding) => finding.code)).toContain(
      "provider-evidence-without-verified-identity",
    );
    await db.update(animeLanguageStatus).set({ status: "confirmed" });
    expect((await auditLanguageStatus()).findings.map((finding) => finding.code)).toContain(
      "resolved-status-disagrees-with-evidence",
    );
  });
});
