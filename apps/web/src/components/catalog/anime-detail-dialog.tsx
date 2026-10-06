import { CircleAlert, ExternalLink, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { AnimeCover } from "@/components/catalog/anime-cover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { useAnimeDetail } from "@/hooks/use-anime-detail";
import type {
  AnimeEpisode,
  AnimeLanguageStatusRow,
  AnimeListItem,
  AnimeTagLink,
  EpisodeLanguageStatusRow,
} from "@/lib/anime-api";
import {
  animeDescriptionText,
  animeEpisodeTitle,
  animeFormatLabel,
  animeFormatVariant,
  animeProviderLabel,
  animeScoreTone,
  animeSecondaryTitle,
  animeStatusLabel,
  animeStatusVariant,
  formatSeasonYear,
  segmentRangeLabel,
} from "@/lib/anime-format";
import {
  animeLanguageStatusLabel,
  animeLanguageStatusTone,
  buildEpisodeStatusMap,
  episodeCoverage,
  episodeLanguageStatusLabel,
  episodeLanguageStatusTone,
  episodeLanguages,
  evidenceLink,
  formatLanguageName,
  groupAnimeLanguageStatuses,
  languageEvidenceSource,
} from "@/lib/language-status";
import { cn } from "@/lib/utils";

const PANEL_HEIGHT = "max-h-[min(88vh,900px)]";

export function AnimeDetailDialog({
  anime,
  apiUrl,
  onClose,
}: {
  anime: AnimeListItem | null;
  apiUrl: string;
  onClose: () => void;
}) {
  const animeId = anime?.id ?? null;
  const { data, loading, error, retry } = useAnimeDetail(apiUrl, animeId);
  const [language, setLanguage] = useState("en");
  const { toast } = useToast();

  useEffect(() => {
    if (error && animeId !== null) {
      toast({
        id: `anime-detail-${animeId}`,
        variant: "error",
        title: "Unable to load details",
        description: error,
      });
    }
  }, [animeId, error, toast]);

  const full = data?.full ?? null;
  const episodeStatuses = data?.language.episodes ?? [];
  const languageEvidence = data?.language.evidence ?? [];
  const languages = useMemo(
    () => (data ? episodeLanguages(data.language.episodes, data.language.statuses) : []),
    [data],
  );

  // Prefer English when available; otherwise show whatever has data.
  useEffect(() => {
    if (languages.length === 0) return;
    setLanguage((current) =>
      languages.includes(current) ? current : languages.includes("en") ? "en" : languages[0]!,
    );
  }, [languages]);

  const episodes = full?.episodes ?? [];
  const statusMap = useMemo(() => buildEpisodeStatusMap(episodeStatuses), [episodeStatuses]);
  const coverage = groupAnimeLanguageStatuses(data?.language.statuses ?? []);
  const episodeNumbers = new Set(episodes.map((episode) => episode.number));
  const dub = episodeCoverage(episodeStatuses, language, "audio", episodes.length, episodeNumbers);
  const sub = episodeCoverage(
    episodeStatuses,
    language,
    "subtitle",
    episodes.length,
    episodeNumbers,
  );
  const hasEpisodeRowsForLanguage = episodeStatuses.some((row) => row.languageCode === language);

  return (
    // The panel wrapper owns the height cap, so the dialog fits it exactly
    // instead of clipping the bottom with its own max-height.
    <Dialog open={anime !== null} onClose={onClose} labelledBy="anime-detail-title">
      {anime ? (
        <div className={cn("flex flex-col", PANEL_HEIGHT)}>
          <header className="flex items-start gap-4 border-b border-border p-5">
            <AnimeCover item={anime} className="h-28 w-20 rounded-lg" iconClassName="size-5" />
            <div className="min-w-0 flex-1">
              <h2
                id="anime-detail-title"
                className="text-lg font-semibold leading-tight tracking-tight"
              >
                {anime.titleRomaji}
              </h2>
              <TitleAlternates anime={anime} />
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {anime.format ? (
                  <Badge variant={animeFormatVariant(anime.format)}>
                    {animeFormatLabel(anime.format)}
                  </Badge>
                ) : null}
                {anime.status ? (
                  <Badge variant={animeStatusVariant(anime.status)}>
                    {animeStatusLabel(anime.status)}
                  </Badge>
                ) : null}
                {anime.season || anime.seasonYear !== null ? (
                  <Badge variant="outline">
                    {formatSeasonYear(anime.season, anime.seasonYear)}
                  </Badge>
                ) : null}
                {anime.episodeCount !== null ? (
                  <Badge variant="outline">{anime.episodeCount} episodes</Badge>
                ) : null}
                <ScoreChip score={anime.averageScore} />
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close details">
              <X />
            </Button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <DetailSkeleton />
            ) : error && !full ? (
              <DetailError message={error} onRetry={retry} />
            ) : full ? (
              <div className="flex flex-col gap-6 p-5">
                {error ? (
                  <div
                    role="status"
                    className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"
                  >
                    <span>Refresh failed. Showing the last loaded details.</span>
                    <Button variant="outline" size="sm" onClick={retry}>
                      Retry
                    </Button>
                  </div>
                ) : null}
                <Synopsis description={full.description} />

                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-border bg-muted/20 p-4 sm:grid-cols-4">
                  <Fact
                    label="Episodes"
                    value={full.episodeCount ?? (full.episodes.length || "—")}
                  />
                  <Fact
                    label="Duration"
                    value={full.durationMinutes === null ? "—" : `${full.durationMinutes} min`}
                  />
                  <Fact label="Season" value={formatSeasonYear(full.season, full.seasonYear)} />
                  <Fact label="Source" value={capitalize(full.source) ?? "—"} />
                  <Fact label="Aired" value={formatAired(full.startDate, full.endDate)} />
                  <Fact label="Country" value={full.countryOfOrigin ?? "—"} />
                  <Fact
                    label="Score"
                    value={
                      full.averageScore === null ? (
                        "—"
                      ) : (
                        <span className={scoreTextClass(full.averageScore)}>
                          {full.averageScore}
                          {full.meanScore !== null && full.meanScore !== full.averageScore ? (
                            <span className="ml-1 text-xs font-normal text-muted-foreground">
                              mean {full.meanScore}
                            </span>
                          ) : null}
                        </span>
                      )
                    }
                  />
                  <Fact
                    label="Popularity"
                    value={full.popularity === null ? "—" : full.popularity.toLocaleString()}
                  />
                </dl>

                <Section title="Dub & Sub availability">
                  {coverage.length === 0 ? (
                    <Hint>No language status recorded yet.</Hint>
                  ) : (
                    <ul className="grid gap-2 sm:grid-cols-2">
                      {coverage.map((entry) => (
                        <li
                          key={entry.languageCode}
                          className="rounded-lg border border-border px-3 py-2.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">
                              {formatLanguageName(entry.languageCode)}
                            </span>
                            <span className="font-mono text-[11px] uppercase text-muted-foreground">
                              {entry.languageCode}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <MediaStatusPill label="Audio" row={entry.audio} />
                            <MediaStatusPill label="Sub" row={entry.subtitle} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Availability confirms that a language track exists. Episode coverage is verified
                    separately; unknown coverage does not mean unavailable.
                  </p>
                  {languageEvidence.length > 0 ? (
                    <details className="rounded-lg border border-border px-3 py-2">
                      <summary className="cursor-pointer text-xs font-medium">
                        View availability evidence ({languageEvidence.length})
                      </summary>
                      <ul className="mt-3 flex flex-col gap-2">
                        {languageEvidence.map((item) => {
                          const url = evidenceLink(item.sourceUrl);
                          const source = languageEvidenceSource(item.sourceUrl, item.source);
                          return (
                            <li
                              key={item.id}
                              className="flex flex-wrap items-center justify-between gap-2 text-xs"
                            >
                              <span>
                                {formatLanguageName(item.languageCode)} ·{" "}
                                {item.mediaType === "audio" ? "Audio" : "Subtitles"} ·{" "}
                                {item.value.replaceAll("_", " ")}
                              </span>
                              <span className="flex items-center gap-2 text-muted-foreground">
                                {url ? (
                                  <a
                                    href={url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 underline underline-offset-2"
                                  >
                                    {source}
                                    <ExternalLink className="size-3" />
                                  </a>
                                ) : (
                                  source
                                )}
                                <span className="tabular-nums">{item.confidence}%</span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  ) : null}
                </Section>

                <Section
                  title="Episodes"
                  aside={
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        Audio{" "}
                        <span className="tabular-nums">
                          {dub.known ? dub.available : "?"}/{dub.total}
                        </span>
                      </Badge>
                      <Badge variant="outline">
                        Sub{" "}
                        <span className="tabular-nums">
                          {sub.known ? sub.available : "?"}/{sub.total}
                        </span>
                      </Badge>
                      {languages.length > 1 ? (
                        <Select
                          aria-label="Episode language"
                          containerClassName="w-[10.5rem]"
                          className="h-8 pl-2.5 text-xs"
                          value={language}
                          onChange={(event) => setLanguage(event.target.value)}
                        >
                          {languages.map((code) => (
                            <option key={code} value={code}>
                              {formatLanguageName(code)}
                            </option>
                          ))}
                        </Select>
                      ) : null}
                    </div>
                  }
                >
                  {episodes.length === 0 ? (
                    <Hint>No episodes recorded yet.</Hint>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <div className="overflow-hidden rounded-lg border border-border">
                        <Table containerClassName="max-h-80">
                          <TableHeader>
                            <TableRow className="hover:bg-transparent">
                              <TableHead className="w-12 text-right">#</TableHead>
                              <TableHead className="min-w-[200px]">Title</TableHead>
                              <TableHead className="w-28 text-right">Audio</TableHead>
                              <TableHead className="w-28 text-right">Sub</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {episodes.map((episode) => (
                              <EpisodeRow
                                key={episode.id}
                                episode={episode}
                                language={language}
                                statusMap={statusMap}
                              />
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      {!hasEpisodeRowsForLanguage ? (
                        <p className="text-xs text-muted-foreground">
                          No episode-level status recorded for {formatLanguageName(language)} yet.
                        </p>
                      ) : null}
                    </div>
                  )}
                </Section>

                {full.genres.length > 0 ? (
                  <Section title="Genres">
                    <div className="flex flex-wrap gap-1.5">
                      {full.genres.map((genre) => (
                        <Badge key={genre} variant="secondary">
                          {genre}
                        </Badge>
                      ))}
                    </div>
                  </Section>
                ) : null}

                {full.studios.length > 0 ? (
                  <Section title="Studios">
                    <div className="flex flex-wrap gap-1.5">
                      {full.studios.map((studio) => (
                        <Badge key={studio.id} variant={studio.isMain ? "default" : "outline"}>
                          {studio.name}
                        </Badge>
                      ))}
                    </div>
                  </Section>
                ) : null}

                {full.tags.length > 0 ? (
                  <Section title="Tags">
                    <div className="flex flex-wrap gap-1.5">
                      {topTags(full.tags).map((tag) => (
                        <Badge key={tag.id} variant="outline">
                          {tag.name}
                          {tag.rank !== null ? (
                            <span className="tabular-nums opacity-60">{tag.rank}%</span>
                          ) : null}
                        </Badge>
                      ))}
                    </div>
                  </Section>
                ) : null}

                <Section title="Provider mappings">
                  {full.mappings.length === 0 && !full.segmentMappings?.length ? (
                    <Hint>No provider mappings.</Hint>
                  ) : (
                    <ul className="grid gap-2 sm:grid-cols-2">
                      {(full.segmentMappings ?? []).map((mapping) => (
                        <li
                          key={`segment-${mapping.id}`}
                          className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="shrink-0 text-sm font-medium">
                              {animeProviderLabel(mapping.provider)}
                            </span>
                            <span className="truncate font-mono text-xs text-muted-foreground">
                              {mapping.providerSlug ?? mapping.providerId}
                            </span>
                            {mapping.segments.map((segment) => (
                              <Badge
                                key={`${segment.providerEpisodeStart}-${segment.localEpisodeStart}`}
                                variant="outline"
                                className="shrink-0 tabular-nums"
                              >
                                {segmentRangeLabel(segment)}
                              </Badge>
                            ))}
                            {mapping.source === "fuzzy" ? (
                              <Badge variant="secondary">Matched</Badge>
                            ) : null}
                          </div>
                          {mapping.providerUrl ? (
                            <a
                              href={mapping.providerUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
                            >
                              Open
                              <ExternalLink className="size-3" aria-hidden="true" />
                            </a>
                          ) : null}
                        </li>
                      ))}
                      {full.mappings.map((mapping) => (
                        <li
                          key={mapping.id}
                          className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="shrink-0 text-sm font-medium">
                              {animeProviderLabel(mapping.provider)}
                            </span>
                            <span className="truncate font-mono text-xs text-muted-foreground">
                              {mapping.providerId}
                            </span>
                            {mapping.isPrimary ? <Badge variant="default">Primary</Badge> : null}
                          </div>
                          {mapping.providerUrl ? (
                            <a
                              href={mapping.providerUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
                            >
                              Open
                              <ExternalLink className="size-3" aria-hidden="true" />
                            </a>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>

                {full.externalLinks.length > 0 ? (
                  <Section title="External links">
                    <ul className="flex flex-wrap gap-2">
                      {full.externalLinks.map((link) => (
                        <li key={link.id}>
                          <a
                            href={link.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          >
                            {link.site}
                            {link.type ? (
                              <span className="text-muted-foreground/70">· {link.type}</span>
                            ) : null}
                            <ExternalLink className="size-3" aria-hidden="true" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

function TitleAlternates({ anime }: { anime: AnimeListItem }) {
  const secondary = animeSecondaryTitle(anime);
  const native =
    anime.titleNative && anime.titleNative !== anime.titleRomaji && anime.titleNative !== secondary
      ? anime.titleNative
      : null;

  if (!secondary && !native) return null;

  return (
    <div className="mt-1 flex flex-col gap-0.5">
      {secondary ? <p className="text-sm text-muted-foreground">{secondary}</p> : null}
      {native ? <p className="text-sm text-muted-foreground/80">{native}</p> : null}
    </div>
  );
}

function Synopsis({ description }: { description: string | null }) {
  const text = animeDescriptionText(description);
  return (
    <Section title="Synopsis">
      {text ? (
        <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{text}</p>
      ) : (
        <Hint>No synopsis available.</Hint>
      )}
    </Section>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="break-words text-sm font-medium">{value}</dd>
    </div>
  );
}

function MediaStatusPill({ label, row }: { label: string; row: AnimeLanguageStatusRow | null }) {
  if (!row) {
    return (
      <Badge variant="outline" className="text-muted-foreground/70">
        {label}: —
      </Badge>
    );
  }

  return (
    <Badge
      variant={animeLanguageStatusTone(row.status)}
      title={`Confidence ${row.confidence}%${row.isManualOverride ? " · manually overridden" : ""}`}
    >
      {label}: {animeLanguageStatusLabel(row.status)}
      {row.confidence > 0 ? (
        <span className="tabular-nums opacity-70">{row.confidence}%</span>
      ) : null}
      {row.isManualOverride ? <span className="opacity-70">manual</span> : null}
    </Badge>
  );
}

function EpisodeRow({
  episode,
  language,
  statusMap,
}: {
  episode: AnimeEpisode;
  language: string;
  statusMap: Map<string, EpisodeLanguageStatusRow>;
}) {
  const key = (mediaType: "audio" | "subtitle") => `${episode.number}|${language}|${mediaType}`;

  return (
    <TableRow>
      <TableCell className="text-right font-mono text-xs text-muted-foreground">
        {episode.displayNumber ?? episode.number}
      </TableCell>
      <TableCell className="w-full max-w-0">
        <div className="truncate" title={animeEpisodeTitle(episode)}>
          {animeEpisodeTitle(episode)}
        </div>
        {episode.airDate ? (
          <div className="text-xs text-muted-foreground">{episode.airDate}</div>
        ) : null}
      </TableCell>
      <TableCell className="text-right">
        <EpisodeStatusBadge row={statusMap.get(key("audio"))} />
      </TableCell>
      <TableCell className="text-right">
        <EpisodeStatusBadge row={statusMap.get(key("subtitle"))} />
      </TableCell>
    </TableRow>
  );
}

function EpisodeStatusBadge({ row }: { row?: EpisodeLanguageStatusRow }) {
  if (!row || row.status === "unknown") {
    return <span className="text-muted-foreground/70">—</span>;
  }
  return (
    <Badge
      variant={episodeLanguageStatusTone(row.status)}
      title={`${row.provider} · confidence ${row.confidence}%`}
    >
      {episodeLanguageStatusLabel(row.status)}
    </Badge>
  );
}

function ScoreChip({ score }: { score: number | null }) {
  if (score === null) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums",
        {
          success: "bg-success/14 text-success",
          primary: "bg-primary/12 text-primary",
          warning: "bg-warning/16 text-warning",
          muted: "bg-secondary text-secondary-foreground",
        }[animeScoreTone(score)],
      )}
    >
      {score}
    </span>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function DetailError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 p-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <CircleAlert className="size-5" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <p className="font-medium">Couldn't load details</p>
        <p className="max-w-md break-words text-sm text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-5">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
      <Skeleton className="h-24 w-full rounded-lg" />
      <Skeleton className="h-44 w-full rounded-lg" />
    </div>
  );
}

function capitalize(value: string | null): string | null {
  if (!value) return null;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function formatAired(start: string | null, end: string | null): string {
  if (start && end) return `${start} → ${end}`;
  return start ?? end ?? "—";
}

function scoreTextClass(score: number): string {
  return {
    success: "font-semibold text-success",
    primary: "font-semibold text-primary",
    warning: "font-semibold text-warning",
    muted: "font-semibold",
  }[animeScoreTone(score)];
}

function topTags(tags: AnimeTagLink[]): AnimeTagLink[] {
  return [...tags].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0)).slice(0, 12);
}
