import type { ProviderAnimeData } from "../types";
import { anilistClient } from "./client";

type AnilistGetByIdResult = Awaited<
  ReturnType<typeof anilistClient.anime.getAnimeById>
>;
type AnilistMedia = NonNullable<AnilistGetByIdResult["Media"]>;

function resolveTitle(media: AnilistMedia): string {
  return (
    media.title?.romaji ??
    media.title?.english ??
    media.title?.native ??
    String(media.id)
  );
}

function fuzzyDateToIso(
  date:
    | { year: number | null; month: number | null; day: number | null }
    | null
    | undefined,
): string | null {
  if (!date?.year) return null;
  const m = date.month ? String(date.month).padStart(2, "0") : "01";
  const d = date.day ? String(date.day).padStart(2, "0") : "01";
  return `${date.year}-${m}-${d}`;
}

function dedupeStudios(
  studios: NonNullable<ProviderAnimeData["studios"]>,
): NonNullable<ProviderAnimeData["studios"]> {
  const byName = new Map<string, NonNullable<ProviderAnimeData["studios"]>[number]>();

  for (const studio of studios) {
    const name = studio.name.trim();
    if (!name) continue;

    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, { ...studio, name });
      continue;
    }

    existing.isMain = existing.isMain || studio.isMain;
    existing.isAnimationStudio =
      existing.isAnimationStudio || studio.isAnimationStudio;
    existing.anilistStudioId ??= studio.anilistStudioId ?? null;
  }

  return [...byName.values()];
}

export function mapAnilistAnime(media: AnilistMedia): ProviderAnimeData {
  // studios.edges in getAnimeById doesn't include isMain — default to false.
  // The isMain flag can be populated via a future dedicated studios sync.
  const studios = (media.studios?.edges ?? [])
    .filter(
      (e): e is NonNullable<typeof e> => e !== null && e.node !== null,
    )
    .map((e) => ({
      name: e.node!.name,
      isMain: false,
      isAnimationStudio: e.node!.isAnimationStudio,
      anilistStudioId: e.node!.id,
    }));

  // tags in getAnimeById omits isGeneralSpoiler / isMediaSpoiler / isAdult.
  // These default to false and can be enriched later if the query is expanded.
  const tags = (media.tags ?? [])
    .filter((t): t is NonNullable<typeof t> => t !== null)
    .map((t) => ({
      name: t.name,
      category: t.category ?? null,
      rank: t.rank ?? null,
      isGeneralSpoiler: false,
      isMediaSpoiler: false,
      isAdult: false,
    }));

  // externalLinks in getAnimeById omits language / color / icon.
  const externalLinks = (media.externalLinks ?? [])
    .filter(
      (l): l is NonNullable<typeof l> => l !== null && !!l.url,
    )
    .map((l) => ({
      site: l.site,
      url: l.url!,
      type: (l.type as string) ?? null,
      language: null,
      color: null,
      icon: null,
    }));

  return {
    provider: "anilist",
    providerId: String(media.id),
    providerUrl: media.siteUrl ?? null,

    titleRomaji: resolveTitle(media),
    titleEnglish: media.title?.english ?? null,
    titleNative: media.title?.native ?? null,
    titleUserPreferred: media.title?.userPreferred ?? null,

    description: media.description ?? null,
    format: media.format ?? null,
    status: media.status ?? null,
    source: (media.source as string) ?? null,
    season: media.season ?? null,
    seasonYear: media.seasonYear ?? null,
    startDate: fuzzyDateToIso(media.startDate),
    endDate: fuzzyDateToIso(media.endDate),
    episodeCount: media.episodes ?? null,
    durationMinutes: media.duration ?? null,
    countryOfOrigin: (media.countryOfOrigin as string) ?? null,
    isAdult: media.isAdult ?? false,

    genres: (media.genres?.filter((g: string | null): g is string => g !== null) ?? []),
    synonyms: (media.synonyms?.filter((s: string | null): s is string => s !== null) ?? []),

    averageScore: media.averageScore ?? null,
    meanScore: media.meanScore ?? null,
    popularity: media.popularity ?? null,
    favourites: media.favourites ?? null,
    trending: media.trending ?? null,

    coverImage:
      media.coverImage?.extraLarge ??
      media.coverImage?.large ??
      media.coverImage?.medium ??
      null,
    coverImageColor: media.coverImage?.color ?? null,
    bannerImage: media.bannerImage ?? null,

    trailerVideoId: media.trailer?.id ?? null,
    trailerSite: media.trailer?.site ?? null,
    trailerThumbnail: media.trailer?.thumbnail ?? null,

    nextEpisodeNumber: media.nextAiringEpisode?.episode ?? null,
    nextEpisodeAirsAt: media.nextAiringEpisode?.airingAt ?? null,

    hashtag: media.hashtag ?? null,

    studios: dedupeStudios(studios),
    tags,
    externalLinks,
    // relations require a separate getRelations() call; handled in sync.ts.
  };
}
