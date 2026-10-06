import { useEffect, useState } from "react";
import { fetchCatalogueRevision } from "@/lib/anime-api";

/** Database revision includes metadata, imports, mappings and language changes. */
export function useCatalogueRevision(baseUrl: string) {
  const [revision, setRevision] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      if (disposed) return;
      if (!document.hidden) {
        controller = new AbortController();
        try {
          const result = await fetchCatalogueRevision(baseUrl, controller.signal);
          if (!disposed) setRevision(`${baseUrl}#${result.revision}`);
        } catch {
          /* Poll again; existing data remains usable, including older servers. */
        }
      }
      if (!disposed) timer = setTimeout(() => void poll(), 30_000);
    };
    void poll();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [baseUrl]);
  return revision;
}
