import { useCallback, useEffect, useRef, useState } from "react";

import {
  type AnimeFull,
  type AnimeLanguageStatusResponse,
  fetchAnimeFull,
  fetchAnimeLanguageStatus,
} from "@/lib/anime-api";

export interface AnimeDetailData {
  full: AnimeFull;
  language: AnimeLanguageStatusResponse;
}

/**
 * Loads the full aggregate plus language coverage for one anime. Results are
 * cached per server and id, so reopening a dialog does not refetch.
 */
export function useAnimeDetail(baseUrl: string, animeId: number | null) {
  const [data, setData] = useState<AnimeDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const cache = useRef(new Map<string, AnimeDetailData>());

  const retry = useCallback(() => {
    if (animeId === null) return;
    cache.current.delete(`${baseUrl}#${animeId}`);
    setReloadToken((token) => token + 1);
  }, [animeId, baseUrl]);

  useEffect(() => {
    if (animeId === null) return;

    const cacheKey = `${baseUrl}#${animeId}`;
    const cached = cache.current.get(cacheKey);
    if (cached) {
      setData(cached);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setData(null);
    setLoading(true);
    setError(null);

    Promise.all([
      fetchAnimeFull(baseUrl, animeId, controller.signal),
      fetchAnimeLanguageStatus(baseUrl, animeId, controller.signal),
    ])
      .then(([full, language]) => {
        if (controller.signal.aborted) return;
        const next = { full, language };
        cache.current.set(cacheKey, next);
        setData(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => controller.abort();
  }, [baseUrl, animeId, reloadToken]);

  return { data, loading, error, retry };
}
