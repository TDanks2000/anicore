export interface AnimeScheduleIdentity {
  providerId: string;
  source: "manual" | "api" | "import" | "fuzzy" | "system";
  confidence?: number;
}

export function assertSingleAnimeScheduleIdentity(
  mappings: AnimeScheduleIdentity[],
): AnimeScheduleIdentity | null {
  if (mappings.length === 0) return null;
  if (mappings.length === 1) return mappings[0]!;

  const ids = mappings
    .map(
      (mapping) =>
        `${mapping.providerId} (${mapping.source}${mapping.confidence == null ? "" : `/${mapping.confidence}`})`,
    )
    .join(", ");
  throw new Error(
    `Multiple AnimeSchedule identities exist for this anime (${ids}); resolve the mapping group before syncing dub evidence`,
  );
}

export function assertAnimeScheduleRouteCompatible(
  mappings: AnimeScheduleIdentity[],
  incomingRoute: string,
): void {
  const conflicting = mappings.filter(
    (mapping) => mapping.providerId !== incomingRoute,
  );
  if (!conflicting.length) return;

  const ids = conflicting
    .map((mapping) => `${mapping.providerId} (${mapping.source})`)
    .join(", ");
  throw new Error(
    `Refusing to add AnimeSchedule route ${incomingRoute}: this anime already has a different AnimeSchedule identity (${ids})`,
  );
}
