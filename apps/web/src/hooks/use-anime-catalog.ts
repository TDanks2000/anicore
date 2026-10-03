import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type AnimeListItem, fetchAnimeList } from "@/lib/anime-api";
import {
  type AnimeCatalogQuery,
  type AnimeFilterPatch,
  type AnimeSortField,
  animeQueryKey,
  applyAnimeFilters,
  clearAnimeFilters,
  DEFAULT_ANIME_QUERY,
  toggleAnimeSort,
} from "@/lib/anime-query";
import { useDebouncedValue } from "./use-debounced-value";

const SEARCH_DEBOUNCE_MS = 300;

interface CatalogData {
  key: string;
  items: AnimeListItem[];
  total: number | null;
}

/**
 * Fetches one page of the anime catalog. Search is debounced; while a keystroke
 * is settling no request is sent, and when the effective query changes the old
 * rows are treated as stale so the table can show skeletons instead of data
 * that no longer matches the controls.
 */
export function useAnimeCatalog(baseUrl: string) {
  const [query, setQuery] = useState<AnimeCatalogQuery>(DEFAULT_ANIME_QUERY);
  const debouncedSearch = useDebouncedValue(query.q, SEARCH_DEBOUNCE_MS);
  const settling = debouncedSearch !== query.q;

  const effectiveQuery = useMemo<AnimeCatalogQuery>(
    () => ({ ...query, q: debouncedSearch }),
    [query, debouncedSearch],
  );
  // The base URL is part of the identity: switching servers must not let the
  // previous server's rows count as current.
  const requestKey = `${baseUrl}\u0000${animeQueryKey(effectiveQuery)}`;

  const [data, setData] = useState<CatalogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    if (settling) return;

    const controller = new AbortController();
    const gen = ++generation.current;
    setFetching(true);
    setError(null);

    fetchAnimeList(baseUrl, effectiveQuery, controller.signal)
      .then((response) => {
        if (gen !== generation.current) return;
        setData({ ...response, key: requestKey });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || gen !== generation.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (gen === generation.current) setFetching(false);
      });

    return () => controller.abort();
  }, [baseUrl, effectiveQuery, requestKey, reloadToken, settling]);

  const rows = data?.items ?? [];
  const total = data?.total ?? null;
  const ready = data !== null && data.key === requestKey;
  const loading = (fetching || settling) && !ready;
  const refreshing = fetching && ready;

  const setSearch = useCallback((q: string) => {
    setQuery((current) => applyAnimeFilters(current, { q }));
  }, []);

  const setFilters = useCallback((patch: AnimeFilterPatch) => {
    setQuery((current) => applyAnimeFilters(current, patch));
  }, []);

  const clearFilters = useCallback(() => {
    setQuery((current) => clearAnimeFilters(current));
  }, []);

  const sortBy = useCallback((field: AnimeSortField) => {
    setQuery((current) => toggleAnimeSort(current, field));
  }, []);

  const setPage = useCallback((page: number) => {
    setQuery((current) => ({ ...current, page }));
  }, []);

  const setPageSize = useCallback((pageSize: number) => {
    setQuery((current) => ({ ...current, pageSize, page: 1 }));
  }, []);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return {
    query,
    rows,
    total,
    error,
    loading,
    refreshing,
    ready,
    setSearch,
    setFilters,
    clearFilters,
    sortBy,
    setPage,
    setPageSize,
    refresh,
  };
}

export type AnimeCatalogState = ReturnType<typeof useAnimeCatalog>;
