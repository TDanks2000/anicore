import { Badge } from "@/components/ui/badge";
import type { AnimeFull, AnimeLanguageStatusResponse } from "@/lib/anime-api";
import { animeProviderLabel, segmentRangeLabel } from "@/lib/anime-format";
import { inspectCoverage } from "@/lib/coverage-inspector";
import { evidenceLink, formatLanguageName } from "@/lib/language-status";

export function CoverageInspector({
  anime,
  language,
  languageCode,
}: {
  anime: AnimeFull;
  language: AnimeLanguageStatusResponse;
  languageCode: string;
}) {
  return (
    <details className="rounded-lg border border-border bg-muted/20 p-4">
      <summary className="cursor-pointer text-sm font-semibold">
        Why this result? Mappings &amp; coverage
      </summary>
      <div className="mt-4 flex flex-col gap-4">
        <p className="text-xs text-muted-foreground">
          Evidence weights describe source strength, not measured probabilities. Language-track
          existence, episode coverage and current regional licensing are separate questions.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["audio", "subtitle"] as const).map((mediaType) => {
            const coverage = inspectCoverage(
              anime.episodes,
              language.episodes,
              languageCode,
              mediaType,
              anime.episodeCount,
            );
            const status = language.statuses.find(
              (row) => row.languageCode === languageCode && row.mediaType === mediaType,
            );
            return (
              <div key={mediaType} className="rounded-lg border border-border p-3 text-xs">
                <h3 className="mb-2 text-sm font-medium">
                  {formatLanguageName(languageCode)} ·{" "}
                  {mediaType === "audio" ? "Audio" : "Subtitles"}
                </h3>
                <p>
                  Track status: {status?.status.replaceAll("_", " ") ?? "unknown"}
                  {status?.isManualOverride ? " · manual override" : ""}
                </p>
                {status ? (
                  <p className="mt-1 text-muted-foreground">
                    Evidence weight {status.confidence}/100
                    {status.notes ? ` · ${status.notes}` : ""}
                  </p>
                ) : null}
                <p className="mt-2">
                  {coverage.available} available · {coverage.missing} missing · {coverage.unknown}{" "}
                  unknown
                </p>
                {coverage.partial > 0 ? (
                  <p className="mt-1 text-muted-foreground">
                    Available includes {coverage.partial} partial result(s); these do not establish
                    complete coverage.
                  </p>
                ) : null}
                <p className="mt-1 text-muted-foreground">
                  {coverage.recorded} recorded normal episodes · {coverage.expected ?? "unknown"}{" "}
                  expected
                </p>
                {coverage.unrecorded ? (
                  <p className="mt-1 text-warning">
                    {coverage.unrecorded} expected episodes have no local episode record.
                  </p>
                ) : null}
                <p className="mt-2 font-medium">
                  {coverage.complete
                    ? "Complete known coverage"
                    : "Complete coverage has not been established."}
                </p>
                <p className="mt-1 text-muted-foreground">
                  Specials are excluded. Unrecorded expected episodes are shown separately from
                  unknown recorded episodes.
                </p>
              </div>
            );
          })}
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium">Stored identity &amp; provenance</h3>
          {anime.mappings.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No standalone provider mappings recorded.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {anime.mappings.map((mapping) => {
                const url = evidenceLink(mapping.providerUrl);
                return (
                  <li key={mapping.id} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium">{animeProviderLabel(mapping.provider)}</span>
                    <span className="break-all font-mono">{mapping.providerId}</span>
                    <Badge variant="outline">{mapping.isPrimary ? "Primary" : "Secondary"}</Badge>
                    <span className="text-muted-foreground">
                      {mapping.source} · weight {mapping.confidence}/100
                    </span>
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                      >
                        Provider record
                      </a>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium">Stored segment alignment</h3>
          {!anime.segmentMappings?.length ? (
            <p className="text-xs text-muted-foreground">
              No provider episode segments recorded. A title mapping alone does not establish
              episode alignment.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {anime.segmentMappings.map((mapping) => (
                <li key={mapping.id} className="rounded-lg border border-border p-3 text-xs">
                  <p className="break-all font-medium">
                    {animeProviderLabel(mapping.provider)} · {mapping.providerId}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {mapping.source} · weight {mapping.confidence}/100 ·{" "}
                    {mapping.isPrimary ? "primary" : "secondary"}
                  </p>
                  {mapping.segments.map((segment) => (
                    <p
                      key={`${segment.providerEpisodeStart}-${segment.localEpisodeStart}`}
                      className="mt-2"
                    >
                      {segmentRangeLabel(segment)} · local = provider{" "}
                      {segment.localEpisodeStart - segment.providerEpisodeStart >= 0 ? "+" : "−"}{" "}
                      {Math.abs(segment.localEpisodeStart - segment.providerEpisodeStart)}
                      <br />
                      Provider {segment.providerEpisodeStart} → local {segment.localEpisodeStart}
                      {" · "}provider {segment.providerEpisodeEnd} → local {segment.localEpisodeEnd}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          These are stored mappings, not a new matching decision. Historical abstention diagnostics
          are not recorded by this view; missing alignment must remain unresolved.
        </p>
      </div>
    </details>
  );
}
