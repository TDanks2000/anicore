import { useEffect, useState } from "react";
import { fetchProviderFreshness, type ProviderFreshness } from "@/lib/anime-api";

const labels: Record<string, string> = {
  "anilist-fetch": "AniList metadata",
  "provider:kitsu": "Kitsu metadata",
  "episode-titles": "Episode titles",
  "language:original-audio": "Original audio",
  "language:animeschedule": "AnimeSchedule languages",
  "language:crunchyroll": "Crunchyroll languages",
  "language:anilist-cast": "AniList cast",
  "language:jikan": "Jikan cast",
  "language:kitsu-languages": "Kitsu languages",
};

export function ProviderFreshnessPanel({
  apiUrl,
  animeId,
  revision,
}: {
  apiUrl: string;
  animeId: number;
  revision?: string | null;
}) {
  const [rows, setRows] = useState<ProviderFreshness[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void fetchProviderFreshness(apiUrl, animeId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setRows(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [apiUrl, animeId, revision]);
  return (
    <section className="space-y-2 text-xs text-muted-foreground">
      <h3 className="font-medium text-foreground">Provider freshness</h3>
      {failed ? (
        <p>
          Freshness check unavailable.{" "}
          {rows.length ? "Showing the last recorded timestamps." : "Try refreshing the details."}
        </p>
      ) : null}
      {rows.some((row) => labels[row.stage]) ? (
        <ul className="space-y-1">
          {rows
            .filter((row) => labels[row.stage])
            .map((row) => (
              <li key={row.stage}>
                {labels[row.stage]}:{" "}
                {row.successAt
                  ? new Date(row.successAt).toLocaleString()
                  : "Not refreshed successfully"}
                {row.failures > 0
                  ? " · Retry pending"
                  : row.nextDueAt !== null && row.nextDueAt <= Date.now()
                    ? " · Refresh due"
                    : ""}
              </li>
            ))}
        </ul>
      ) : (
        <p>No provider freshness history recorded yet.</p>
      )}
    </section>
  );
}
