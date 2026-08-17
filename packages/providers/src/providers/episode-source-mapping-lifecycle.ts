import { and, eq } from "drizzle-orm";

import { db } from "@anicore/db";
import { animeMappings, episodeMappings, episodes } from "@anicore/db/schema";
import { log } from "../lib/logger";

type MappingSource = "manual" | "api" | "import" | "fuzzy" | "system";

export interface StoredEpisodeSourceMapping {
  id: number;
  providerId: string;
  confidence: number;
  source: MappingSource;
}

export function isRetirableAutomaticSourceMapping(
  mapping: Pick<StoredEpisodeSourceMapping, "source" | "confidence">,
): boolean {
  return (
    mapping.source === "fuzzy" ||
    (mapping.source === "api" && mapping.confidence <= 85)
  );
}

/**
 * Retire a stored TVDB/TMDB anime mapping only when doing so is provably safe.
 *
 * We never automatically replace strong/manual mappings, ambiguous provider
 * groups, or a mapping that already has episode-level dependencies. Episode
 * mappings are evidence that metadata may already have been written from that
 * source, and AniCore does not currently track field-level provenance well
 * enough to roll those writes back safely.
 */
export async function retireInvalidAutomaticSourceMapping(input: {
  animeId: number;
  provider: "thetvdb" | "tmdb";
  mapping: StoredEpisodeSourceMapping;
  reason: string;
}): Promise<void> {
  if (!isRetirableAutomaticSourceMapping(input.mapping)) {
    throw new Error(
      `Stored ${input.provider} mapping ${input.mapping.providerId} failed validation (${input.reason}); refusing to replace ${input.mapping.source}/${input.mapping.confidence} mapping automatically`,
    );
  }

  await db.transaction(async (tx) => {
    const providerMappings = await tx
      .select({ id: animeMappings.id })
      .from(animeMappings)
      .where(
        and(
          eq(animeMappings.animeId, input.animeId),
          eq(animeMappings.provider, input.provider),
        ),
      );

    if (
      providerMappings.length !== 1 ||
      providerMappings[0]?.id !== input.mapping.id
    ) {
      throw new Error(
        `Stored ${input.provider} mapping group is ambiguous; refusing automatic retirement`,
      );
    }

    const [episodeDependency] = await tx
      .select({ id: episodeMappings.id })
      .from(episodeMappings)
      .innerJoin(episodes, eq(episodeMappings.episodeId, episodes.id))
      .where(
        and(
          eq(episodes.animeId, input.animeId),
          eq(episodeMappings.provider, input.provider),
        ),
      )
      .limit(1);

    if (episodeDependency) {
      throw new Error(
        `Stored ${input.provider} mapping ${input.mapping.providerId} failed validation (${input.reason}) but already has episode mappings; refusing automatic replacement because field-level metadata provenance cannot be rolled back safely`,
      );
    }

    await tx
      .delete(animeMappings)
      .where(eq(animeMappings.id, input.mapping.id));
  });

  log.warn(
    `Retired invalid automatic ${input.provider} mapping ${input.mapping.providerId} for anime ${input.animeId}: ${input.reason}`,
  );
}
