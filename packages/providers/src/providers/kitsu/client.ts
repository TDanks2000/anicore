import { formatHttpError } from "../../lib/http";

const KITSU_GRAPHQL_URL = "https://kitsu.io/api/graphql";

// Lean search query — no episodes, so we can fetch 10 candidates without blowing up payload
const ANIME_SEARCH_QUERY = `
query($title: String!) {
  searchAnimeByTitle(first: 10, title: $title) {
    nodes {
      id
      slug
      season
      startDate
      endDate
      subtype
      status
      episodeCount
      episodeLength
      averageRating
      userCount
      userCountRank
      averageRatingRank
      ageRating
      titles {
        romanized
        translated
        original
        localized
        alternatives
      }
      posterImage { original { url } }
      bannerImage { original { url } }
    }
  }
}
`.trim();

// Separate episode query so searches stay fast
const ANIME_EPISODES_QUERY = `
query($id: ID!) {
  findAnimeById(id: $id) {
    episodes(first: 2000) {
      nodes {
        id
        number
        releasedAt
        length
        createdAt
        titles {
          romanized
          translated
          localized
        }
        description
        thumbnail { original { url } }
      }
    }
  }
}
`.trim();

export interface KitsuTitle {
  canonical?: string | null;
  romanized?: string | null;
  translated?: string | null;
  original?: string | null;
  localized?: Record<string, string> | null;
  alternatives?: string[] | null;
}

export interface KitsuImage {
  url: string;
}

export interface KitsuSearchNode {
  id: string;
  slug: string | null;
  season: string | null;
  startDate: string | null;
  endDate: string | null;
  subtype: string | null;
  status: string | null;
  episodeCount: number | null;
  episodeLength: number | null;
  averageRating: number | null;
  userCount: number | null;
  userCountRank: number | null;
  averageRatingRank: number | null;
  ageRating: string | null;
  titles: KitsuTitle;
  posterImage: { original: KitsuImage } | null;
  bannerImage: { original: KitsuImage } | null;
}

export interface KitsuEpisodeNode {
  id: string;
  number: number | null;
  releasedAt: string | null;
  length: number | null;
  createdAt: string | null;
  titles: KitsuTitle;
  description: Record<string, string> | null;
  thumbnail: { original: KitsuImage } | null;
}

async function gql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(KITSU_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(await formatHttpError("Kitsu GraphQL request failed", res));
  }

  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };

  if (json.errors?.length) {
    throw new Error(`Kitsu GraphQL: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  if (!json.data) {
    throw new Error("Kitsu GraphQL response did not include data");
  }

  return json.data as T;
}

export async function searchKitsuByTitle(
  title: string,
): Promise<KitsuSearchNode[]> {
  const data = await gql<{
    searchAnimeByTitle: { nodes: KitsuSearchNode[] };
  }>(ANIME_SEARCH_QUERY, { title });
  return data?.searchAnimeByTitle?.nodes ?? [];
}

export async function fetchKitsuEpisodes(
  kitsuId: string,
): Promise<KitsuEpisodeNode[]> {
  const data = await gql<{
    findAnimeById: { episodes: { nodes: KitsuEpisodeNode[] } } | null;
  }>(ANIME_EPISODES_QUERY, { id: kitsuId });
  return data?.findAnimeById?.episodes?.nodes ?? [];
}
