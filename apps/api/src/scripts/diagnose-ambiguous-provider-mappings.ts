import { closeDb } from "@anicore/db";

import type { AmbiguousMappingGroupDiagnosis } from "./ambiguous-provider-mapping-diagnosis";
import { AmbiguousMappingEvidenceSource } from "./ambiguous-provider-mapping-evidence";

async function run(): Promise<Record<string, unknown>> {
  const source = new AmbiguousMappingEvidenceSource({
    tvdbApiKey: process.env.TVDB_API_KEY?.trim(),
    tmdbApiKey: process.env.TMDB_API_KEY?.trim(),
  });

  const { groups, ambiguousMappings } = await source.diagnoseGroups();

  const byVerdict = new Map<string, number>();
  for (const group of groups) {
    byVerdict.set(group.verdict, (byVerdict.get(group.verdict) ?? 0) + 1);
  }
  const byClassification = new Map<string, number>();
  for (const group of groups) {
    for (const candidate of group.candidates) {
      byClassification.set(
        candidate.classification,
        (byClassification.get(candidate.classification) ?? 0) + 1,
      );
    }
  }
  const byRepairStatus = new Map<string, number>();
  const repairSafeGroups = groups.filter((group) => group.repairSafe);
  for (const group of groups) {
    for (const candidate of group.candidates) {
      byRepairStatus.set(
        candidate.repair.status,
        (byRepairStatus.get(candidate.repair.status) ?? 0) + 1,
      );
    }
  }

  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "diagnose-ambiguous-provider-mappings",
      description:
        "Compare every TVDB/TMDB anime mapping that collides with a sibling mapping for the same anime/provider against authoritative provider series+season metadata (series name, first aired dates, season and show episode counts) and AniList identity (titles, start date, episode count). Reports per-candidate classification plus a fail-closed repair eligibility layer: a candidate is only 'verified-keep' when a single provider scope (season or show, never mixed) exactly matches the anime start date and episode count with a strong title identity, and a sibling is only 'verified-retire' with positive contradictory evidence (title contradiction plus a substantially wrong first-air year or episode count). A group is repair-safe only when exactly one candidate is verified-keep and every sibling is verified-retire. This command never writes data.",
      ambiguousGroups: groups.length,
      ambiguousMappings,
      byVerdict: Object.fromEntries(
        [...byVerdict.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      byClassification: Object.fromEntries(
        [...byClassification.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      byRepairStatus: Object.fromEntries(
        [...byRepairStatus.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      repairSafeGroups: repairSafeGroups.length,
      repairSafeAnimeIds: repairSafeGroups.map((group: AmbiguousMappingGroupDiagnosis) => group.animeId),
      groups,
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