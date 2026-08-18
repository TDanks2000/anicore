import { sql, type SQL } from "drizzle-orm";

import { closeDb, db } from "@anicore/db";

import {
  analyzeCollisionCoverageGroup,
  type CoverageDiagnosticRow,
  type CoverageGapPosition,
  type CoverageProvider,
  type CoverageGroupDiagnostic,
} from "./provider-collision-coverage-diagnostics";

type Stat = { groups: number; episodeMappings: number };

interface DiagnosticSample {
  animeId: number;
  provider: CoverageProvider;
  expectedLocalEpisodeCount: number | null;
  mappedEpisodeCount: number;
  missingLocalEpisodeCount: number;
  missingLocalEpisodeNumbers: number[];
  localRange: string | null;
  providerRange: string | null;
  offset: number | null;
  gapPosition: CoverageGapPosition;
}

async function queryRows<T extends Record<string, unknown>>(
  query: SQL,
): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as T[];
}

async function loadRows(): Promise<CoverageDiagnosticRow[]> {
  return queryRows<CoverageDiagnosticRow>(sql`
    select
      em.id as "episodeMappingId",
      e.anime_id as "animeId",
      em.provider,
      e.number as "localEpisodeNumber",
      (
        select count(*)::int
        from public.episodes local_episode
        where local_episode.anime_id = e.anime_id
          and local_episode.kind = 'normal'
      ) as "localNormalEpisodeCount",
      em.provider_episode_number as "providerEpisodeNumber"
    from public.episode_mappings em
    join public.episodes e on e.id = em.episode_id
    where em.provider in ('thetvdb', 'tmdb')
      and e.kind = 'normal'
      and not exists (
        select 1
        from public.anime_mappings am
        where am.anime_id = e.anime_id
          and am.provider = em.provider
      )
    order by e.anime_id, em.provider, e.number, em.id
  `);
}

function groupKey(row: CoverageDiagnosticRow): string {
  return `${row.animeId}\u0000${row.provider}`;
}

function addStat(stat: Stat, episodeMappings: number): void {
  stat.groups += 1;
  stat.episodeMappings += episodeMappings;
}

function emptyStat(): Stat {
  return { groups: 0, episodeMappings: 0 };
}

function sample(diagnostic: CoverageGroupDiagnostic): DiagnosticSample {
  return {
    animeId: diagnostic.animeId,
    provider: diagnostic.provider,
    expectedLocalEpisodeCount: diagnostic.expectedLocalEpisodeCount,
    mappedEpisodeCount: diagnostic.mappedEpisodeCount,
    missingLocalEpisodeCount: diagnostic.missingLocalEpisodeCount,
    missingLocalEpisodeNumbers: diagnostic.missingLocalEpisodeNumbers.slice(0, 20),
    localRange:
      diagnostic.localEpisodeStart !== null && diagnostic.localEpisodeEnd !== null
        ? `${diagnostic.localEpisodeStart}-${diagnostic.localEpisodeEnd}`
        : null,
    providerRange:
      diagnostic.providerEpisodeStart !== null &&
      diagnostic.providerEpisodeEnd !== null
        ? `${diagnostic.providerEpisodeStart}-${diagnostic.providerEpisodeEnd}`
        : null,
    offset: diagnostic.offset,
    gapPosition: diagnostic.gapPosition,
  };
}

