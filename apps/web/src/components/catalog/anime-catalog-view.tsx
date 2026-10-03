import { RefreshCw, Table2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AnimeDetailDialog } from "@/components/catalog/anime-detail-dialog";
import { AnimePagination } from "@/components/catalog/anime-pagination";
import { AnimeTable } from "@/components/catalog/anime-table";
import { AnimeToolbar } from "@/components/catalog/anime-toolbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { useAnimeCatalog } from "@/hooks/use-anime-catalog";
import type { AnimeListItem } from "@/lib/anime-api";
import { hasActiveAnimeFilters } from "@/lib/anime-query";

export function AnimeCatalogView({ apiUrl }: { apiUrl: string }) {
  const catalog = useAnimeCatalog(apiUrl);
  const searchRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<AnimeListItem | null>(null);

  // "/" jumps to search, like most data tools.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const { toast } = useToast();
  useEffect(() => {
    if (catalog.error) {
      toast({
        id: "catalog-load",
        variant: "error",
        title: "Unable to load the catalog",
        description: catalog.error,
      });
    }
  }, [catalog.error, toast]);

  const hasFilters = hasActiveAnimeFilters(catalog.query);

  const countLabel = catalog.loading
    ? "Loading…"
    : catalog.total === null
      ? "Anime catalog"
      : `${catalog.total.toLocaleString()} anime`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Anime Catalog</h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Browse every anime in the AniCore database. Search, filter and sort without leaving the
            dashboard.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
            <Table2 aria-hidden="true" />
            {countLabel}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={catalog.refresh}
            disabled={catalog.refreshing || catalog.loading}
          >
            <RefreshCw className={catalog.refreshing ? "animate-spin" : undefined} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4 p-5">
          <AnimeToolbar
            query={catalog.query}
            searchRef={searchRef}
            onSearch={catalog.setSearch}
            onFilter={catalog.setFilters}
            onClear={catalog.clearFilters}
          />

          <div className="relative">
            {catalog.refreshing ? (
              <div
                aria-hidden="true"
                className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden rounded-full bg-primary/15"
              >
                <div className="indeterminate-bar h-full w-1/3 rounded-full bg-primary" />
              </div>
            ) : null}
            <div className="overflow-hidden rounded-lg border border-border">
              <AnimeTable
                query={catalog.query}
                rows={catalog.rows}
                loading={catalog.loading}
                hasFilters={hasFilters}
                error={catalog.error}
                onSort={catalog.sortBy}
                onClearFilters={catalog.clearFilters}
                onRetry={catalog.refresh}
                onSelect={setSelected}
              />
            </div>
          </div>

          <AnimePagination
            query={catalog.query}
            total={catalog.total}
            itemCount={catalog.rows.length}
            loading={catalog.loading}
            onPage={catalog.setPage}
            onPageSize={catalog.setPageSize}
          />
        </CardContent>
      </Card>

      <AnimeDetailDialog anime={selected} apiUrl={apiUrl} onClose={() => setSelected(null)} />
    </div>
  );
}
