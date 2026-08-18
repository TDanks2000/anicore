export interface ExistingKitsuIdentity {
  providerId: string;
  source: "manual" | "api" | "import" | "fuzzy" | "system";
  confidence: number;
}

export function conflictingKitsuIdentities(
  existing: ExistingKitsuIdentity[],
  incomingProviderId: string,
): ExistingKitsuIdentity[] {
  return existing.filter(
    (mapping) => mapping.providerId !== incomingProviderId,
  );
}

export function formatKitsuIdentityConflict(
  incomingProviderId: string,
  conflicts: ExistingKitsuIdentity[],
): string {
  const existing = conflicts
    .map(
      (mapping) =>
        `${mapping.providerId} (${mapping.source}/${mapping.confidence})`,
    )
    .join(", ");

  return `Refusing to add Kitsu mapping ${incomingProviderId}: this anime already has a different Kitsu identity (${existing}). Resolve the existing mapping explicitly before rematching.`;
}
