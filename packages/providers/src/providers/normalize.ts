import type { ProviderStudio, ProviderTag } from "./types";

export function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase();
}

export function dedupeProviderStudios(
  studios: ProviderStudio[],
): ProviderStudio[] {
  const byName = new Map<string, ProviderStudio>();

  for (const studio of studios) {
    const name = studio.name.trim();
    if (!name) continue;

    const normalizedName = normalizeEntityName(name);
    const existing = byName.get(normalizedName);
    if (!existing) {
      byName.set(normalizedName, { ...studio, name });
      continue;
    }

    existing.isMain = existing.isMain || studio.isMain;
    existing.isAnimationStudio =
      existing.isAnimationStudio || studio.isAnimationStudio;
    existing.anilistStudioId ??= studio.anilistStudioId ?? null;
  }

  return [...byName.values()];
}

export function dedupeProviderTags(tags: ProviderTag[]): ProviderTag[] {
  const byName = new Map<string, ProviderTag>();

  for (const tag of tags) {
    const name = tag.name.trim();
    if (!name) continue;

    const normalizedName = normalizeEntityName(name);
    const existing = byName.get(normalizedName);
    if (!existing) {
      byName.set(normalizedName, { ...tag, name });
      continue;
    }

    existing.category ??= tag.category ?? null;
    existing.rank = Math.min(
      existing.rank ?? Number.MAX_SAFE_INTEGER,
      tag.rank ?? Number.MAX_SAFE_INTEGER,
    );
    if (existing.rank === Number.MAX_SAFE_INTEGER) existing.rank = null;
    existing.isGeneralSpoiler =
      (existing.isGeneralSpoiler ?? false) || (tag.isGeneralSpoiler ?? false);
    existing.isMediaSpoiler =
      (existing.isMediaSpoiler ?? false) || (tag.isMediaSpoiler ?? false);
    existing.isAdult = (existing.isAdult ?? false) || (tag.isAdult ?? false);
  }

  return [...byName.values()];
}
