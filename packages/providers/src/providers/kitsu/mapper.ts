import type { KitsuEpisodeNode, KitsuSearchNode } from "./client";
import type { ProviderAnimeData, ProviderEpisodeData } from "../types";

function mapStatus(kitsuStatus: string | null): string | null {
  switch (kitsuStatus) {
    case "CURRENT":
      return "RELEASING";
    case "FINISHED":
      return "FINISHED";
    case "UPCOMING":
    case "UNRELEASED":
    case "TBA":
      return "NOT_YET_RELEASED";
    default:
      return null;
  }
}

function resolveTitle(titles: KitsuSearchNode["titles"]): string {
  return (
    titles.romanized ??
    titles.canonical ??
    titles.translated ??
    Object.values(titles.localized ?? {})[0] ??
    "Unknown"
  );
}

export function mapKitsuAnime(node: KitsuSearchNode): ProviderAnimeData {
  const year = node.startDate
    ? parseInt(node.startDate.trim().split("-")[0]!, 10)
    : null;

  const localizedTitles = Object.values(node.titles.localized ?? {}).filter(
    Boolean,
  ) as string[];

  const alternatives = (node.titles.alternatives ?? []).filter(Boolean) as string[];

  return {
    provider: "kitsu",
    providerId: node.id,
    providerSlug: node.slug ?? null,

    titleRomaji: resolveTitle(node.titles),
    titleEnglish: node.titles.translated ?? null,
    titleNative: node.titles.original ?? null,
    titleUserPreferred: node.titles.canonical ?? null,

    format: node.subtype ?? null,
    status: mapStatus(node.status),
    season: node.season ?? null,
    seasonYear: year !== null && !isNaN(year) ? year : null,
    endDate: node.endDate ?? null,
    episodeCount: node.episodeCount ?? null,
    durationMinutes: node.episodeLength ?? null,
    isAdult: node.ageRating === "R18",

    synonyms: [...alternatives, ...localizedTitles],

    averageScore: node.averageRating != null ? Math.round(node.averageRating) : null,
    popularity: node.userCount ?? null,

    coverImage: node.posterImage?.original?.url ?? null,
    bannerImage: node.bannerImage?.original?.url ?? null,
  };
}

export interface MappedEpisode extends ProviderEpisodeData {
  number: number;
  title: string | null;
  titleRomaji: string | null;
  titleEnglish: string | null;
  description: string | null;
  airDate: string | null;
  lengthMinutes: number | null;
  thumbnail: string | null;
  kitsuId: string;
}

export function mapKitsuEpisodes(nodes: KitsuEpisodeNode[]): MappedEpisode[] {
  return nodes
    .filter((ep) => ep.number != null)
    .map((ep) => ({
      number:       ep.number!,
      title:        ep.titles?.canonical ?? ep.titles?.romanized ?? ep.titles?.translated ?? null,
      titleRomaji:  ep.titles?.romanized ?? null,
      titleEnglish: ep.titles?.translated ?? null,
      description:
        ep.description?.en ??
        (ep.description ? Object.values(ep.description)[0] : null) ??
        null,
      airDate:      ep.releasedAt?.slice(0, 10) ?? null,
      lengthMinutes: ep.length ?? null,
      thumbnail:    ep.thumbnail?.original?.url ?? null,
      kitsuId:      ep.id,
      providerId:   ep.id,
      providerEpisodeNumber: String(ep.number),
    }));
}
