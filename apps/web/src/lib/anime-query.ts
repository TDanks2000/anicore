/** Sort fields the API accepts for `GET /anime`. */
export const animeSortFields = [
  "id",
  "title",
  "format",
  "status",
  "seasonYear",
  "episodes",
  "score",
  "popularity",
] as const;

export type AnimeSortField = (typeof animeSortFields)[number];
export type AnimeSortOrder = "asc" | "desc";

export interface AnimeCatalogQuery {
  q: string;
  format: string;
  season: string;
  seasonYear: string;
  status: string;
  sort: AnimeSortField;
  order: AnimeSortOrder;
  /** 1-based. */
  page: number;
  pageSize: number;
}

export const ANIME_PAGE_SIZES = [25, 50, 100] as const;

export const DEFAULT_ANIME_QUERY: AnimeCatalogQuery = {
  q: "",
  format: "",
  season: "",
  seasonYear: "",
  status: "",
  sort: "id",
  order: "asc",
  page: 1,
  pageSize: 50,
};

/** Metrics where "best first" means descending on the first click. */
const DESCENDING_FIRST: ReadonlySet<AnimeSortField> = new Set([
  "score",
  "popularity",
  "seasonYear",
  "episodes",
]);

export function toggleAnimeSort(
  query: AnimeCatalogQuery,
  field: AnimeSortField,
): AnimeCatalogQuery {
  if (query.sort === field) {
    return { ...query, order: query.order === "asc" ? "desc" : "asc", page: 1 };
  }
  return { ...query, sort: field, order: DESCENDING_FIRST.has(field) ? "desc" : "asc", page: 1 };
}

export type AnimeFilterPatch = Partial<
  Pick<AnimeCatalogQuery, "q" | "format" | "season" | "seasonYear" | "status">
>;

/** Any change to search or filters invalidates the current page. */
export function applyAnimeFilters(
  query: AnimeCatalogQuery,
  patch: AnimeFilterPatch,
): AnimeCatalogQuery {
  return { ...query, ...patch, page: 1 };
}

/** Keeps the user's chosen sort and page size; only the filters are reset. */
export function clearAnimeFilters(query: AnimeCatalogQuery): AnimeCatalogQuery {
  return {
    ...DEFAULT_ANIME_QUERY,
    sort: query.sort,
    order: query.order,
    pageSize: query.pageSize,
  };
}

export function hasActiveAnimeFilters(query: AnimeCatalogQuery): boolean {
  return Boolean(
    query.q.trim() || query.format || query.season || query.seasonYear || query.status,
  );
}

/** Stable identity for a query, used to tell stale results from current ones. */
export function animeQueryKey(query: AnimeCatalogQuery): string {
  return [
    query.q.trim(),
    query.format,
    query.season,
    query.seasonYear,
    query.status,
    query.sort,
    query.order,
    query.page,
    query.pageSize,
  ].join("|");
}

export interface AnimePageBounds {
  start: number;
  end: number;
  lastPage: number | null;
}

export function animePageBounds(
  page: number,
  pageSize: number,
  total: number | null,
): AnimePageBounds {
  if (total === null) return { start: 0, end: 0, lastPage: null };
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  return {
    start: total === 0 ? 0 : (page - 1) * pageSize + 1,
    end: Math.min(page * pageSize, total),
    lastPage,
  };
}

/**
 * Older API deployments do not expose `X-Total-Count`; without a total the
 * presence of a full page is the only signal that more rows exist.
 */
export function animeHasNextPage(
  page: number,
  pageSize: number,
  total: number | null,
  itemCount: number,
): boolean {
  if (total !== null) return page * pageSize < total;
  return itemCount >= pageSize;
}
