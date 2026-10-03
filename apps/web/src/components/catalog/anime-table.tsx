import { ArrowDown, ArrowUp, ChevronsUpDown, CircleAlert, SearchX } from "lucide-react";

import { AnimeCover } from "@/components/catalog/anime-cover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AnimeListItem } from "@/lib/anime-api";
import {
  animeFormatLabel,
  animeFormatVariant,
  animeScoreTone,
  animeSecondaryTitle,
  animeStatusLabel,
  animeStatusVariant,
  formatSeasonYear,
} from "@/lib/anime-format";
import type { AnimeCatalogQuery, AnimeSortField } from "@/lib/anime-query";
import { cn } from "@/lib/utils";

const COLUMN_COUNT = 8;
const SKELETON_ROWS = 8;

interface AnimeTableProps {
  query: AnimeCatalogQuery;
  rows: AnimeListItem[];
  loading: boolean;
  hasFilters: boolean;
  error?: string | null;
  onSort: (field: AnimeSortField) => void;
  onClearFilters: () => void;
  onRetry?: () => void;
  onSelect: (item: AnimeListItem) => void;
}

export function AnimeTable({
  query,
  rows,
  loading,
  hasFilters,
  error,
  onSort,
  onClearFilters,
  onRetry,
  onSelect,
}: AnimeTableProps) {
  return (
    <Table containerClassName="max-h-[min(72vh,780px)]" aria-busy={loading}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <SortableHead
            field="id"
            label="ID"
            query={query}
            onSort={onSort}
            align="right"
            className="hidden w-16 xl:table-cell"
          />
          <SortableHead
            field="title"
            label="Title"
            query={query}
            onSort={onSort}
            className="min-w-[240px]"
          />
          <SortableHead
            field="format"
            label="Format"
            query={query}
            onSort={onSort}
            className="hidden md:table-cell"
          />
          <SortableHead
            field="status"
            label="Status"
            query={query}
            onSort={onSort}
            className="hidden lg:table-cell"
          />
          <SortableHead
            field="seasonYear"
            label="Season"
            query={query}
            onSort={onSort}
            className="hidden lg:table-cell"
          />
          <SortableHead
            field="episodes"
            label="Episodes"
            query={query}
            onSort={onSort}
            align="right"
            className="hidden sm:table-cell"
          />
          <SortableHead field="score" label="Score" query={query} onSort={onSort} align="right" />
          <SortableHead
            field="popularity"
            label="Popularity"
            query={query}
            onSort={onSort}
            align="right"
            className="hidden xl:table-cell"
          />
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading ? (
          <SkeletonRows />
        ) : rows.length === 0 && error ? (
          <ErrorRow message={error} onRetry={onRetry} />
        ) : rows.length === 0 ? (
          <EmptyRow hasFilters={hasFilters} onClearFilters={onClearFilters} />
        ) : (
          rows.map((item) => <AnimeRow key={item.id} item={item} onSelect={onSelect} />)
        )}
      </TableBody>
    </Table>
  );
}

