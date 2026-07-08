import { db } from "@anicore/db";
import {
  anime,
  animeMappings,
  animeLanguageEvidence,
  animeLanguageStatus,
  episodeLanguageStatus,
  episodeMappings,
  episodes,
  syncRuns,
} from "@anicore/db/schema";
import { log } from "@anicore/providers/lib/logger";

log.info("Seeding AniCore database…");

log.info("Clearing existing data…");
await db.delete(episodeLanguageStatus);
await db.delete(animeLanguageEvidence);
await db.delete(animeLanguageStatus);
await db.delete(episodeMappings);
await db.delete(episodes);
await db.delete(animeMappings);
await db.delete(syncRuns);
await db.delete(anime);

log.info("Inserting seed anime: Cowboy Bebop…");

const [cowboyBebop] = await db
  .insert(anime)
  .values({
    slug: "cowboy-bebop",
    titleRomaji: "Cowboy Bebop",
    titleEnglish: "Cowboy Bebop",
    titleNative: "カウボーイビバップ",
    titleUserPreferred: "Cowboy Bebop",
    description:
      "A crew of bounty hunters travel through space chasing criminals while confronting their pasts.",
    format: "TV",
    status: "FINISHED",
    season: "SPRING",
    seasonYear: 1998,
    episodeCount: 26,
    durationMinutes: 24,
    countryOfOrigin: "JP",
    genresJson: JSON.stringify(["Action", "Adventure", "Drama", "Sci-Fi"]),
    synonymsJson: JSON.stringify(["COWBOY BEBOP"]),
    averageScore: 86,
    popularity: 500000,
  })
  .returning();

if (!cowboyBebop) throw new Error("Failed to seed anime");

await db.insert(animeMappings).values([
  {
    animeId: cowboyBebop.id,
    provider: "anilist",
    providerId: "1",
    providerSlug: "cowboy-bebop",
    providerUrl: "https://anilist.co/anime/1/Cowboy-Bebop/",
    confidence: 100,
    source: "manual",
    isPrimary: true,
  },
  {
    animeId: cowboyBebop.id,
    provider: "kitsu",
    providerId: "1",
    providerSlug: "cowboy-bebop",
    providerUrl: "https://kitsu.app/anime/cowboy-bebop",
    confidence: 100,
    source: "manual",
    isPrimary: true,
  },
  {
    animeId: cowboyBebop.id,
    provider: "mal",
    providerId: "1",
    providerSlug: "cowboy-bebop",
    providerUrl: "https://myanimelist.net/anime/1/Cowboy_Bebop",
    confidence: 100,
    source: "manual",
    isPrimary: false,
  },
]);

const createdEpisodes = await db
  .insert(episodes)
  .values([
    {
      animeId: cowboyBebop.id,
      number: 1,
      displayNumber: "1",
      sortNumber: 1,
      absoluteNumber: 1,
      title: "Asteroid Blues",
      titleEnglish: "Asteroid Blues",
      synopsis:
        "Spike and Jet pursue a drug dealer and his partner through the asteroid colony of Tijuana.",
      airDate: "1998-04-03",
      lengthMinutes: 24,
      kind: "normal",
    },
    {
      animeId: cowboyBebop.id,
      number: 2,
      displayNumber: "2",
      sortNumber: 2,
      absoluteNumber: 2,
      title: "Stray Dog Strut",
      titleEnglish: "Stray Dog Strut",
      synopsis:
        "Spike and Jet chase a thief who has stolen a highly valuable data dog.",
      airDate: "1998-04-10",
      lengthMinutes: 24,
      kind: "normal",
    },
  ])
  .returning();

await db.insert(episodeMappings).values(
  createdEpisodes.map((episode) => ({
    episodeId: episode.id,
    provider: "kitsu" as const,
    providerId: String(episode.number),
    providerSlug: `cowboy-bebop-episode-${episode.number}`,
    providerEpisodeNumber: String(episode.number),
    confidence: 100,
    source: "manual" as const,
  })),
);

await db.insert(episodeLanguageStatus).values(
  createdEpisodes.flatMap((episode) => [
    {
      animeId: episode.animeId,
      episodeNumber: episode.number,
      languageCode: "en",
      mediaType: "subtitle" as const,
      status: "available" as const,
      provider: "manual",
      confidence: 100,
    },
    {
      animeId: episode.animeId,
      episodeNumber: episode.number,
      languageCode: "en",
      mediaType: "audio" as const,
      status: "available" as const,
      provider: "manual",
      confidence: 100,
    },
  ]),
);

log.success("Seed complete.");
