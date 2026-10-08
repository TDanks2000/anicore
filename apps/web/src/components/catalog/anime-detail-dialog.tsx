import { CircleAlert, ExternalLink, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { AnimeCover } from "@/components/catalog/anime-cover";
import { CoverageInspector } from "@/components/catalog/coverage-inspector";
import { ProviderFreshnessPanel } from "@/components/catalog/provider-freshness";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Select, SelectItem } from "@/components/ui/select";
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
  AnimeMapping,
  AnimeSegmentMapping,
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

export function AnimeDetailDialog({
  anime,
  apiUrl,
  onClose,
  revision,
  initialLanguage,
}: {
  anime: AnimeListItem | null;
  apiUrl: string;
  onClose: () => void;
  revision?: string | null;
  initialLanguage?: string;
}) {
  const animeId = anime?.id ?? null;
  const { data, loading, error, retry } = useAnimeDetail(apiUrl, animeId, revision);
  const [language, setLanguage] = useState(initialLanguage ?? "en");
  const [activePanel, setActivePanel] = useState("overview");
  const bodyRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [activePanel, animeId]);
  useEffect(() => {
    setLanguage(initialLanguage ?? "en");
    setActivePanel("overview");
  }, [animeId, initialLanguage]);
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
  const full = data?.full.id === animeId ? data.full : null;
  const shownAnime = full ?? anime;
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
    <Dialog
      open={anime !== null}
      onClose={onClose}
      labelledBy="anime-detail-title"
      className="h-[min(1080px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[1920px] sm:h-[min(1080px,calc(100dvh-3rem))] sm:max-h-[calc(100dvh-3rem)] sm:w-[calc(100vw-3rem)]"
    >
      {anime ? (
        <div className="flex h-full min-h-0 flex-col">
          <header className="flex shrink-0 items-start gap-4 border-b border-border p-5">
            <AnimeCover
              item={shownAnime!}
              className="h-28 w-20 rounded-lg"
              iconClassName="size-5"
            />
            <div className="min-w-0 flex-1">
              <h2
                id="anime-detail-title"
                className="text-lg font-semibold leading-tight tracking-tight"
              >
                {shownAnime!.titleRomaji}
              </h2>
              <TitleAlternates anime={shownAnime!} />
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {shownAnime!.format ? (
                  <Badge variant={animeFormatVariant(shownAnime!.format)}>
                    {animeFormatLabel(shownAnime!.format)}
                  </Badge>
                ) : null}
                {shownAnime!.status ? (
                  <Badge variant={animeStatusVariant(shownAnime!.status)}>
                    {animeStatusLabel(shownAnime!.status)}
                  </Badge>
                ) : null}
                {shownAnime!.season || shownAnime!.seasonYear !== null ? (
                  <Badge variant="outline">
                    {formatSeasonYear(shownAnime!.season, shownAnime!.seasonYear)}
                  </Badge>
                ) : null}
                {shownAnime!.episodeCount !== null ? (
                  <Badge variant="outline">{shownAnime!.episodeCount} episodes</Badge>
                ) : null}
                <ScoreChip score={shownAnime!.averageScore} />
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close details">
              <X />
            </Button>
          </header>
          <nav
            aria-label="Detail sections"
            className="flex shrink-0 gap-2 border-b border-border p-3 xl:hidden"
          >
            {[
              ["overview", "Overview"],
              ["mappings", "Mappings"],
              ["episodes", "Seasons & episodes"],
            ].map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                variant={activePanel === value ? "default" : "ghost"}
                aria-pressed={activePanel === value}
                onClick={() => setActivePanel(value!)}
              >
                {label}
              </Button>
            ))}
          </nav>
          <div
            ref={bodyRef}
            className="min-h-0 flex-1 overflow-y-auto xl:flex xl:flex-col xl:overflow-hidden"
          >
            {loading ? (
              <DetailSkeleton />
            ) : error && !full ? (
              <DetailError message={error} onRetry={retry} />
            ) : full ? (
              <div className="flex min-h-0 flex-1 flex-col">
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
                <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)_minmax(0,1.35fr)]">
                  <DetailColumn
                    active={activePanel === "overview"}
                    title="Overview"
                    description="Story, release details and metadata"
                  >
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-border bg-muted/20 p-4 sm:grid-cols-4 xl:grid-cols-2">
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
                    <Synopsis description={full.description} />
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
                          {sortedTags(full.tags).map((tag) => (
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
                    {full.synonyms.length > 0 ? (
                      <Section title="Alternative titles">
                        <ul className="space-y-1 text-sm">
                          {full.synonyms.map((title) => (
                            <li key={title}>{title}</li>
                          ))}
                        </ul>
                      </Section>
                    ) : null}
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
                    ) : null}{" "}
                  </DetailColumn>
                  <DetailColumn
                    active={activePanel === "mappings"}
                    title="Mappings & availability"
                    description="Provider records, episode alignment and languages"
                  >
                    <Section
                      title="Provider mappings"
                      aside={
                        <Badge variant="outline">
                          {full.mappings.length + (full.segmentMappings?.length ?? 0)} records
                        </Badge>
                      }
                    >
                      {full.mappings.length === 0 && !full.segmentMappings?.length ? (
                        <Hint>No provider mappings recorded.</Hint>
                      ) : (
                        <ul className="space-y-3">
                          {full.mappings.map((mapping) => (
                            <MappingCard key={`title-${mapping.id}`} mapping={mapping} />
                          ))}
                          {(full.segmentMappings ?? []).map((mapping) => (
                            <MappingCard
                              key={`segment-${mapping.id}`}
                              mapping={mapping}
                              segments={mapping.segments}
                            />
                          ))}
                        </ul>
                      )}
                    </Section>
                    <Section title="Dub & Sub availability">
                      {coverage.length === 0 ? (
                        <Hint>No language status recorded yet.</Hint>
                      ) : (
                        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
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
                        Confirmed status establishes that a language track exists. Episode coverage
                        is verified separately; unknown coverage does not mean unavailable.
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
                                    <span className="tabular-nums">
                                      Weight {item.confidence}/100
                                    </span>
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        </details>
                      ) : null}
                    </Section>
                    <ProviderFreshnessPanel apiUrl={apiUrl} animeId={full.id} revision={revision} />
                  </DetailColumn>
                  <DetailColumn
                    active={activePanel === "episodes"}
                    title="Seasons & episodes"
                    description={`${episodes.length} recorded episodes · ${formatLanguageName(language)}`}
                  >
                    <Section
                      title="Seasons & episodes"
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
                              onValueChange={setLanguage}
                            >
                              {languages.map((code) => (
                                <SelectItem key={code} value={code}>
                                  {formatLanguageName(code)}
                                </SelectItem>
                              ))}
                            </Select>
                          ) : null}
                        </div>
                      }
                    >
                      <SeasonEpisodes
                        episodes={episodes}
                        language={language}
                        statusMap={statusMap}
                      />
                      {!hasEpisodeRowsForLanguage && episodes.length > 0 ? (
                        <Hint>
                          No episode-level status recorded for {formatLanguageName(language)} yet.
                        </Hint>
                      ) : null}
                    </Section>
                    {full.relations.length > 0 ? (
                      <Section title="Related entries">
                        <ul className="grid gap-2 sm:grid-cols-2">
                          {full.relations.map((relation) => (
                            <li
                              key={relation.id}
                              className="rounded-lg border border-border p-3 text-sm"
                            >
                              <p className="font-medium">
                                {relation.relationType.replaceAll("_", " ").toLowerCase()}
                              </p>
                              <p className="text-muted-foreground">
                                Catalog ID {relation.relatedAnimeId}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </Section>
                    ) : null}
                    {data ? (
                      <CoverageInspector
                        anime={full}
                        language={data.language}
                        languageCode={language}
                      />
                    ) : null}
                  </DetailColumn>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

function DetailColumn({
  active,
  title,
  description,
  children,
}: {
  active: boolean;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-h-0 min-w-0 flex-col border-b border-border last:border-0 xl:flex xl:border-r xl:border-b-0",
        active ? "flex" : "hidden",
      )}
    >
      <div className="shrink-0 border-b border-border bg-muted/25 px-5 py-3">
        <h3 className="font-semibold">{title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex min-h-0 flex-col gap-6 p-5 xl:overflow-y-auto">{children}</div>
    </div>
  );
}

function MappingCard({
  mapping,
  segments,
}: {
  mapping: AnimeMapping | AnimeSegmentMapping;
  segments?: AnimeSegmentMapping["segments"];
}) {
  return (
    <li className="rounded-lg border border-border bg-muted/10 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">{animeProviderLabel(mapping.provider)}</span>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">{segments ? "Shared season" : "Title mapping"}</Badge>
          <Badge variant={mapping.isPrimary ? "default" : "secondary"}>
            {mapping.isPrimary ? "Primary" : "Secondary"}
          </Badge>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3">
        <Fact label="Mapping record" value={mapping.id} />
        <Fact
          label="Provider ID"
          value={<span className="break-all font-mono text-xs">{mapping.providerId}</span>}
        />
        <Fact label="Match source" value={mapping.source.replaceAll("_", " ")} />
        {mapping.providerSlug ? (
          <Fact label="Slug" value={<span className="break-all">{mapping.providerSlug}</span>} />
        ) : null}
        <Fact label="Evidence weight" value={`${mapping.confidence}/100`} />
        <Fact label="Updated" value={new Date(mapping.updatedAt).toLocaleString()} />
        {"createdAt" in mapping ? (
          <Fact label="Created" value={new Date(mapping.createdAt).toLocaleString()} />
        ) : null}
      </dl>
      {segments ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <p className="text-xs font-medium">Episode alignment</p>
          {segments.length ? (
            segments.map((segment) => (
              <p
                key={`${segment.providerEpisodeStart}-${segment.localEpisodeStart}`}
                className="text-sm tabular-nums"
              >
                <span className="block">
                  Provider episodes {segment.providerEpisodeStart}–{segment.providerEpisodeEnd}
                </span>
                <span className="block text-muted-foreground">
                  → Catalog episodes {segment.localEpisodeStart}–{segment.localEpisodeEnd}
                </span>
              </p>
            ))
          ) : (
            <Hint>No episode alignment recorded.</Hint>
          )}
        </div>
      ) : null}
      {mapping.providerUrl ? (
        <a
          href={mapping.providerUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 flex items-start gap-2 text-sm text-primary hover:underline"
        >
          <span className="min-w-0 break-all">{mapping.providerUrl}</span>
          <ExternalLink className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        </a>
      ) : null}
    </li>
  );
}

function SeasonEpisodes({
  episodes,
  language,
  statusMap,
}: {
  episodes: AnimeEpisode[];
  language: string;
  statusMap: Map<string, EpisodeLanguageStatusRow>;
}) {
  if (!episodes.length) return <Hint>No seasons or episodes recorded yet.</Hint>;
  const seasons = new Map<number | null, AnimeEpisode[]>();
  for (const episode of episodes) {
    const key = episode.seasonNumber ?? null;
    const group = seasons.get(key) ?? [];
    group.push(episode);
    seasons.set(key, group);
  }
  return (
    <div className="space-y-4">
      <nav aria-label="Jump to season" className="flex flex-wrap gap-2">
        {[...seasons.entries()]
          .sort(([a], [b]) => (a ?? Infinity) - (b ?? Infinity))
          .map(([season, rows]) => (
            <Button
              key={season ?? "unassigned"}
              variant="outline"
              size="sm"
              onClick={() =>
                document
                  .getElementById(`catalog-season-${season ?? "unassigned"}`)
                  ?.scrollIntoView({ block: "start" })
              }
            >
              {season === null ? "Unassigned" : season === 0 ? "Specials" : `Season ${season}`}{" "}
              <span className="text-muted-foreground">({rows.length})</span>
            </Button>
          ))}
      </nav>
      {[...seasons.entries()]
        .sort(([a], [b]) => (a ?? Infinity) - (b ?? Infinity))
        .map(([season, rows]) => (
          <section
            id={`catalog-season-${season ?? "unassigned"}`}
            key={season ?? "unassigned"}
            className="overflow-hidden rounded-lg border border-border"
          >
            <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-3">
              <h4 className="text-sm font-semibold">
                {season === null
                  ? "Season not recorded"
                  : season === 0
                    ? "Specials / Season 0"
                    : `Season ${season}`}
              </h4>
              <Badge variant="outline">{rows.length} episodes</Badge>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-12 text-right">#</TableHead>
                  <TableHead>Title / aired</TableHead>
                  <TableHead className="text-right">Audio</TableHead>
                  <TableHead className="text-right">Sub</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...rows]
                  .sort((a, b) => (a.sortNumber ?? a.number) - (b.sortNumber ?? b.number))
                  .map((episode) => (
                    <EpisodeRow
                      key={episode.id}
                      episode={episode}
                      language={language}
                      statusMap={statusMap}
                    />
                  ))}
              </TableBody>
            </Table>
          </section>
        ))}
    </div>
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
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
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
      title={`Evidence weight ${row.confidence}/100${row.isManualOverride ? " · manually overridden" : ""}`}
    >
      {label}: {animeLanguageStatusLabel(row.status)}
      {row.confidence > 0 ? (
        <span className="tabular-nums opacity-70">Weight {row.confidence}/100</span>
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
      <TableCell className="min-w-48">
        <div className="whitespace-normal break-words" title={animeEpisodeTitle(episode)}>
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
      title={`${row.provider} · evidence weight ${row.confidence}/100`}
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

function sortedTags(tags: AnimeTagLink[]): AnimeTagLink[] {
  return [...tags].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
}
