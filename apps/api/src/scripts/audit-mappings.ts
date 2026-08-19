import { sql, type SQL } from "drizzle-orm";

import { closeDb, db } from "@anicore/db";

type Severity = "error" | "warning" | "info";

interface MappingAuditFinding {
  code: string;
  severity: Severity;
  description: string;
  count: number;
  samples: Record<string, unknown>[];
}

interface MappingAuditReport {
  ok: boolean;
  generatedAt: string;
  findings: MappingAuditFinding[];
  summary: Record<Severity, number>;
}

async function queryRows<T extends Record<string, unknown>>(
  query: SQL,
): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as T[];
}

async function countRows(query: SQL): Promise<number> {
  const [row] = await queryRows<{ count: number }>(query);
  return Number(row?.count ?? 0);
}

async function addFinding(
  findings: MappingAuditFinding[],
  input: {
    code: string;
    severity: Severity;
    description: string;
    countQuery: SQL;
    sampleQuery: SQL;
  },
): Promise<void> {
  const count = await countRows(input.countQuery);
  if (count === 0) return;

  findings.push({
    code: input.code,
    severity: input.severity,
    description: input.description,
    count,
    samples: await queryRows(input.sampleQuery),
  });
}

async function auditMappings(): Promise<MappingAuditReport> {
  const findings: MappingAuditFinding[] = [];

  await addFinding(findings, {
    code: "anime-provider-id-not-canonical",
    severity: "error",
    description:
      "Anime mappings contain blank or leading/trailing-whitespace provider IDs. Exact provider lookups can miss these rows.",
    countQuery: sql`
      select count(*)::int as count
      from anime_mappings
      where btrim(provider_id) = '' or provider_id <> btrim(provider_id)
    `,
    sampleQuery: sql`
      select id, anime_id as "animeId", provider, provider_id as "providerId"
      from anime_mappings
      where btrim(provider_id) = '' or provider_id <> btrim(provider_id)
      order by id
      limit 20
    `,
  });

  await addFinding(findings, {
    code: "episode-provider-id-not-canonical",
    severity: "error",
    description:
      "Episode mappings contain blank or leading/trailing-whitespace provider IDs.",
    countQuery: sql`
      select count(*)::int as count
      from episode_mappings
      where btrim(provider_id) = '' or provider_id <> btrim(provider_id)
    `,
    sampleQuery: sql`
      select id, episode_id as "episodeId", provider, provider_id as "providerId"
      from episode_mappings
      where btrim(provider_id) = '' or provider_id <> btrim(provider_id)
      order by id
      limit 20
    `,
  });

  await addFinding(findings, {
    code: "multiple-primary-anime-mappings",
    severity: "error",
    description:
      "More than one mapping is marked primary for the same anime/provider pair.",
    countQuery: sql`
      select count(*)::int as count
      from (
        select anime_id, provider
        from anime_mappings
        where is_primary = true
        group by anime_id, provider
        having count(*) > 1
      ) groups
    `,
    sampleQuery: sql`
      select anime_id as "animeId", provider, count(*)::int as "primaryCount",
        array_agg(provider_id order by id) as "providerIds"
      from anime_mappings
      where is_primary = true
      group by anime_id, provider
      having count(*) > 1
      order by anime_id, provider
      limit 20
    `,
  });

  await addFinding(findings, {
    code: "ambiguous-multi-mapping-provider",
    severity: "error",
    description:
      "An anime has multiple IDs for one provider but does not have exactly one primary mapping, making limit(1) consumers nondeterministic.",
    countQuery: sql`
      select count(*)::int as count
      from (
        select anime_id, provider
        from anime_mappings
        group by anime_id, provider
        having count(*) > 1
          and count(*) filter (where is_primary = true) <> 1
      ) groups
    `,
    sampleQuery: sql`
      select anime_id as "animeId", provider,
        count(*)::int as "mappingCount",
        count(*) filter (where is_primary = true)::int as "primaryCount",
        array_agg(provider_id order by id) as "providerIds"
      from anime_mappings
      group by anime_id, provider
      having count(*) > 1
        and count(*) filter (where is_primary = true) <> 1
      order by anime_id, provider
      limit 20
    `,
  });

  await addFinding(findings, {
    code: "episode-mapping-without-anime-provider",
    severity: "error",
    description:
      "Episode mappings exist without either a legacy anime-level mapping for the provider or an explicit v2 segment that maps the stored provider episode number to the parent anime's local episode number.",
    countQuery: sql`
      select count(*)::int as count
      from episode_mappings em
      join episodes e on e.id = em.episode_id
      where not exists (
        select 1
        from anime_mappings am
        where am.anime_id = e.anime_id
          and am.provider = em.provider
      )
        and not exists (
          select 1
          from anime_provider_mappings apm
          join provider_entities pe
            on pe.id = apm.provider_entity_id
          join anime_provider_segments aps
            on aps.anime_provider_mapping_id = apm.id
          cross join lateral (
            select case
              when em.provider_episode_number ~ '^[1-9][0-9]*$'
                then em.provider_episode_number::int
              else null
            end as provider_episode_number
          ) parsed
          where apm.anime_id = e.anime_id
            and pe.provider = em.provider
            and parsed.provider_episode_number between
              aps.provider_episode_start and aps.provider_episode_end
            and e.number between aps.local_episode_start and aps.local_episode_end
            and e.number = aps.local_episode_start
              + (parsed.provider_episode_number - aps.provider_episode_start)
        )
    `,
    sampleQuery: sql`
      select em.id, e.anime_id as "animeId", em.episode_id as "episodeId",
        em.provider, em.provider_id as "providerId",
        em.provider_episode_number as "providerEpisodeNumber"
      from episode_mappings em
      join episodes e on e.id = em.episode_id
      where not exists (
        select 1
        from anime_mappings am
        where am.anime_id = e.anime_id
          and am.provider = em.provider
      )
        and not exists (
          select 1
          from anime_provider_mappings apm
          join provider_entities pe
            on pe.id = apm.provider_entity_id
          join anime_provider_segments aps
            on aps.anime_provider_mapping_id = apm.id
          cross join lateral (
            select case
              when em.provider_episode_number ~ '^[1-9][0-9]*$'
                then em.provider_episode_number::int
              else null
            end as provider_episode_number
          ) parsed
          where apm.anime_id = e.anime_id
            and pe.provider = em.provider
            and parsed.provider_episode_number between
              aps.provider_episode_start and aps.provider_episode_end
            and e.number between aps.local_episode_start and aps.local_episode_end
            and e.number = aps.local_episode_start
              + (parsed.provider_episode_number - aps.provider_episode_start)
        )
      order by em.id
      limit 20
    `,
  });

  await addFinding(findings, {
    code: "mapping-confidence-out-of-range",
    severity: "error",
    description: "Mapping confidence values must stay between 0 and 100.",
    countQuery: sql`
      select (
        (select count(*) from anime_mappings where confidence < 0 or confidence > 100) +
        (select count(*) from episode_mappings where confidence < 0 or confidence > 100)
      )::int as count
    `,
    sampleQuery: sql`
      select * from (
        select 'anime' as kind, id, anime_id as "parentId", provider,
          provider_id as "providerId", confidence
        from anime_mappings
        where confidence < 0 or confidence > 100
        union all
        select 'episode' as kind, id, episode_id as "parentId", provider,
          provider_id as "providerId", confidence
        from episode_mappings
        where confidence < 0 or confidence > 100
      ) invalid
      order by kind, id
      limit 20
    `,
  });

  await addFinding(findings, {
    code: "overconfident-fuzzy-mapping",
    severity: "warning",
    description:
      "A fuzzy mapping is stored at 100% confidence. Fuzzy provenance should remain distinguishable from an authoritative cross-reference.",
    countQuery: sql`
      select (
        (select count(*) from anime_mappings where source = 'fuzzy' and confidence >= 100) +
        (select count(*) from episode_mappings where source = 'fuzzy' and confidence >= 100)
      )::int as count
    `,
    sampleQuery: sql`
      select * from (
        select 'anime' as kind, id, anime_id as "parentId", provider,
          provider_id as "providerId", confidence, source
        from anime_mappings
        where source = 'fuzzy' and confidence >= 100
        union all
        select 'episode' as kind, id, episode_id as "parentId", provider,
          provider_id as "providerId", confidence, source
        from episode_mappings
        where source = 'fuzzy' and confidence >= 100
      ) suspicious
      order by kind, id
      limit 20
    `,
  });

  await addFinding(findings, {
    code: "kitsu-episode-provenance-stronger-than-parent",
    severity: "error",
    description:
      "Kitsu episode mappings are stronger than the fuzzy Kitsu anime mapping that established the series identity.",
    countQuery: sql`
      select count(*)::int as count
      from episode_mappings em
      join episodes e on e.id = em.episode_id
      join anime_mappings am
        on am.anime_id = e.anime_id
        and am.provider = 'kitsu'
      where em.provider = 'kitsu'
        and am.source = 'fuzzy'
        and (em.source <> 'fuzzy' or em.confidence > am.confidence)
    `,
    sampleQuery: sql`
      select em.id as "episodeMappingId", e.anime_id as "animeId",
        em.provider_id as "episodeProviderId", em.source as "episodeSource",
        em.confidence as "episodeConfidence", am.provider_id as "animeProviderId",
        am.source as "animeSource", am.confidence as "animeConfidence"
      from episode_mappings em
      join episodes e on e.id = em.episode_id
      join anime_mappings am
        on am.anime_id = e.anime_id
        and am.provider = 'kitsu'
      where em.provider = 'kitsu'
        and am.source = 'fuzzy'
        and (em.source <> 'fuzzy' or em.confidence > am.confidence)
      order by em.id
      limit 20
    `,
  });

  await addFinding(findings, {
    code: "malformed-season-provider-id",
    severity: "warning",
    description:
      "TVDB/TMDB anime mappings do not use AniCore's expected <series-id>:<season-number> format and cannot be reused by episode enrichment.",
    countQuery: sql`
      select count(*)::int as count
      from anime_mappings
      where provider in ('thetvdb', 'tmdb')
        and provider_id !~ '^[1-9][0-9]*:[1-9][0-9]*$'
    `,
    sampleQuery: sql`
      select id, anime_id as "animeId", provider, provider_id as "providerId",
        source, confidence, is_primary as "isPrimary"
      from anime_mappings
      where provider in ('thetvdb', 'tmdb')
        and provider_id !~ '^[1-9][0-9]*:[1-9][0-9]*$'
      order by id
      limit 20
    `,
  });

  await addFinding(findings, {
    code: "legacy-heuristic-source-labelled-api",
    severity: "warning",
    description:
      "TVDB/TMDB mappings at the legacy 85% API signature may have been discovered heuristically before provenance hardening and should be revalidated.",
    countQuery: sql`
      select count(*)::int as count
      from anime_mappings
      where provider in ('thetvdb', 'tmdb')
        and source = 'api'
        and confidence = 85
    `,
    sampleQuery: sql`
      select id, anime_id as "animeId", provider, provider_id as "providerId",
        source, confidence, is_primary as "isPrimary"
      from anime_mappings
      where provider in ('thetvdb', 'tmdb')
        and source = 'api'
        and confidence = 85
      order by id
      limit 20
    `,
  });

  const summary: Record<Severity, number> = {
    error: findings.filter((finding) => finding.severity === "error").length,
    warning: findings.filter((finding) => finding.severity === "warning").length,
    info: findings.filter((finding) => finding.severity === "info").length,
  };

  return {
    ok: summary.error === 0,
    generatedAt: new Date().toISOString(),
    findings,
    summary,
  };
}

try {
  const report = await auditMappings();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
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
