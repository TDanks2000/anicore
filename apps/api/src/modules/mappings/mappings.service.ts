import { db } from "@anicore/db";
import type { MappingSource, Provider } from "@anicore/db/enums";
import { anime, animeMappings, episodeMappings, episodes } from "@anicore/db/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors";
import type { DbTransaction } from "../../lib/query-rows";
import { optionalText } from "../../lib/validators";
import { formatAnime } from "../anime/anime.format";

type Executor = typeof db | DbTransaction;

interface MappingIdentity {
  provider: Provider;
  providerId: string;
}

export interface AnimeMappingInput extends MappingIdentity {
  providerSlug?: string | null;
  providerUrl?: string | null;
  confidence?: number;
  source?: MappingSource;
  isPrimary?: boolean;
}

export interface EpisodeMappingInput extends MappingIdentity {
  providerSlug?: string | null;
  providerUrl?: string | null;
  providerEpisodeNumber?: string | null;
  confidence?: number;
  source?: MappingSource;
}

export interface AnimeMappingPatch {
  providerSlug?: string;
  providerUrl?: string;
  confidence?: number;
  source?: MappingSource;
  isPrimary?: boolean;
}

export interface EpisodeMappingPatch {
  providerSlug?: string;
  providerUrl?: string;
  providerEpisodeNumber?: string;
  confidence?: number;
  source?: MappingSource;
}

const MAPPING_CONFLICT = "Mapping already exists or belongs to another record";

/** Provider IDs are compared after trimming, so " 1 " and "1" are one identity. */
export function canonicalProviderId(value: string): string {
  const providerId = value.trim();
  if (!providerId) throw badRequest("Mapping providerId cannot be blank");
  return providerId;
}

/** Maps a unique-constraint failure onto a 409 with a meaningful message. */
async function uniqueOrConflict<T>(operation: Promise<T>, message = MAPPING_CONFLICT): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(message);
    throw error;
  }
}

/** Only fields the caller sent are changed; blank strings clear a text field. */
function patchText(value: string | undefined): string | null | undefined {
  return value === undefined ? undefined : optionalText(value);
}

function assertUniqueIdentities(mappings: readonly MappingIdentity[]): void {
  const seen = new Set<string>();
  for (const mapping of mappings) {
    const key = `${mapping.provider}\u0000${mapping.providerId}`;
    if (seen.has(key)) {
      throw badRequest(`Duplicate ${mapping.provider} mapping ${mapping.providerId} in request`);
    }
    seen.add(key);
  }
}

/**
 * Canonicalizes the mappings sent with a new anime and settles which one is
 * primary for each provider. A provider's only mapping is primary unless the
 * caller says otherwise; several need exactly one marked primary, because
 * single-mapping reads must be deterministic.
 */
export function prepareNewAnimeMappings(
  mappings: readonly AnimeMappingInput[],
): Array<AnimeMappingInput & { isPrimary: boolean }> {
  const prepared = mappings.map((mapping) => ({
    ...mapping,
    providerId: canonicalProviderId(mapping.providerId),
  }));
  assertUniqueIdentities(prepared);

  const countByProvider = new Map<Provider, number>();
  const primariesByProvider = new Map<Provider, number>();
  for (const mapping of prepared) {
    countByProvider.set(mapping.provider, (countByProvider.get(mapping.provider) ?? 0) + 1);
    if (mapping.isPrimary === true) {
      primariesByProvider.set(
        mapping.provider,
        (primariesByProvider.get(mapping.provider) ?? 0) + 1,
      );
    }
  }

  for (const [provider, count] of countByProvider) {
    const primaries = primariesByProvider.get(provider) ?? 0;
    if (count > 1 && primaries !== 1) {
      throw badRequest(`Multiple ${provider} mappings require exactly one primary mapping`);
    }
  }

  return prepared.map((mapping) => ({
    ...mapping,
    isPrimary: mapping.isPrimary ?? countByProvider.get(mapping.provider) === 1,
  }));
}

export function prepareNewEpisodeMappings(
  mappings: readonly EpisodeMappingInput[],
): EpisodeMappingInput[] {
  const prepared = mappings.map((mapping) => ({
    ...mapping,
    providerId: canonicalProviderId(mapping.providerId),
  }));
  assertUniqueIdentities(prepared);
  return prepared;
}

function animeMappingValues(animeId: number, mapping: AnimeMappingInput & { isPrimary: boolean }) {
  return {
    animeId,
    provider: mapping.provider,
    providerId: mapping.providerId,
    providerSlug: optionalText(mapping.providerSlug),
    providerUrl: optionalText(mapping.providerUrl),
    confidence: mapping.confidence ?? 100,
    source: mapping.source ?? "manual",
    isPrimary: mapping.isPrimary,
  };
}

