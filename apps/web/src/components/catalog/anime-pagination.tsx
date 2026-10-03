import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  ANIME_PAGE_SIZES,
  type AnimeCatalogQuery,
  animeHasNextPage,
  animePageBounds,
} from "@/lib/anime-query";

interface AnimePaginationProps {
  query: AnimeCatalogQuery;
  total: number | null;
  itemCount: number;
  loading: boolean;
  onPage: (page: number) => void;
  onPageSize: (pageSize: number) => void;
}

export function AnimePagination({
  query,
  total,
  itemCount,
  loading,
  onPage,
  onPageSize,
}: AnimePaginationProps) {
  const bounds = animePageBounds(query.page, query.pageSize, total);
  const hasNext = animeHasNextPage(query.page, query.pageSize, total, itemCount);
  const lastPage = bounds.lastPage;

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {loading ? (
          "Loading results…"
        ) : total === null ? (
          itemCount > 0 ? (
            `Showing ${itemCount.toLocaleString()} on this page`
          ) : (
            "No results"
          )
        ) : total === 0 ? (
          "No results"
        ) : (
          <>
            Showing{" "}
            <span className="font-medium tabular-nums text-foreground">
              {bounds.start.toLocaleString()}–{bounds.end.toLocaleString()}
            </span>{" "}
            of{" "}
            <span className="font-medium tabular-nums text-foreground">
              {total.toLocaleString()}
            </span>
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor="anime-page-size" className="text-xs text-muted-foreground">
            Rows
          </label>
          <Select
            id="anime-page-size"
            containerClassName="w-[4.75rem]"
            className="h-8 pl-2.5 text-xs"
            value={String(query.pageSize)}
            disabled={loading}
            onChange={(event) => onPageSize(Number(event.target.value))}
          >
            {ANIME_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={loading || query.page <= 1}
            onClick={() => onPage(1)}
            aria-label="First page"
          >
            <ChevronsLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={loading || query.page <= 1}
            onClick={() => onPage(query.page - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft />
          </Button>
          <span className="min-w-24 text-center text-xs tabular-nums text-muted-foreground">
            Page <span className="font-medium text-foreground">{query.page}</span>
            {lastPage !== null ? ` of ${lastPage.toLocaleString()}` : ""}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={loading || !hasNext}
            onClick={() => onPage(query.page + 1)}
            aria-label="Next page"
          >
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={loading || lastPage === null || query.page >= lastPage}
            onClick={() => onPage(lastPage ?? query.page)}
            aria-label="Last page"
          >
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
