import { and, eq } from "drizzle-orm";

import { db } from "@anicore/db";
import {
  animeMappings,
  episodes,
  type AnimeMapping,
} from "@anicore/db/schema";
import {
  assertUnambiguousAnimeMappingPrimaries,
  assertUniqueMappingIdentities,
  canonicalProviderId,
  MappingInputError,
  optionalMappingText,
} from "./mapping-invariants";

type Provider = AnimeMapping["provider"];

type MutableMappingInput = {
  provider: Provider;
  providerId: string;
  providerSlug?: string | null;
  providerUrl?: string | null;
  providerEpisodeNumber?: string | null;
  isPrimary?: boolean;
};

type MappingBody = Record<string, unknown> & {
  animeId?: number;
  episodeId?: number;
  provider?: Provider;
  providerId?: string;
  providerSlug?: string | null;
  providerUrl?: string | null;
  providerEpisodeNumber?: string | null;
  mappings?: MutableMappingInput[];
};

export type MappingWriteInvariantResult =
  | { ok: true }
  | { ok: false; status: 400 | 409; error: string };

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function asMappingBody(body: unknown): MappingBody | null {
  return body && typeof body === "object" ? (body as MappingBody) : null;
}

function normalizeMapping(mapping: MutableMappingInput): void {
  mapping.providerId = canonicalProviderId(mapping.providerId);
  mapping.providerSlug = optionalMappingText(mapping.providerSlug ?? undefined);
  mapping.providerUrl = optionalMappingText(mapping.providerUrl ?? undefined);
  if ("providerEpisodeNumber" in mapping) {
    mapping.providerEpisodeNumber = optionalMappingText(
      mapping.providerEpisodeNumber ?? undefined,
    );
  }
}

async function animeHasProviderMapping(
  animeId: number,
  provider: Provider,
): Promise<boolean> {
  const [row] = await db
    .select({ id: animeMappings.id })
    .from(animeMappings)
    .where(
      and(
        eq(animeMappings.animeId, animeId),
        eq(animeMappings.provider, provider),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function requireAnimeProviderMappings(
  animeId: number,
  providers: Iterable<Provider>,
): Promise<MappingWriteInvariantResult> {
  for (const provider of new Set(providers)) {
    if (await animeHasProviderMapping(animeId, provider)) continue;
    return {
      ok: false,
      status: 409,
      error: `Create an anime-level ${provider} mapping before adding ${provider} episode mappings`,
    };
  }
  return { ok: true };
}

export async function enforceMappingWriteInvariants(input: {
  method: string;
  pathname: string;
  body: unknown;
}): Promise<MappingWriteInvariantResult> {
  if (input.method.toUpperCase() !== "POST") return { ok: true };

  const pathname = normalizePath(input.pathname);
  const body = asMappingBody(input.body);
  if (!body) return { ok: true };

  try {
    if (pathname === "/anime" && body.mappings?.length) {
      assertUnambiguousAnimeMappingPrimaries(body.mappings);
      for (const mapping of body.mappings) normalizeMapping(mapping);
      return { ok: true };
    }

    if (pathname === "/episodes" && body.mappings?.length) {
      assertUniqueMappingIdentities(body.mappings);
      for (const mapping of body.mappings) normalizeMapping(mapping);

      if (!Number.isInteger(body.animeId) || (body.animeId ?? 0) <= 0) {
        return { ok: true };
      }
      return requireAnimeProviderMappings(
        body.animeId!,
        body.mappings.map((mapping) => mapping.provider),
      );
    }

    if (
      pathname === "/mappings/episode" &&
      typeof body.provider === "string" &&
      typeof body.providerId === "string" &&
      Number.isInteger(body.episodeId) &&
      (body.episodeId ?? 0) > 0
    ) {
      body.providerId = canonicalProviderId(body.providerId);
      body.providerSlug = optionalMappingText(body.providerSlug ?? undefined);
      body.providerUrl = optionalMappingText(body.providerUrl ?? undefined);
      body.providerEpisodeNumber = optionalMappingText(
        body.providerEpisodeNumber ?? undefined,
      );

      const [episode] = await db
        .select({ animeId: episodes.animeId })
        .from(episodes)
        .where(eq(episodes.id, body.episodeId!))
        .limit(1);
      if (!episode) return { ok: true };

      return requireAnimeProviderMappings(episode.animeId, [body.provider]);
    }
  } catch (error) {
    if (error instanceof MappingInputError) {
      return { ok: false, status: 400, error: error.message };
    }
    throw error;
  }

  return { ok: true };
}
