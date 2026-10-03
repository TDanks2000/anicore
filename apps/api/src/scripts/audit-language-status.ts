import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { closeDb, db } from "@anicore/db";
import {
  normalizeLanguageCode,
  resolveAnimeStatusFromEvidence,
} from "@anicore/db/language-status-scoring";
import { animeProviderMappings, providerEntities } from "@anicore/db/provider-mapping-schema";
import {
  anime,
  animeLanguageEvidence,
  animeLanguageStatus,
  animeMappings,
  episodeLanguageStatus,
  episodeMappings,
  episodes,
} from "@anicore/db/schema";
import { eq } from "drizzle-orm";

export async function auditLanguageStatus() {
  const [
    animeRows,
    statuses,
    evidence,
    episodeRows,
    canonical,
    mappings,
    crunchyrollMappings,
    crunchyrollEpisodes,
  ] = await Promise.all([
    db.select().from(anime),
    db.select().from(animeLanguageStatus),
    db.select().from(animeLanguageEvidence),
    db.select().from(episodeLanguageStatus),
    db.select().from(episodes),
    db.select().from(animeMappings),
    db
      .select({ animeId: animeProviderMappings.animeId, url: providerEntities.providerUrl })
      .from(animeProviderMappings)
      .innerJoin(providerEntities, eq(animeProviderMappings.providerEntityId, providerEntities.id))
      .where(eq(providerEntities.provider, "crunchyroll")),
    db
      .select({ animeId: episodes.animeId, number: episodes.number })
      .from(episodeMappings)
      .innerJoin(episodes, eq(episodeMappings.episodeId, episodes.id))
      .where(eq(episodeMappings.provider, "crunchyroll")),
  ]);
  const findings: Array<{ code: string; count: number; samples: unknown[] }> = [];
  const add = (code: string, rows: unknown[]) => {
    if (rows.length) findings.push({ code, count: rows.length, samples: rows.slice(0, 20) });
  };
  const key = (row: { animeId: number; languageCode: string; mediaType: string }) =>
    `${row.animeId}:${row.languageCode}:${row.mediaType}`;
  const evidenceByStatus = new Map<string, typeof evidence>();
  for (const row of evidence)
    evidenceByStatus.set(key(row), [...(evidenceByStatus.get(key(row)) ?? []), row]);
  const statusByKey = new Map(statuses.map((row) => [key(row), row]));
  add(
    "resolved-status-disagrees-with-evidence",
    statuses.filter((row) => {
      if (row.isManualOverride) return false;
      const expected = resolveAnimeStatusFromEvidence(evidenceByStatus.get(key(row)) ?? []);
      return row.status !== expected.status || row.confidence !== expected.confidence;
    }),
  );
  add(
    "evidence-without-resolved-status",
    evidence.filter((row) => !statusByKey.has(key(row))),
  );
  add(
    "unsupported-schedule-negative",
    evidence.filter(
      (row) =>
        row.source === "provider" &&
        row.sourceUrl?.startsWith("https://animeschedule.net/") &&
        ["not_available", "missing", "no_dub", "unavailable"].includes(row.value),
    ),
  );
  add(
    "unsupported-schedule-episode-negative",
    episodeRows.filter((row) => row.provider === "animeschedule" && row.status === "missing"),
  );
  add(
    "subtitle-inferred-from-original-air-date",
    episodeRows.filter((row) => row.provider === "derived-airdate" && row.mediaType === "subtitle"),
  );
  const canonicalKeys = new Set(canonical.map((row) => `${row.animeId}:${row.number}`));
  add(
    "language-status-for-noncanonical-episode",
    episodeRows.filter((row) => !canonicalKeys.has(`${row.animeId}:${row.episodeNumber}`)),
  );
  const crunchyrollKeys = new Set(crunchyrollMappings.map((row) => `${row.animeId}:${row.url}`));
  const mappingKeys = new Set(
    mappings
      .filter((row) => row.source !== "fuzzy" && row.confidence === 100)
      .map((row) => `${row.animeId}:${row.provider}:${row.providerId}`),
  );
  add(
    "provider-evidence-without-verified-identity",
    evidence.filter((row) => {
      if (row.source !== "provider" || !row.sourceUrl) return false;
      const schedule = /^https:\/\/animeschedule\.net\/anime\/([^/?#]+)$/.exec(row.sourceUrl);
      if (schedule) return !mappingKeys.has(`${row.animeId}:animeschedule:${schedule[1]}`);
      const jikan = /^https:\/\/api\.jikan\.moe\/v4\/anime\/(\d+)\/characters$/.exec(row.sourceUrl);
      if (jikan) return !mappingKeys.has(`${row.animeId}:mal:${jikan[1]}`);
      const kitsu = /^https:\/\/kitsu\.io\/api\/edge\/anime\/(\d+)\/streaming-links#\d+$/.exec(
        row.sourceUrl,
      );
      if (kitsu) return !mappingKeys.has(`${row.animeId}:kitsu:${kitsu[1]}`);
      const cast = /^https:\/\/anilist\.co\/anime\/(\d+)\/characters$/.exec(row.sourceUrl);
      if (cast) return !mappingKeys.has(`${row.animeId}:anilist:${cast[1]}`);
      if (row.sourceUrl.startsWith("https://www.crunchyroll.com/"))
        return !crunchyrollKeys.has(`${row.animeId}:${row.sourceUrl}`);
      return false;
    }),
  );
  const crunchyrollEpisodeKeys = new Set(
    crunchyrollEpisodes.map((row) => `${row.animeId}:${row.number}`),
  );
  add(
    "crunchyroll-episode-status-without-episode-mapping",
    episodeRows.filter(
      (row) =>
        row.provider === "crunchyroll" &&
        !crunchyrollEpisodeKeys.has(`${row.animeId}:${row.episodeNumber}`),
    ),
  );
  // Crunchyroll's catalogue is regional, so it can only ever prove presence.
  add(
    "regional-catalogue-negative",
    episodeRows.filter((row) => row.provider === "crunchyroll" && row.status !== "available"),
  );
  add(
    "non-canonical-language-code",
    [...statuses, ...evidence, ...episodeRows].filter(
      (row) => normalizeLanguageCode(row.languageCode) !== row.languageCode,
    ),
  );
  const summary: Record<string, number> = {};
  for (const row of statuses) {
    const label = `${row.languageCode}:${row.mediaType}:${row.status}`;
    summary[label] = (summary[label] ?? 0) + 1;
  }
  return {
    ok: findings.length === 0,
    generatedAt: new Date().toISOString(),
    animeCount: animeRows.length,
    evidenceCount: evidence.length,
    episodeStatusCount: episodeRows.length,
    findings,
    summary,
  };
}

if (import.meta.main) {
  try {
    const report = await auditLanguageStatus();
    const output = process.argv
      .slice(2)
      .find((arg) => arg.startsWith("--write="))
      ?.slice(8);
    if (output) {
      const path = resolve(output);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, JSON.stringify(report, null, 2));
    }
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
