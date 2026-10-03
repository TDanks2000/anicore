import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, db } from "@anicore/db";
import {
  animeProviderMappings,
  animeProviderSegments,
  providerEntities,
} from "@anicore/db/provider-mapping-schema";
import {
  anime,
  animeExternalLinks,
  animeLanguageEvidence,
  animeLanguageStatus,
  animeMappings,
  episodeLanguageStatus,
  episodeMappings,
  episodes,
} from "@anicore/db/schema";
import type { CrunchyrollCatalogue } from "@anicore/providers/crunchyroll/alignment";
import {
  type CrunchyrollApi,
  clearCrunchyrollCatalogueCache,
  syncCrunchyrollLanguages,
} from "@anicore/providers/crunchyroll/sync";
import { and, eq } from "drizzle-orm";
import catalogues from "../../../../packages/providers/src/providers/crunchyroll/fixtures/catalogues.json";
import { getResolvedAnimeLanguageStatus } from "../modules/language-status/language-status.service";
import { auditLanguageStatus } from "../scripts/audit-language-status";
import { resetTestDatabase } from "../test/database";

const bebop = catalogues.GYVNXMVP6 as unknown as CrunchyrollCatalogue;
const SERIES_URL = "https://www.crunchyroll.com/series/GYVNXMVP6/cowboy-bebop";

function fakeApi(
  catalogue: CrunchyrollCatalogue | null = bebop,
  overrides: Partial<CrunchyrollApi> = {},
) {
  const calls: string[] = [];
  const api: CrunchyrollApi = {
    async fetchSeries(id) {
      calls.push(`series:${id}`);
      return catalogue?.series.id === id ? catalogue.series : null;
    },
    async fetchSeasons(id) {
      calls.push(`seasons:${id}`);
      return catalogue?.series.id === id ? catalogue.seasons.map((entry) => entry.season) : [];
    },
    async fetchEpisodes(id) {
      calls.push(`episodes:${id}`);
      return catalogue?.seasons.find((entry) => entry.season.id === id)?.episodes ?? [];
    },
    async searchSeries(query) {
      calls.push(`search:${query}`);
      return catalogue ? [catalogue.series] : [];
    },
    ...overrides,
  };
  return { api, calls };
}

async function seed(link: string | null = "http://www.crunchyroll.com/cowboy-bebop") {
  await db.insert(anime).values({
    id: 1,
    slug: "cowboy-bebop",
    titleRomaji: "Cowboy Bebop",
    titleEnglish: "Cowboy Bebop",
    status: "FINISHED",
    episodeCount: 26,
    startDate: "1998-04-03",
  });
  await db
    .insert(animeMappings)
    .values({ animeId: 1, provider: "anilist", providerId: "1", source: "api", isPrimary: true });
  if (link)
    await db.insert(animeExternalLinks).values({ animeId: 1, site: "Crunchyroll", url: link });
  await db.insert(episodes).values(
    Array.from({ length: 26 }, (_, index) => ({
      animeId: 1,
      number: index + 1,
      sortNumber: index + 1,
      // Kitsu's canonical title for episode 2, where it is known.
      title: index === 1 ? "Stray Dog Strut" : null,
      lengthMinutes: index === 0 ? 25 : null,
    })),
  );
}

