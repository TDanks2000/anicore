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
import { DetailCache } from "@/lib/detail-cache";
import { useDebouncedValue } from "./use-debounced-value";

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_TTL_MS = 30_000;
const MAX_CACHED_PAGES = 20;

interface CatalogData {
  key: string;
  items: AnimeListItem[];
  total: number | null;
}

/**
 * Keeps a bounded cache of pages for 30 seconds, then refreshes visible pages
 * while retaining their rows. Search is debounced and cached rows only appear
 * when their query and server match the current controls.
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
  const cache = useRef(new DetailCache<CatalogData>(PAGE_TTL_MS, MAX_CACHED_PAGES));

  useEffect(() => {
    const gen = ++generation.current;
    if (settling) return;

    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const load = async () => {
      if (cancelled) return;
      const cached = cache.current.get(requestKey);
      if (cached) setData(cached.value);
      setError(null);
      setFetching(!cached?.fresh);
      if (!cached?.fresh) {
        controller = new AbortController();
        try {
          const response = await fetchAnimeList(baseUrl, effectiveQuery, controller.signal);
          if (cancelled || gen !== generation.current) return;
          const next = { ...response, key: requestKey };
          cache.current.set(requestKey, next);
          setData(next);
        } catch (err) {
          if (cancelled || gen !== generation.current) return;
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          if (!cancelled && gen === generation.current) setFetching(false);
        }
      }
      if (!cancelled) timer = setTimeout(() => void tick(), PAGE_TTL_MS);
    };
    const tick = () => {
      if (document.hidden) timer = setTimeout(() => void tick(), PAGE_TTL_MS);
      else void load();
    };
    void load();
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [baseUrl, effectiveQuery, requestKey, reloadToken, settling]);

  const ready = !settling && data !== null && data.key === requestKey;
  const rows = ready ? data.items : [];
  const total = ready ? data.total : null;
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
    // The underlying catalogue may have changed; revisiting other pages must
    // not reuse a snapshot that predates this explicit refresh.
    cache.current.invalidateAll();
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
