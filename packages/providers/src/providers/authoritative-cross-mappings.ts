import { and, eq, sql } from "drizzle-orm";

import { db } from "@anicore/db";
import { animeMappings } from "@anicore/db/schema";
import type { ProviderAuthoritativeMapping } from "./types";

export function normalizeAuthoritativeMappings(
  mappings: ProviderAuthoritativeMapping[],
): ProviderAuthoritativeMapping[] {
  const byIdentity = new Map<string, ProviderAuthoritativeMapping>();
  const providerIds = new Map<string, string>();

  for (const mapping of mappings) {
    const providerId = mapping.providerId.trim();
    if (!providerId) {
      throw new Error(`Authoritative ${mapping.provider} mapping has a blank provider ID`);
    }

    const existingId = providerIds.get(mapping.provider);
    if (existingId && existingId !== providerId) {
      throw new Error(
        `Authoritative payload contains multiple ${mapping.provider} identities (${existingId}, ${providerId})`,
      );
    }
    providerIds.set(mapping.provider, providerId);

    const key = `${mapping.provider}\u0000${providerId}`;
    byIdentity.set(key, {
      ...mapping,
      providerId,
      providerSlug: mapping.providerSlug?.trim() || null,
      providerUrl: mapping.providerUrl?.trim() || null,
    });
  }

  return [...byIdentity.values()];
}

export async function syncAuthoritativeCrossMappings(
  animeId: number,
  mappings: ProviderAuthoritativeMapping[],
): Promise<void> {
  const normalized = normalizeAuthoritativeMappings(mappings);
  if (!normalized.length) return;

  await db.transaction(async (tx) => {
    for (const mapping of normalized) {
      const existingForAnime = await tx
        .select({
          providerId: animeMappings.providerId,
          source: animeMappings.source,
          confidence: animeMappings.confidence,
        })
        .from(animeMappings)
        .where(
          and(
            eq(animeMappings.animeId, animeId),
            eq(animeMappings.provider, mapping.provider),
          ),
        );

      const conflicting = existingForAnime.filter(
        (existing) => existing.providerId !== mapping.providerId,
      );
      if (conflicting.length) {
        const identities = conflicting
          .map(
            (existing) =>
              `${existing.providerId} (${existing.source}/${existing.confidence})`,
          )
          .join(", ");
        throw new Error(
          `Authoritative ${mapping.provider} identity ${mapping.providerId} conflicts with existing mapping(s) on anime ${animeId}: ${identities}`,
        );
      }

      const [stored] = await tx
        .insert(animeMappings)
        .values({
          animeId,
          provider: mapping.provider,
          providerId: mapping.providerId,
          providerSlug: mapping.providerSlug ?? null,
          providerUrl: mapping.providerUrl ?? null,
          confidence: 100,
          source: "api",
          isPrimary: false,
        })
        .onConflictDoUpdate({
          target: [animeMappings.provider, animeMappings.providerId],
          set: {
            providerSlug: sql`coalesce(excluded.provider_slug, ${animeMappings.providerSlug})`,
            providerUrl: sql`coalesce(excluded.provider_url, ${animeMappings.providerUrl})`,
            confidence: sql`greatest(${animeMappings.confidence}, 100)`,
            source: sql`case
              when ${animeMappings.source} in ('manual', 'import', 'system')
                then ${animeMappings.source}
              else 'api'
            end`,
            isPrimary: animeMappings.isPrimary,
            updatedAt: sql`now()`,
          },
          setWhere: eq(animeMappings.animeId, animeId),
        })
        .returning({ animeId: animeMappings.animeId });

      if (!stored) {
        throw new Error(
          `Authoritative ${mapping.provider} mapping ${mapping.providerId} already belongs to another anime`,
        );
      }
    }
  });
}