async function status(languageCode: string, mediaType: "audio" | "subtitle") {
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

describe("Crunchyroll episode language tracks", () => {
  beforeEach(async () => {
    clearCrunchyrollCatalogueCache();
    await resetTestDatabase();
  });
  afterAll(closeDb);

  test("Cowboy Bebop gets its English dub and subtitles on every episode", async () => {
    await seed();
    const { api } = fakeApi();
    expect(await syncCrunchyrollLanguages(1, api)).toMatchObject({
      status: "matched",
      seriesId: "GYVNXMVP6",
      tier: 3,
      episodes: 26,
    });

    expect(await status("en", "audio")).toMatchObject({ status: "confirmed", confidence: 95 });
    expect(await status("en", "subtitle")).toMatchObject({ status: "confirmed", confidence: 95 });
    expect(await status("ja", "audio")).toMatchObject({ status: "confirmed", confidence: 95 });

    const rows = await db
      .select()
      .from(episodeLanguageStatus)
      .where(eq(episodeLanguageStatus.provider, "crunchyroll"));
    for (const [languageCode, mediaType] of [
      ["en", "audio"],
      ["ja", "audio"],
      ["en", "subtitle"],
    ] as const) {
      const covered = rows.filter(
        (row) => row.languageCode === languageCode && row.mediaType === mediaType,
      );
      expect(covered.map((row) => row.episodeNumber).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 26 }, (_, index) => index + 1),
      );
      expect(covered.every((row) => row.status === "available" && row.confidence === 95)).toBe(
        true,
      );
    }
    expect(
      await db
        .select()
        .from(animeLanguageEvidence)
        .where(eq(animeLanguageEvidence.sourceUrl, SERIES_URL)),
    ).toHaveLength(3);
    expect((await auditLanguageStatus()).findings).toEqual([]);
    const dub = await getResolvedAnimeLanguageStatus({
      animeId: 1,
      languageCode: "en",
      mediaType: "audio",
    });
    expect(dub.coverage).toMatchObject({ totalEpisodes: 26, available: 26, unknown: 0 });
  });

  test("records the season mapping, episode mappings and fills only missing metadata", async () => {
    await seed();
    await syncCrunchyrollLanguages(1, fakeApi().api);

    const [entity] = await db.select().from(providerEntities);
    expect(entity).toMatchObject({
      provider: "crunchyroll",
      providerId: "GY2PW587Y",
      providerSlug: "cowboy-bebop",
      providerUrl: SERIES_URL,
    });
    expect(await db.select().from(animeProviderMappings)).toMatchObject([
      { animeId: 1, source: "api", confidence: 100, isPrimary: true },
    ]);
    expect(await db.select().from(animeProviderSegments)).toMatchObject([
      {
        providerEpisodeStart: 1,
        providerEpisodeEnd: 26,
        localEpisodeStart: 1,
        localEpisodeEnd: 26,
      },
    ]);
    const mapped = await db
      .select({ number: episodes.number, providerId: episodeMappings.providerId })
      .from(episodeMappings)
      .innerJoin(episodes, eq(episodeMappings.episodeId, episodes.id))
      .orderBy(episodes.number);
    expect(mapped).toHaveLength(26);
    expect(mapped[0]).toEqual({ number: 1, providerId: "G14U4XX4N" });

    const [first, second] = await db.select().from(episodes).orderBy(episodes.number).limit(2);
    expect(first).toMatchObject({ titleEnglish: "Asteroid Blues", lengthMinutes: 25 });
    expect(second).toMatchObject({ title: "Stray Dog Strut", titleEnglish: "Stray Dog Strut" });
    expect(second!.lengthMinutes).toBe(22);
  });

  test("a resync is idempotent", async () => {
    await seed();
    await syncCrunchyrollLanguages(1, fakeApi().api);
    clearCrunchyrollCatalogueCache();
    await syncCrunchyrollLanguages(1, fakeApi().api);
    expect(await db.select().from(providerEntities)).toHaveLength(1);
    expect(await db.select().from(animeProviderMappings)).toHaveLength(1);
    expect(await db.select().from(animeProviderSegments)).toHaveLength(1);
    expect(await db.select().from(episodeMappings)).toHaveLength(26);
    expect(
      await db
        .select()
        .from(episodeLanguageStatus)
        .where(eq(episodeLanguageStatus.provider, "crunchyroll")),
    ).toHaveLength(78);
  });

  test("a provider outage throws and keeps the last good snapshot", async () => {
    await seed();
    await syncCrunchyrollLanguages(1, fakeApi().api);
    clearCrunchyrollCatalogueCache();
    const failing = fakeApi(bebop, {
      fetchSeries: async () => {
        throw new Error("Crunchyroll: 503 Service Unavailable");
      },
    });
    await expect(syncCrunchyrollLanguages(1, failing.api)).rejects.toThrow("503");
    expect(await status("en", "audio")).toMatchObject({ status: "confirmed" });
    expect(await db.select().from(episodeMappings)).toHaveLength(26);
  });

  test("a series withdrawn from the catalogue retires its evidence and mappings", async () => {
    await seed();
    await syncCrunchyrollLanguages(1, fakeApi().api);
    clearCrunchyrollCatalogueCache();
    expect(await syncCrunchyrollLanguages(1, fakeApi(null).api)).toMatchObject({
      status: "unmatched",
    });
    expect((await status("en", "audio"))?.status).toBe("unknown");
    expect(await db.select().from(episodeLanguageStatus)).toEqual([]);
    expect(await db.select().from(episodeMappings)).toEqual([]);
    expect(await db.select().from(animeProviderMappings)).toEqual([]);
  });

  test("without a published link, a series must match the title and premiere date", async () => {
    await seed(null);
    // Bebop's Crunchyroll premiere date is the WOWOW one, so search alone
    // cannot anchor it: no guess is recorded.
    const { api, calls } = fakeApi();
    expect(await syncCrunchyrollLanguages(1, api)).toMatchObject({ status: "unmatched" });
    expect(calls.some((call) => call.startsWith("search:"))).toBe(true);
    expect(await db.select().from(episodeLanguageStatus)).toEqual([]);

    await db.update(anime).set({ startDate: "1998-10-23" });
    clearCrunchyrollCatalogueCache();
    expect(await syncCrunchyrollLanguages(1, fakeApi().api)).toMatchObject({
      status: "matched",
      tier: 1,
    });
    expect(await db.select().from(animeProviderMappings)).toMatchObject([
      { source: "fuzzy", confidence: 90 },
    ]);
    expect(await status("en", "audio")).toMatchObject({ status: "confirmed", confidence: 90 });
  });

  test("a linked single-season series that cannot be aligned supplies anime-level tracks only", async () => {
    await seed();
    await db.update(anime).set({ episodeCount: 24 });
    expect(await syncCrunchyrollLanguages(1, fakeApi().api)).toMatchObject({
      status: "series-only",
    });
    expect(await status("en", "audio")).toMatchObject({ status: "confirmed" });
    expect(await db.select().from(episodeLanguageStatus)).toEqual([]);
    expect(await db.select().from(episodeMappings)).toEqual([]);
    expect(await db.select().from(animeProviderSegments)).toEqual([]);
  });

  test("an episode already aligned to another anime is neither stolen nor trusted", async () => {
    await seed();
    await db.insert(anime).values({ id: 2, titleRomaji: "Other", status: "FINISHED" });
    const [other] = await db
      .insert(episodes)
      .values({ animeId: 2, number: 1, sortNumber: 1 })
      .returning();
    await db.insert(episodeMappings).values({
      episodeId: other!.id,
      provider: "crunchyroll",
      providerId: "G14U4XX4N",
      source: "api",
    });
    expect(await syncCrunchyrollLanguages(1, fakeApi().api)).toMatchObject({ episodes: 25 });
    const numbers = (
      await db
        .select()
        .from(episodeLanguageStatus)
        .where(
          and(eq(episodeLanguageStatus.animeId, 1), eq(episodeLanguageStatus.languageCode, "en")),
        )
    ).map((row) => row.episodeNumber);
    expect(numbers).not.toContain(1);
    expect(numbers).toContain(2);
  });

  test("two anime sharing a link take their own seasons by premiere order", async () => {
    const [{ season, episodes: all }] = bebop.seasons;
    const split = (id: string, sequenceNumber: number, from: number, to: number) => ({
      season: { ...season!, id, sequenceNumber },
      episodes: all
        .filter((episode) => episode.episodeNumber! >= from && episode.episodeNumber! <= to)
        .map((episode) => ({ ...episode, seasonId: id, airDate: "2017-05-18" })),
    });
    const twoCours: CrunchyrollCatalogue = {
      ...bebop,
      seasons: [split("GCOURONE", 1, 1, 13), split("GCOURTWO", 2, 14, 26)],
    };
    const link = "https://www.crunchyroll.com/cowboy-bebop";
    for (const [id, startDate] of [
      [1, "2000-10-03"],
      [2, "2001-10-05"],
    ] as const) {
      await db.insert(anime).values({
        id,
        titleRomaji: id === 1 ? "Cowboy Bebop" : "Cowboy Bebop Second Stage",
        status: "FINISHED",
        episodeCount: 13,
        startDate,
      });
      await db.insert(animeExternalLinks).values({ animeId: id, site: "Crunchyroll", url: link });
      await db.insert(episodes).values(
        Array.from({ length: 13 }, (_, index) => ({
          animeId: id,
          number: index + 1,
          sortNumber: index + 1,
        })),
      );
    }

    expect(await syncCrunchyrollLanguages(2, fakeApi(twoCours).api)).toMatchObject({
      status: "matched",
      tier: 3,
      episodes: 13,
    });
    expect(await syncCrunchyrollLanguages(1, fakeApi(twoCours).api)).toMatchObject({
      status: "matched",
      episodes: 13,
    });
    const ranges = await db
      .select({
        animeId: animeProviderMappings.animeId,
        season: providerEntities.providerId,
        start: animeProviderSegments.providerEpisodeStart,
      })
      .from(animeProviderSegments)
      .innerJoin(
        animeProviderMappings,
        eq(animeProviderSegments.animeProviderMappingId, animeProviderMappings.id),
      )
      .innerJoin(providerEntities, eq(animeProviderMappings.providerEntityId, providerEntities.id))
      .orderBy(animeProviderMappings.animeId);
    expect(ranges).toEqual([
      { animeId: 1, season: "GCOURONE", start: 1 },
      { animeId: 2, season: "GCOURTWO", start: 14 },
    ]);
    const [secondStageFirst] = await db
      .select()
      .from(episodes)
      .where(and(eq(episodes.animeId, 2), eq(episodes.number, 1)));
    expect(secondStageFirst?.titleEnglish).toBe("Bohemian Rhapsody");
  });
});