function episodeMappingValues(episodeId: number, mapping: EpisodeMappingInput) {
  return {
    episodeId,
    provider: mapping.provider,
    providerId: mapping.providerId,
    providerSlug: optionalText(mapping.providerSlug),
    providerUrl: optionalText(mapping.providerUrl),
    providerEpisodeNumber: optionalText(mapping.providerEpisodeNumber),
    confidence: mapping.confidence ?? 100,
    source: mapping.source ?? "manual",
  };
}

export async function insertAnimeMappings(
  tx: Executor,
  animeId: number,
  mappings: ReturnType<typeof prepareNewAnimeMappings>,
): Promise<void> {
  if (mappings.length === 0) return;
  await uniqueOrConflict(
    tx
      .insert(animeMappings)
      .values(mappings.map((mapping) => animeMappingValues(animeId, mapping))),
  );
}

/**
 * Episode mappings for a provider only make sense once the anime itself is
 * mapped to that provider; otherwise nothing ties the episode IDs to a season.
 */
async function assertAnimeMappedToProviders(
  tx: Executor,
  animeId: number,
  providers: Iterable<Provider>,
): Promise<void> {
  const wanted = [...new Set(providers)];
  if (wanted.length === 0) return;

  const rows = await tx
    .selectDistinct({ provider: animeMappings.provider })
    .from(animeMappings)
    .where(and(eq(animeMappings.animeId, animeId), inArray(animeMappings.provider, wanted)));
  const mapped = new Set(rows.map((row) => row.provider));

  const missing = wanted.find((provider) => !mapped.has(provider));
  if (missing) {
    throw conflict(
      `Create an anime-level ${missing} mapping before adding ${missing} episode mappings`,
    );
  }
}

export async function insertEpisodeMappings(
  tx: Executor,
  episode: { id: number; animeId: number },
  mappings: readonly EpisodeMappingInput[],
): Promise<void> {
  if (mappings.length === 0) return;
  await assertAnimeMappedToProviders(
    tx,
    episode.animeId,
    mappings.map((mapping) => mapping.provider),
  );
  await uniqueOrConflict(
    tx.insert(episodeMappings).values(mappings.map((m) => episodeMappingValues(episode.id, m))),
  );
}

// ── Anime mappings ────────────────────────────────────────────────────────────

export async function listAnimeMappings(animeId: number) {
  return db
    .select()
    .from(animeMappings)
    .where(eq(animeMappings.animeId, animeId))
    .orderBy(asc(animeMappings.provider), desc(animeMappings.isPrimary), asc(animeMappings.id));
}

export async function findAnimeByMapping(identity: MappingIdentity) {
  const [row] = await db
    .select({ mapping: animeMappings, anime })
    .from(animeMappings)
    .innerJoin(anime, eq(animeMappings.animeId, anime.id))
    .where(
      and(
        eq(animeMappings.provider, identity.provider),
        eq(animeMappings.providerId, identity.providerId.trim()),
      ),
    )
    .limit(1);
  return row ? { mapping: row.mapping, anime: formatAnime(row.anime) } : null;
}

async function lockAnimeMapping(tx: DbTransaction, identity: MappingIdentity) {
  const [mapping] = await tx
    .select()
    .from(animeMappings)
    .where(
      and(
        eq(animeMappings.provider, identity.provider),
        eq(animeMappings.providerId, canonicalProviderId(identity.providerId)),
      ),
    )
    .limit(1)
    .for("update");
  if (!mapping) throw notFound("Anime mapping not found");
  return mapping;
}

async function countProviderMappings(tx: DbTransaction, animeId: number, provider: Provider) {
  const rows = await tx
    .select({ id: animeMappings.id, isPrimary: animeMappings.isPrimary })
    .from(animeMappings)
    .where(and(eq(animeMappings.animeId, animeId), eq(animeMappings.provider, provider)))
    .for("update");
  return { total: rows.length, hasPrimary: rows.some((row) => row.isPrimary) };
}

async function demoteProviderPrimaries(tx: DbTransaction, animeId: number, provider: Provider) {
  await tx
    .update(animeMappings)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(
      and(
        eq(animeMappings.animeId, animeId),
        eq(animeMappings.provider, provider),
        eq(animeMappings.isPrimary, true),
      ),
    );
}

export async function createAnimeMapping(input: AnimeMappingInput & { animeId: number }) {
  const providerId = canonicalProviderId(input.providerId);

  return db.transaction(async (tx) => {
    const [parent] = await tx
      .select({ id: anime.id })
      .from(anime)
      .where(eq(anime.id, input.animeId))
      .for("update");
    if (!parent) throw notFound("Anime not found");

    const existing = await countProviderMappings(tx, input.animeId, input.provider);
    const isPrimary = input.isPrimary ?? existing.total === 0;

    if (isPrimary) {
      await demoteProviderPrimaries(tx, input.animeId, input.provider);
    } else if (existing.total > 0 && !existing.hasPrimary) {
      throw conflict(
        "Adding another mapping for this provider would be ambiguous; mark one mapping as primary",
      );
    }

    const [created] = await uniqueOrConflict(
      tx
        .insert(animeMappings)
        .values(animeMappingValues(input.animeId, { ...input, providerId, isPrimary }))
        .returning(),
    );
    return created!;
  });
}

