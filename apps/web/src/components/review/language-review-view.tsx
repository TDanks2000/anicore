import { useEffect, useState } from "react";
import { AnimeDetailDialog } from "@/components/catalog/anime-detail-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { type AnimeListItem, fetchAnimeFull } from "@/lib/anime-api";
import {
  fetchLanguageReviewQueue,
  type LanguageReviewFilters,
  type LanguageReviewItem,
  LanguageReviewRequestError,
} from "@/lib/language-review-api";
import {
  animeLanguageStatusLabel,
  animeLanguageStatusTone,
  formatLanguageName,
} from "@/lib/language-status";

const EMPTY_FILTERS: LanguageReviewFilters = { languageCode: "", mediaType: "", status: "" };

export function LanguageReviewView({ apiUrl }: { apiUrl: string }) {
  // Credentials stay in this view's memory and are discarded on navigation/origin changes.
  const [tokenDraft, setTokenDraft] = useState("");
  const [token, setToken] = useState("");
  const [draftFilters, setDraftFilters] = useState(EMPTY_FILTERS);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [items, setItems] = useState<LanguageReviewItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LanguageReviewItem | null>(null);
  const [anime, setAnime] = useState<AnimeListItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailRetry, setDetailRetry] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setItems([]);
    setTotal(null);
    fetchLanguageReviewQueue(apiUrl, token, filters, page, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.total !== null && page > 1 && (page - 1) * 25 >= result.total) {
          setPage(Math.max(1, Math.ceil(result.total / 25)));
          return;
        }
        setItems(result.items);
        setTotal(result.total);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (
          err instanceof LanguageReviewRequestError &&
          (err.status === 401 || err.status === 503)
        ) {
          setToken("");
          setSelected(null);
          setAnime(null);
        }
        setError(err instanceof Error ? err.message : "Unable to load the review queue.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [apiUrl, token, filters, page, refresh]);

  useEffect(() => {
    setAnime(null);
    setDetailError(null);
    if (!selected || !token) {
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    fetchAnimeFull(apiUrl, selected.animeId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setAnime(result);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setDetailError(err instanceof Error ? err.message : "Unable to load details.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [apiUrl, token, selected, detailRetry]);

  function disconnect() {
    setToken("");
    setTokenDraft("");
    setItems([]);
    setTotal(null);
    setSelected(null);
    setAnime(null);
    setError(null);
    setLoading(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Language Review</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Investigate unknown and possible language tracks using their recorded evidence, provider
          mappings and episode coverage. This workspace is read-only; manual overrides are excluded.
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3 p-5">
          <p className="break-all text-sm text-muted-foreground">API: {apiUrl}</p>
          {token ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">
                Admin token supplied · kept in memory until you leave this view
              </p>
              <Button variant="outline" onClick={disconnect}>
                Disconnect
              </Button>
            </div>
          ) : (
            <form
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                if (!tokenDraft.trim()) return;
                setToken(tokenDraft.trim());
                setTokenDraft("");
                setPage(1);
              }}
            >
              <div className="flex-1">
                <label htmlFor="review-admin-token" className="mb-2 block text-sm font-medium">
                  Admin token
                </label>
                <Input
                  id="review-admin-token"
                  type="password"
                  autoComplete="off"
                  value={tokenDraft}
                  onChange={(event) => setTokenDraft(event.target.value)}
                  required
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Use ANICORE_ADMIN_TOKEN. The sync monitor code does not grant admin access.
                </p>
              </div>
              <Button type="submit" disabled={!tokenDraft.trim()}>
                Connect
              </Button>
            </form>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
      {token ? (
        <Card>
          <CardContent className="flex flex-col gap-4 p-5">
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                setFilters({ ...draftFilters });
                setPage(1);
                setRefresh((n) => n + 1);
              }}
            >
              <div className="w-full sm:w-40">
                <label htmlFor="review-language" className="mb-2 block text-xs font-medium">
                  Language code
                </label>
                <Input
                  id="review-language"
                  placeholder="All languages"
                  maxLength={35}
                  value={draftFilters.languageCode}
                  onChange={(event) =>
                    setDraftFilters({ ...draftFilters, languageCode: event.target.value })
                  }
                />
              </div>
              <Select
                aria-label="Review media type"
                value={draftFilters.mediaType}
                onValueChange={(value) =>
                  setDraftFilters({
                    ...draftFilters,
                    mediaType: value as LanguageReviewFilters["mediaType"],
                  })
                }
                containerClassName="w-40"
              >
                <SelectItem value="">All media</SelectItem>
                <SelectItem value="audio">Audio</SelectItem>
                <SelectItem value="subtitle">Subtitles</SelectItem>
              </Select>
              <Select
                aria-label="Review status"
                value={draftFilters.status}
                onValueChange={(value) =>
                  setDraftFilters({
                    ...draftFilters,
                    status: value as LanguageReviewFilters["status"],
                  })
                }
                containerClassName="w-40"
              >
                <SelectItem value="">All review statuses</SelectItem>
                <SelectItem value="unknown">Unknown</SelectItem>
                <SelectItem value="possible">Possible</SelectItem>
              </Select>
              <Button type="submit" variant="outline" disabled={loading}>
                Apply filters
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={loading}
                onClick={() => {
                  setDraftFilters(EMPTY_FILTERS);
                  setFilters(EMPTY_FILTERS);
                  setPage(1);
                  setRefresh((n) => n + 1);
                }}
              >
                Clear filters
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={loading}
                onClick={() => setRefresh((n) => n + 1)}
              >
                Refresh
              </Button>
            </form>
            <p role="status" className="text-sm text-muted-foreground">
              {loading
                ? "Loading review queue…"
                : total === null
                  ? "Review queue"
                  : `${total.toLocaleString()} language results to review`}
            </p>
            {!loading && !error && items.length === 0 ? (
              <p className="rounded-lg border border-border p-5 text-sm">
                No uncertain language results match these filters.
              </p>
            ) : null}
            <ul className="grid gap-3 lg:grid-cols-2">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-2 rounded-lg border border-border p-4 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => {
                      setAnime(null);
                      setSelected(item);
                    }}
                  >
                    <span className="font-medium">
                      {item.anime?.titleRomaji ?? `Anime ${item.animeId}`}
                    </span>
                    {item.anime?.titleEnglish &&
                    item.anime.titleEnglish !== item.anime.titleRomaji ? (
                      <span className="text-xs text-muted-foreground">
                        {item.anime.titleEnglish}
                      </span>
                    ) : null}
                    <span className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge variant={animeLanguageStatusTone(item.status)}>
                        {animeLanguageStatusLabel(item.status)}
                      </Badge>
                      {formatLanguageName(item.languageCode)} ·{" "}
                      {item.mediaType === "audio" ? "Audio" : "Subtitles"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Evidence weight {item.confidence}/100 · Open evidence &amp; mappings
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                Page {page}
                {total !== null ? ` of ${Math.max(1, Math.ceil(total / 25))}` : ""} · 25 results per
                page
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={loading || page === 1}
                  onClick={() => setPage((n) => n - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    loading || !!error || (total === null ? items.length < 25 : page * 25 >= total)
                  }
                  onClick={() => setPage((n) => n + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
      {detailLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading selected anime…
        </p>
      ) : null}
      {detailError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          <span>{detailError}</span>
          <Button variant="outline" onClick={() => setDetailRetry((n) => n + 1)}>
            Retry details
          </Button>
          <Button variant="ghost" onClick={() => setSelected(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      <AnimeDetailDialog
        anime={anime}
        apiUrl={apiUrl}
        initialLanguage={selected?.languageCode}
        onClose={() => {
          setSelected(null);
          setAnime(null);
        }}
      />
    </div>
  );
}
