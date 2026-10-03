import { closeDb } from "@anicore/db";
import { sql } from "drizzle-orm";
import { queryRows } from "../lib/query-rows";
import { parseRepairMappingsArgs } from "./repair-mappings-cli";

/**
 * Elects a primary mapping for every (anime, provider) group that has several
 * mappings and no primary at all.
 *
 * Such a group makes any single-mapping read non-deterministic: the row a
 * consumer sees depends on plan order. Electing a primary does not decide which
 * mapping is factually correct — the duplicates stay reported by
 * `db:audit-mappings` — it only makes the choice stable and explicit.
 */

/** Provenance strength, strongest first. Mirrors how the syncs rank sources. */
const SOURCE_RANK = ["manual", "api", "system", "import", "fuzzy"] as const;

export interface AmbiguousMappingRow {
  id: number;
  animeId: number;
  provider: string;
  providerId: string;
  confidence: number;
  source: string;
}

export interface ElectedPrimary {
  animeId: number;
  provider: string;
  winner: AmbiguousMappingRow;
  losers: AmbiguousMappingRow[];
}

export function sourceRank(source: string): number {
  const index = SOURCE_RANK.indexOf(source as (typeof SOURCE_RANK)[number]);
  return index === -1 ? SOURCE_RANK.length : index;
}

/**
 * Deterministic election: strongest confidence, then strongest provenance, then
 * the oldest row. Every tiebreaker is total, so the same input always elects the
 * same winner and a dry run predicts the apply exactly.
 */
export function electPrimaries(rows: AmbiguousMappingRow[]): ElectedPrimary[] {
  const groups = new Map<string, AmbiguousMappingRow[]>();
  for (const row of rows) {
    const key = `${row.animeId} ${row.provider}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const elected: ElectedPrimary[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const ranked = [...group].sort(
      (a, b) =>
        b.confidence - a.confidence || sourceRank(a.source) - sourceRank(b.source) || a.id - b.id,
    );

    const [winner, ...losers] = ranked;
    if (!winner) continue;
    elected.push({
      animeId: winner.animeId,
      provider: winner.provider,
      winner,
      losers,
    });
  }

  return elected.sort((a, b) => a.animeId - b.animeId || a.provider.localeCompare(b.provider));
}

async function loadAmbiguousMappings(): Promise<AmbiguousMappingRow[]> {
  return queryRows<AmbiguousMappingRow>(sql`
    select m.id, m.anime_id as "animeId", m.provider,
           m.provider_id as "providerId", m.confidence, m.source
    from anime_mappings m
    join (
      select anime_id, provider
      from anime_mappings
      group by anime_id, provider
      having count(*) > 1 and sum(case when is_primary then 1 else 0 end) = 0
    ) ambiguous
      on ambiguous.anime_id = m.anime_id and ambiguous.provider = m.provider
    order by m.anime_id, m.provider, m.id
  `);
}

async function main(): Promise<void> {
  const { mode } = parseRepairMappingsArgs(process.argv.slice(2));

  try {
    const rows = await loadAmbiguousMappings();
    const elected = electPrimaries(rows);

    console.log(`Ambiguous (anime, provider) groups with no primary: ${elected.length}`);
    for (const group of elected) {
      const alternatives = group.losers
        .map((row) => `${row.providerId} (${row.source}/${row.confidence})`)
        .join(", ");
      console.log(
        `  anime ${group.animeId} ${group.provider}: elect ${group.winner.providerId} ` +
          `(${group.winner.source}/${group.winner.confidence}) over ${alternatives}`,
      );
    }

    if (mode === "dry-run") {
      console.log("\nDry run — no rows changed. Re-run with --apply to write.");
      return;
    }

    let updated = 0;
    for (const group of elected) {
      // Re-checks the condition the election assumed, so a concurrent writer
      // that already elected a primary is never overwritten.
      const result = await queryRows<{ id: number }>(sql`
        update anime_mappings
        set is_primary = true, updated_at = ${Date.now()}
        where id = ${group.winner.id}
          and not exists (
            select 1 from anime_mappings other
            where other.anime_id = ${group.animeId}
              and other.provider = ${group.provider}
              and other.is_primary
          )
        returning id
      `);
      updated += result.length;
    }

    console.log(`\nElected ${updated} primary mapping(s).`);
  } finally {
    await closeDb();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