function SortableHead({
  field,
  label,
  query,
  onSort,
  align = "left",
  className,
}: {
  field: AnimeSortField;
  label: string;
  query: AnimeCatalogQuery;
  onSort: (field: AnimeSortField) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = query.sort === field;
  const ascending = query.order === "asc";
  const Icon = active ? (ascending ? ArrowUp : ArrowDown) : ChevronsUpDown;

  return (
    <TableHead
      aria-sort={active ? (ascending ? "ascending" : "descending") : "none"}
      className={cn(align === "right" && "text-right", className)}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        title={`Sort by ${label.toLowerCase()}`}
        className={cn(
          "group/sort -mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-1 transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          active ? "text-foreground" : "hover:text-foreground",
        )}
      >
        {label}
        <Icon
          aria-hidden="true"
          className={cn(
            "size-3.5 transition-opacity",
            !active && "opacity-0 group-hover/sort:opacity-70",
          )}
        />
      </button>
    </TableHead>
  );
}

function AnimeRow({
  item,
  onSelect,
}: {
  item: AnimeListItem;
  onSelect: (item: AnimeListItem) => void;
}) {
  const secondary = animeSecondaryTitle(item);

  return (
    <TableRow>
      <TableCell className="hidden text-right font-mono text-xs text-muted-foreground xl:table-cell">
        {item.id}
      </TableCell>
      <TableCell className="w-full max-w-0">
        <button
          type="button"
          onClick={() => onSelect(item)}
          aria-label={`View details for ${item.titleRomaji}`}
          className="group/title flex w-full min-w-0 items-center gap-3 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring"
        >
          <AnimeCover item={item} className="h-14 w-10 rounded-md" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium transition-colors group-hover/title:text-primary">
              {item.titleRomaji}
            </span>
            {secondary ? (
              <span className="block truncate text-xs text-muted-foreground" title={secondary}>
                {secondary}
              </span>
            ) : null}
          </span>
        </button>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {item.format ? (
          <Badge variant={animeFormatVariant(item.format)}>{animeFormatLabel(item.format)}</Badge>
        ) : (
          <Dash />
        )}
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        {item.status ? (
          <Badge variant={animeStatusVariant(item.status)}>
            {item.status === "RELEASING" ? (
              <span className="live-dot size-1.5 rounded-full bg-current" aria-hidden="true" />
            ) : null}
            {animeStatusLabel(item.status)}
          </Badge>
        ) : (
          <Dash />
        )}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap lg:table-cell">
        {item.season || item.seasonYear !== null ? (
          formatSeasonYear(item.season, item.seasonYear)
        ) : (
          <Dash />
        )}
      </TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">
        {item.episodeCount ?? <Dash />}
      </TableCell>
      <TableCell className="text-right">
        <ScoreBadge score={item.averageScore} />
      </TableCell>
      <TableCell className="hidden text-right tabular-nums xl:table-cell">
        {item.popularity === null ? <Dash /> : item.popularity.toLocaleString()}
      </TableCell>
    </TableRow>
  );
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <Dash />;

  const toneClass = {
    success: "bg-success/14 text-success",
    primary: "bg-primary/12 text-primary",
    warning: "bg-warning/16 text-warning",
    muted: "bg-secondary text-secondary-foreground",
  }[animeScoreTone(score)];

  return (
    <span
      className={cn(
        "inline-flex min-w-10 justify-center rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums",
        toneClass,
      )}
    >
      {score}
    </span>
  );
}

function Dash() {
  return <span className="text-muted-foreground/70">—</span>;
}

function EmptyRow({
  hasFilters,
  onClearFilters,
}: {
  hasFilters: boolean;
  onClearFilters: () => void;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="py-16">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <SearchX className="size-5" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <p className="font-medium">No anime found</p>
            <p className="text-sm text-muted-foreground">
              {hasFilters
                ? "Try a different search or clear the filters."
                : "The catalog is empty. Run a sync to populate it."}
            </p>
          </div>
          {hasFilters ? (
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

function ErrorRow({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="py-16">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <CircleAlert className="size-5" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <p className="font-medium">Couldn't load the catalog</p>
            <p className="max-w-md break-words text-sm text-muted-foreground">{message}</p>
          </div>
          {onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <TableRow key={index} className="hover:bg-transparent">
          <TableCell className="hidden xl:table-cell">
            <Skeleton className="ml-auto h-4 w-8" />
          </TableCell>
          <TableCell>
            <div className="flex items-center gap-3">
              <Skeleton className="h-14 w-10 rounded-md" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-4 w-48 max-w-full" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
          </TableCell>
          <TableCell className="hidden md:table-cell">
            <Skeleton className="h-5 w-14 rounded-full" />
          </TableCell>
          <TableCell className="hidden lg:table-cell">
            <Skeleton className="h-5 w-20 rounded-full" />
          </TableCell>
          <TableCell className="hidden lg:table-cell">
            <Skeleton className="h-4 w-20" />
          </TableCell>
          <TableCell className="hidden sm:table-cell">
            <Skeleton className="ml-auto h-4 w-8" />
          </TableCell>
          <TableCell>
            <Skeleton className="ml-auto h-5 w-10" />
          </TableCell>
          <TableCell className="hidden xl:table-cell">
            <Skeleton className="ml-auto h-4 w-12" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}
