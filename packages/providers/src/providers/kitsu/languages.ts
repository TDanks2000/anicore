import { db } from "@anicore/db";
import {
  type ProviderLanguageAssertion,
  replaceProviderLanguageSnapshot,
} from "@anicore/db/language-status";
import { normalizeLanguageCode } from "@anicore/db/language-status-scoring";
import { animeLanguageEvidence, animeMappings } from "@anicore/db/schema";
import { and, eq } from "drizzle-orm";
import { formatHttpError } from "../../lib/http";
import { waitForProvider } from "../../lib/provider-wait";

const SOURCE_PREFIX = "https://kitsu.io/api/edge/anime/";
export interface KitsuStreamingLink {
  id: string;
  type: "streamingLinks";
  attributes: { url: string; subs: string[]; dubs: string[] };
}

export function validateStreamingLinks(value: unknown): KitsuStreamingLink[] {
  if (!Array.isArray(value)) throw new Error("Invalid Kitsu streaming-link payload");
  return value.map((link: KitsuStreamingLink) => {
    if (
      !link ||
      typeof link.id !== "string" ||
      !/^[1-9]\d*$/.test(link.id) ||
      link.type !== "streamingLinks" ||
      typeof link.attributes?.url !== "string"
    )
      throw new Error("Invalid Kitsu streaming-link identity");
    for (const medium of ["subs", "dubs"] as const)
      if (
        link.attributes[medium] != null &&
        (!Array.isArray(link.attributes[medium]) ||
          link.attributes[medium].some((code) => typeof code !== "string"))
      )
        throw new Error("Invalid Kitsu streaming-link languages");
    return {
      ...link,
      attributes: {
        ...link.attributes,
        subs: link.attributes.subs ?? [],
        dubs: link.attributes.dubs ?? [],
      },
    };
  });
}

export async function fetchStreamingLinks(id: string): Promise<KitsuStreamingLink[] | null> {
  if (!/^[1-9]\d*$/.test(id)) throw new Error("Invalid Kitsu ID");
  const links: KitsuStreamingLink[] = [];
  for (let offset = 0; offset < 2000; offset += 20) {
    await waitForProvider(250);
    const url = new URL(`${SOURCE_PREFIX}${id}/streaming-links`);
    url.searchParams.set("page[limit]", "20");
    url.searchParams.set("page[offset]", String(offset));
    const response = await fetch(url, {
      headers: { Accept: "application/vnd.api+json" },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404 && offset === 0) return null;
    if (!response.ok) throw new Error(await formatHttpError("Kitsu streaming links", response));
    const body = (await response.json()) as {
      data?: unknown;
      meta?: { count?: number };
      links?: { next?: string | null };
    };
    const page = validateStreamingLinks(body.data);
    if (page.some((link) => links.some((existing) => existing.id === link.id)))
      throw new Error("Repeated Kitsu streaming-link page");
    links.push(...page);
    if (!body.links?.next) {
      if (
        body.meta?.count != null &&
        (!Number.isInteger(body.meta.count) || body.meta.count !== links.length)
      )
        throw new Error("Incomplete Kitsu streaming-link pagination");
      return links;
    }
    if (page.length !== 20) throw new Error("Incomplete Kitsu streaming-link page");
  }
  throw new Error("Kitsu streaming-link pagination limit exceeded");
}

export function streamingLanguageAssertions(
  id: string,
  links: KitsuStreamingLink[],
): ProviderLanguageAssertion[] {
  const evidence = new Map<string, ProviderLanguageAssertion>();
  const names = new Intl.DisplayNames("en", { type: "language" });
  for (const link of links) {
    try {
      const stream = new URL(link.attributes.url);
      if (!["http:", "https:"].includes(stream.protocol) || stream.username || stream.password)
        continue;
    } catch {
      continue;
    }
    for (const [field, mediaType, evidenceType] of [
      ["dubs", "audio", "provider_audio"],
      ["subs", "subtitle", "provider_subtitle"],
    ] as const) {
      for (const code of link.attributes[field]) {
        try {
          const languageCode = normalizeLanguageCode(
            Intl.getCanonicalLocales(code.trim().replaceAll("_", "-"))[0]!,
          );
          if (!names.of(languageCode) || names.of(languageCode) === languageCode) continue;
          const sourceUrl = `${SOURCE_PREFIX}${id}/streaming-links#${link.id}`;
          evidence.set(`${languageCode}:${mediaType}:${link.id}`, {
            languageCode,
            mediaType,
            evidenceType,
            sourceUrl,
            value: "available",
            confidence: 75,
          });
        } catch {
          /* Unrecognized language codes supply no evidence. */
        }
      }
    }
  }
  return [...evidence.values()];
}

/** Catalogue track metadata is historical existence evidence, not a current regional offer. */
export async function syncKitsuLanguages(
  animeId: number,
  fetchLinks: typeof fetchStreamingLinks = fetchStreamingLinks,
): Promise<{ status: "matched" | "unmatched"; evidenceCount: number }> {
  const mappings = await db
    .select()
    .from(animeMappings)
    .where(and(eq(animeMappings.animeId, animeId), eq(animeMappings.provider, "kitsu")));
  const scope = {
    animeId,
    provider: "kitsu-languages",
    sourceUrlPrefixes: [SOURCE_PREFIX],
    evidenceTypes: ["provider_audio" as const, "provider_subtitle" as const],
  };
  if (mappings.length > 1) {
    await replaceProviderLanguageSnapshot({ ...scope, evidence: [] });
    throw new Error(
      `Multiple Kitsu identities exist for anime ${animeId}; refusing to attach language tracks`,
    );
  }
  const mapping = mappings[0];
  if (
    !mapping ||
    mapping.source === "fuzzy" ||
    mapping.confidence < 100 ||
    !/^[1-9]\d*$/.test(mapping.providerId)
  ) {
    await replaceProviderLanguageSnapshot({ ...scope, evidence: [] });
    return { status: "unmatched", evidenceCount: 0 };
  }
  const expectedUrl = `${SOURCE_PREFIX}${mapping.providerId}/streaming-links#`;
  const old = await db
    .select()
    .from(animeLanguageEvidence)
    .where(
      and(eq(animeLanguageEvidence.animeId, animeId), eq(animeLanguageEvidence.source, "provider")),
    );
  if (
    old.some(
      (row) => row.sourceUrl?.startsWith(SOURCE_PREFIX) && !row.sourceUrl.startsWith(expectedUrl),
    )
  )
    await replaceProviderLanguageSnapshot({ ...scope, evidence: [] });
  const links = await fetchLinks(mapping.providerId);
  if (!links) return { status: "unmatched", evidenceCount: 0 };
  const evidence = streamingLanguageAssertions(mapping.providerId, links);
  await replaceProviderLanguageSnapshot({ ...scope, evidence });
  return { status: "matched", evidenceCount: evidence.length };
}
