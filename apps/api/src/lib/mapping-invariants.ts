export class MappingInputError extends Error {}

export function canonicalProviderId(value: string): string {
  return value.trim();
}

export function optionalMappingText(value: string | undefined): string | null {
  return value?.trim() || null;
}

export function assertUniqueMappingIdentities(
  mappings: ReadonlyArray<{ provider: string; providerId: string }>,
): void {
  const seen = new Set<string>();

  for (const mapping of mappings) {
    const providerId = canonicalProviderId(mapping.providerId);
    if (!providerId) {
      throw new MappingInputError("Mapping providerId cannot be blank");
    }

    const key = `${mapping.provider}\u0000${providerId}`;
    if (seen.has(key)) {
      throw new MappingInputError(
        `Duplicate ${mapping.provider} mapping ${providerId} in request`,
      );
    }
    seen.add(key);
  }
}

export function assertUnambiguousAnimeMappingPrimaries(
  mappings: ReadonlyArray<{
    provider: string;
    providerId: string;
    isPrimary?: boolean;
  }>,
): void {
  assertUniqueMappingIdentities(mappings);

  const byProvider = new Map<string, typeof mappings[number][]>();
  for (const mapping of mappings) {
    const group = byProvider.get(mapping.provider) ?? [];
    group.push(mapping);
    byProvider.set(mapping.provider, group);
  }

  for (const [provider, group] of byProvider) {
    if (group.length <= 1) continue;

    const primaryCount = group.filter((mapping) => mapping.isPrimary === true).length;
    if (primaryCount !== 1) {
      throw new MappingInputError(
        `Multiple ${provider} mappings require exactly one primary mapping`,
      );
    }
  }
}
