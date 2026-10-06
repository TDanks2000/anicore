import { Search, X } from "lucide-react";
import { type RefObject, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import {
  ANIME_FORMAT_OPTIONS,
  ANIME_SEASON_OPTIONS,
  ANIME_STATUS_OPTIONS,
  animeFormatLabel,
  animeSeasonLabel,
  animeStatusLabel,
  animeYearOptions,
} from "@/lib/anime-format";
import {
  type AnimeCatalogQuery,
  type AnimeFilterPatch,
  hasActiveAnimeFilters,
} from "@/lib/anime-query";

interface AnimeToolbarProps {
  query: AnimeCatalogQuery;
  searchRef: RefObject<HTMLInputElement | null>;
  onSearch: (q: string) => void;
  onFilter: (patch: AnimeFilterPatch) => void;
  onClear: () => void;
}

export function AnimeToolbar({ query, searchRef, onSearch, onFilter, onClear }: AnimeToolbarProps) {
  const yearOptions = useMemo(() => animeYearOptions(), []);
  const hasFilters = hasActiveAnimeFilters(query);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 xl:flex-row xl:items-center">
        <div className="relative min-w-0 flex-1 xl:max-w-md">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <label htmlFor="anime-search" className="sr-only">
            Search anime
          </label>
          <Input
            id="anime-search"
            ref={searchRef}
            type="search"
            value={query.q}
            onChange={(event) => onSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query.q) {
                event.preventDefault();
                onSearch("");
              }
            }}
            placeholder="Search titles, synonyms, slugs…"
            autoComplete="off"
            spellCheck={false}
            className="pl-9 pr-14 [&::-webkit-search-cancel-button]:hidden"
          />
          <div className="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center">
            {query.q ? (
              <button
                type="button"
                onClick={() => onSearch("")}
                aria-label="Clear search"
                className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            ) : (
              <kbd className="hidden rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground sm:inline-block">
                /
              </kbd>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:ml-auto xl:flex">
          <Select
            aria-label="Filter by format"
            containerClassName="min-w-0 xl:w-[8.5rem]"
            value={query.format}
            onValueChange={(value) => onFilter({ format: value })}
          >
            <SelectItem value="">All formats</SelectItem>
            {ANIME_FORMAT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </Select>

          <Select
            aria-label="Filter by status"
            containerClassName="min-w-0 xl:w-[10.5rem]"
            value={query.status}
            onValueChange={(value) => onFilter({ status: value })}
          >
            <SelectItem value="">All statuses</SelectItem>
            {ANIME_STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </Select>

          <Select
            aria-label="Filter by season"
            containerClassName="min-w-0 xl:w-[7.5rem]"
            value={query.season}
            onValueChange={(value) => onFilter({ season: value })}
          >
            <SelectItem value="">All seasons</SelectItem>
            {ANIME_SEASON_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </Select>

          <Select
            aria-label="Filter by year"
            containerClassName="min-w-0 xl:w-[7rem]"
            value={query.seasonYear}
            onValueChange={(value) => onFilter({ seasonYear: value })}
          >
            <SelectItem value="">All years</SelectItem>
            {yearOptions.map((year) => (
              <SelectItem key={year} value={year}>
                {year}
              </SelectItem>
            ))}
          </Select>
        </div>
      </div>

      {hasFilters ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {query.q.trim() ? (
            <FilterChip label="Search" value={query.q.trim()} onRemove={() => onSearch("")} />
          ) : null}
          {query.format ? (
            <FilterChip
              label="Format"
              value={animeFormatLabel(query.format)}
              onRemove={() => onFilter({ format: "" })}
            />
          ) : null}
          {query.status ? (
            <FilterChip
              label="Status"
              value={animeStatusLabel(query.status)}
              onRemove={() => onFilter({ status: "" })}
            />
          ) : null}
          {query.season ? (
            <FilterChip
              label="Season"
              value={animeSeasonLabel(query.season) ?? query.season}
              onRemove={() => onFilter({ season: "" })}
            />
          ) : null}
          {query.seasonYear ? (
            <FilterChip
              label="Year"
              value={query.seasonYear}
              onRemove={() => onFilter({ seasonYear: "" })}
            />
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="h-7 px-2 text-xs text-muted-foreground"
          >
            Clear all
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FilterChip({
  label,
  value,
  onRemove,
}: {
  label: string;
  value: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-card py-0.5 pl-2.5 pr-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{label}:</span>
      <span className="truncate">{value}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}: ${value}`}
        className="rounded-full p-0.5 transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </span>
  );
}