async function run() {
  const rows = await loadRows();
  const grouped = new Map<string, CoverageDiagnosticRow[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }

  const diagnostics = [...grouped.values()].map(analyzeCollisionCoverageGroup);

  const completeCoverage = emptyStat();
  const partialCoverage = emptyStat();
  const evidenceBackedLinear = emptyStat();
  const partialEvidenceBackedLinear = emptyStat();
  const partialLinearNonZeroOffset = emptyStat();
  const partialLinearZeroOffset = emptyStat();
  const nonlinearOrInvalid = emptyStat();

  const byGapPosition: Record<CoverageGapPosition, Stat> = {
    complete: emptyStat(),
    trailing: emptyStat(),
    leading: emptyStat(),
    "both-ends": emptyStat(),
    "internal-or-nonlinear": emptyStat(),
  };
  const byProvider: Record<CoverageProvider, {
    total: Stat;
    partial: Stat;
    partialLinear: Stat;
    partialLinearNonZeroOffset: Stat;
  }> = {
    thetvdb: {
      total: emptyStat(),
      partial: emptyStat(),
      partialLinear: emptyStat(),
      partialLinearNonZeroOffset: emptyStat(),
    },
    tmdb: {
      total: emptyStat(),
      partial: emptyStat(),
      partialLinear: emptyStat(),
      partialLinearNonZeroOffset: emptyStat(),
    },
  };

  const offsetDistribution = new Map<number, Stat>();
  const invalidReasons = new Map<string, Stat>();

  for (const diagnostic of diagnostics) {
    const count = diagnostic.mappedEpisodeCount;
    addStat(byProvider[diagnostic.provider].total, count);
    addStat(byGapPosition[diagnostic.gapPosition], count);

    if (diagnostic.completeCoverage) addStat(completeCoverage, count);
    else {
      addStat(partialCoverage, count);
      addStat(byProvider[diagnostic.provider].partial, count);
    }

    if (diagnostic.evidenceBackedLinear) {
      addStat(evidenceBackedLinear, count);
      if (!diagnostic.completeCoverage) {
        addStat(partialEvidenceBackedLinear, count);
        addStat(byProvider[diagnostic.provider].partialLinear, count);
        if (diagnostic.offset === 0) {
          addStat(partialLinearZeroOffset, count);
        } else {
          addStat(partialLinearNonZeroOffset, count);
          addStat(
            byProvider[diagnostic.provider].partialLinearNonZeroOffset,
            count,
          );
        }
      }
      if (diagnostic.offset !== null) {
        const stat = offsetDistribution.get(diagnostic.offset) ?? emptyStat();
        addStat(stat, count);
        offsetDistribution.set(diagnostic.offset, stat);
      }
    } else {
      addStat(nonlinearOrInvalid, count);
    }

    if (diagnostic.invalidReason) {
      const stat = invalidReasons.get(diagnostic.invalidReason) ?? emptyStat();
      addStat(stat, count);
      invalidReasons.set(diagnostic.invalidReason, stat);
    }
  }

  const partialLinearSamples = diagnostics
    .filter(
      (diagnostic) =>
        !diagnostic.completeCoverage && diagnostic.evidenceBackedLinear,
    )
    .sort(
      (a, b) =>
        Number(b.offset !== 0) - Number(a.offset !== 0) ||
        b.mappedEpisodeCount - a.mappedEpisodeCount ||
        a.provider.localeCompare(b.provider) ||
        a.animeId - b.animeId,
    )
    .slice(0, 40)
    .map(sample);

  return {
    ok: true,
    mode: "dry-run" as const,
    generatedAt: new Date().toISOString(),
    operation: {
      code: "diagnose-provider-collision-coverage",
      description:
        "Explain why orphan TVDB/TMDB groups fail full-local-coverage planning, and measure whether the mappings that do exist still form contiguous constant-offset evidence-backed runs. This command never writes data.",
      totalGroups: diagnostics.length,
      totalEpisodeMappings: rows.length,
      completeCoverage,
      partialCoverage,
      evidenceBackedLinear,
      partialEvidenceBackedLinear,
      partialLinearZeroOffset,
      partialLinearNonZeroOffset,
      nonlinearOrInvalid,
      byGapPosition,
      byProvider,
      offsetDistribution: Object.fromEntries(
        [...offsetDistribution.entries()]
          .sort(([a], [b]) => a - b)
          .map(([offset, stat]) => [String(offset), stat]),
      ),
      invalidReasons: Object.fromEntries(
        [...invalidReasons.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      partialLinearSamples,
    },
  };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length > 0) {
      throw new Error(
        `This command is diagnostic-only and accepts no arguments; received: ${args.join(" ")}`,
      );
    }
    console.log(JSON.stringify(await run(), null, 2));
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          mode: "dry-run",
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    await closeDb().catch(() => undefined);
  }
}