export async function updateAnimeMapping(identity: MappingIdentity, patch: AnimeMappingPatch) {
  return db.transaction(async (tx) => {
    const mapping = await lockAnimeMapping(tx, identity);

    if (patch.isPrimary === true && !mapping.isPrimary) {
      await demoteProviderPrimaries(tx, mapping.animeId, mapping.provider);
    } else if (patch.isPrimary === false && mapping.isPrimary) {
      const { total } = await countProviderMappings(tx, mapping.animeId, mapping.provider);
      if (total > 1) {
        throw conflict("Promote another mapping before clearing the primary mapping");
      }
    }

    const [updated] = await tx
      .update(animeMappings)
      .set({
        providerSlug: patchText(patch.providerSlug),
        providerUrl: patchText(patch.providerUrl),
        confidence: patch.confidence,
        source: patch.source,
        isPrimary: patch.isPrimary,
        updatedAt: new Date(),
      })
      .where(eq(animeMappings.id, mapping.id))
      .returning();
    return updated!;
  });
}

export async function deleteAnimeMapping(identity: MappingIdentity) {
  return db.transaction(async (tx) => {
    const mapping = await lockAnimeMapping(tx, identity);

    const [episodeDependency] = await tx
      .select({ id: episodeMappings.id })
      .from(episodeMappings)
      .innerJoin(episodes, eq(episodeMappings.episodeId, episodes.id))
      .where(
        and(eq(episodes.animeId, mapping.animeId), eq(episodeMappings.provider, mapping.provider)),
      )
      .limit(1);
    if (episodeDependency) {
      throw conflict(
        "Cannot delete anime mapping while episode mappings for this provider still exist",
      );
    }

    if (mapping.isPrimary) {
      const { total } = await countProviderMappings(tx, mapping.animeId, mapping.provider);
      if (total > 1) {
        throw conflict("Promote another mapping before deleting the primary mapping");
      }
    }

    await tx.delete(animeMappings).where(eq(animeMappings.id, mapping.id));
    return { deleted: true as const, id: mapping.id };
  });
}

// ── Episode mappings ──────────────────────────────────────────────────────────

export async function listEpisodeMappings(episodeId: number) {
  return db
    .select()
    .from(episodeMappings)
    .where(eq(episodeMappings.episodeId, episodeId))
    .orderBy(asc(episodeMappings.provider), asc(episodeMappings.id));
}

export async function findEpisodeByMapping(identity: MappingIdentity) {
  const [row] = await db
    .select({ mapping: episodeMappings, episode: episodes })
    .from(episodeMappings)
    .innerJoin(episodes, eq(episodeMappings.episodeId, episodes.id))
    .where(
      and(
        eq(episodeMappings.provider, identity.provider),
        eq(episodeMappings.providerId, identity.providerId.trim()),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function createEpisodeMapping(input: EpisodeMappingInput & { episodeId: number }) {
  const [mapping] = prepareNewEpisodeMappings([input]);

  return db.transaction(async (tx) => {
    const [episode] = await tx
      .select({ id: episodes.id, animeId: episodes.animeId })
      .from(episodes)
      .where(eq(episodes.id, input.episodeId))
      .limit(1);
    if (!episode) throw notFound("Episode not found");

    await assertAnimeMappedToProviders(tx, episode.animeId, [mapping!.provider]);
    const [created] = await uniqueOrConflict(
      tx.insert(episodeMappings).values(episodeMappingValues(episode.id, mapping!)).returning(),
    );
    return created!;
  });
}

export async function updateEpisodeMapping(identity: MappingIdentity, patch: EpisodeMappingPatch) {
  const [updated] = await db
    .update(episodeMappings)
    .set({
      providerSlug: patchText(patch.providerSlug),
      providerUrl: patchText(patch.providerUrl),
      providerEpisodeNumber: patchText(patch.providerEpisodeNumber),
      confidence: patch.confidence,
      source: patch.source,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(episodeMappings.provider, identity.provider),
        eq(episodeMappings.providerId, canonicalProviderId(identity.providerId)),
      ),
    )
    .returning();
  if (!updated) throw notFound("Episode mapping not found");
  return updated;
}

export async function deleteEpisodeMapping(identity: MappingIdentity) {
  const [deleted] = await db
    .delete(episodeMappings)
    .where(
      and(
        eq(episodeMappings.provider, identity.provider),
        eq(episodeMappings.providerId, canonicalProviderId(identity.providerId)),
      ),
    )
    .returning({ id: episodeMappings.id });
  if (!deleted) throw notFound("Episode mapping not found");
  return { deleted: true as const, id: deleted.id };
}
