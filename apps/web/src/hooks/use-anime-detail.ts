import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AnimeFull,
  type AnimeLanguageStatusResponse,
  fetchAnimeFull,
  fetchAnimeLanguageStatus,
} from "@/lib/anime-api";
import { DetailCache } from "@/lib/detail-cache";

export interface AnimeDetailData {
  full: AnimeFull;
  language: AnimeLanguageStatusResponse;
}

/**
 * Loads the full aggregate plus language coverage for one anime. Results are
 * cached per server and id for a minute; expired entries revalidate in the background.
 */
export function useAnimeDetail(baseUrl: string, animeId: number | null, revision?: string | null) {
  const [data, setData] = useState<AnimeDetailData | null>(null);
  const [dataKey, setDataKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const cache = useRef(new DetailCache<AnimeDetailData>());
  const previousRevision = useRef(revision);
  useEffect(() => {
    if (previousRevision.current !== revision) cache.current.invalidateAll();
    previousRevision.current = revision;
  }, [revision]);

  const retry = useCallback(() => {
    if (animeId === null) return;
    cache.current.invalidate(`${baseUrl}#${animeId}`);
    setReloadToken((token) => token + 1);
  }, [animeId, baseUrl]);

  useEffect(() => {
    if (animeId === null) {
      setData(null);
      setDataKey(null);
      setLoading(false);
      setError(null);
      return;
    }

    const cacheKey = `${baseUrl}#${animeId}`;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const load = async () => {
      if (disposed) return;
      if (document.hidden) {
        timer = setTimeout(() => void load(), 60_000);
        return;
      }
      const cached = cache.current.get(cacheKey);
      setData(cached?.value ?? null);
      setDataKey(cacheKey);
      setLoading(!cached);
      setError(null);
      if (!cached?.fresh) {
        controller = new AbortController();
        try {
          const [full, language] = await Promise.all([
            fetchAnimeFull(baseUrl, animeId, controller.signal),
            fetchAnimeLanguageStatus(baseUrl, animeId, controller.signal),
          ]);
          if (disposed) return;
          const next = { full, language };
          cache.current.set(cacheKey, next);
          setData(next);
          setDataKey(cacheKey);
        } catch (err) {
          if (disposed) return;
          // The aggregate cannot be used without both responses. Cancel the
          // remaining read when its sibling fails instead of leaving it running.
          controller.abort();
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          if (!disposed) setLoading(false);
        }
      }
      if (!disposed) timer = setTimeout(() => void load(), 60_000);
    };

    void load();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [baseUrl, animeId, reloadToken, revision]);

  return { data: dataKey === `${baseUrl}#${animeId}` ? data : null, loading, error, retry };
}
