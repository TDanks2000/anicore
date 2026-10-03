import { formatHttpError } from "../../lib/http";
import { log } from "../../lib/logger";

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
      mappings(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          externalId
          externalSite
        }
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

// Kitsu declares `canonical` non-null yet omits it on some records, which nulls
// the whole record under GraphQL error propagation. Asking for it separately
// means a bad record can only cost a title, never the episode list itself.
const ANIME_EPISODE_TITLES_QUERY = `
query($id: ID!) {
  findAnimeById(id: $id) {
    episodes(first: 2000) {
      nodes {
        id
        titles { canonical }
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

export interface KitsuExternalMapping {
  externalId: string;
  externalSite: string;
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
  mappings?: {
    nodes: KitsuExternalMapping[];
    pageInfo?: { hasNextPage: boolean };
  } | null;
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
  expectedErrors?: RegExp,
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

  // GraphQL reports a non-null field violation by nulling the offending record
  // and returning everything else alongside an error. Kitsu trips this on its
  // own schema (TitlesList.alternatives is declared non-null but comes back
  // null for some records), so treating any error as fatal threw away entire
  // search result sets over one malformed row and left the anime unmatched.
  // Partial data is still usable evidence; only a response with no data at all
  // is a genuine failure.
  if (json.errors?.length) {
    const message = json.errors.map((error) => error.message).join(", ");
    if (json.data === undefined || json.data === null) {
      throw new Error(`Kitsu GraphQL: ${message}`);
    }
    // Kitsu repeats one error per bad record; collapse identical ones with a count.
    // Errors a caller anticipated (and already handles) are not worth a warning.
    const counts = new Map<string, number>();
    for (const error of json.errors) {
      if (expectedErrors?.test(error.message)) continue;
      counts.set(error.message, (counts.get(error.message) ?? 0) + 1);
    }
    if (counts.size > 0) {
      const summary = [...counts]
        .map(([text, count]) => (count > 1 ? `${text} (×${count})` : text))
        .join(", ");
      log.warn(`Kitsu GraphQL returned partial data: ${summary}`);
    }
  }

  if (!json.data) {
    throw new Error("Kitsu GraphQL response did not include data");
  }

  return json.data as T;
}

export async function searchKitsuByTitle(title: string): Promise<KitsuSearchNode[]> {
  const data = await gql<{
    searchAnimeByTitle: { nodes: KitsuSearchNode[] };
  }>(ANIME_SEARCH_QUERY, { title });
  // A partial response leaves null holes where records failed to serialise.
  return (data?.searchAnimeByTitle?.nodes ?? []).filter(
    (node): node is KitsuSearchNode => node !== null,
  );
}

export async function fetchKitsuEpisodes(kitsuId: string): Promise<KitsuEpisodeNode[]> {
  const data = await gql<{
    findAnimeById: { episodes: { nodes: KitsuEpisodeNode[] } } | null;
  }>(ANIME_EPISODES_QUERY, { id: kitsuId });
  return (data?.findAnimeById?.episodes?.nodes ?? []).filter(
    (node): node is KitsuEpisodeNode => node !== null,
  );
}

/** Canonical episode titles by Kitsu episode id; records Kitsu fails to serialise are absent. */
export async function fetchKitsuEpisodeTitles(kitsuId: string): Promise<Map<string, string>> {
  const data = await gql<{
    findAnimeById: {
      episodes: { nodes: Array<{ id: string; titles: { canonical: string | null } } | null> };
    } | null;
  }>(ANIME_EPISODE_TITLES_QUERY, { id: kitsuId }, /TitlesList\.canonical/);
  const titles = new Map<string, string>();
  for (const node of data?.findAnimeById?.episodes?.nodes ?? []) {
    const title = node?.titles?.canonical?.trim();
    if (node && typeof node.id === "string" && title) titles.set(node.id, title);
  }
  return titles;
}
