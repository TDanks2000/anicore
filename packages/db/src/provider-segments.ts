export interface ProviderEpisodeSegment {
  providerEpisodeStart: number;
  providerEpisodeEnd: number;
  localEpisodeStart: number;
  localEpisodeEnd: number;
}

export interface ProviderSegmentValidationResult {
  ok: boolean;
  reason?:
    | "non-integer"
    | "non-positive-start"
    | "reversed-provider-range"
    | "reversed-local-range"
    | "unequal-span";
}

export function validateProviderEpisodeSegment(
  segment: ProviderEpisodeSegment,
): ProviderSegmentValidationResult {
  const values = [
    segment.providerEpisodeStart,
    segment.providerEpisodeEnd,
    segment.localEpisodeStart,
    segment.localEpisodeEnd,
  ];
  if (!values.every(Number.isInteger)) return { ok: false, reason: "non-integer" };
  if (segment.providerEpisodeStart <= 0 || segment.localEpisodeStart <= 0) {
    return { ok: false, reason: "non-positive-start" };
  }
  if (segment.providerEpisodeEnd < segment.providerEpisodeStart) {
    return { ok: false, reason: "reversed-provider-range" };
  }
  if (segment.localEpisodeEnd < segment.localEpisodeStart) {
    return { ok: false, reason: "reversed-local-range" };
  }
  if (
    segment.providerEpisodeEnd - segment.providerEpisodeStart !==
    segment.localEpisodeEnd - segment.localEpisodeStart
  ) {
    return { ok: false, reason: "unequal-span" };
  }
  return { ok: true };
}

export function mapProviderEpisodeToLocal(
  segment: ProviderEpisodeSegment,
  providerEpisodeNumber: number,
): number | null {
  if (!validateProviderEpisodeSegment(segment).ok) return null;
  if (
    !Number.isInteger(providerEpisodeNumber) ||
    providerEpisodeNumber < segment.providerEpisodeStart ||
    providerEpisodeNumber > segment.providerEpisodeEnd
  ) {
    return null;
  }
  return (
    segment.localEpisodeStart +
    (providerEpisodeNumber - segment.providerEpisodeStart)
  );
}

export function mapLocalEpisodeToProvider(
  segment: ProviderEpisodeSegment,
  localEpisodeNumber: number,
): number | null {
  if (!validateProviderEpisodeSegment(segment).ok) return null;
  if (
    !Number.isInteger(localEpisodeNumber) ||
    localEpisodeNumber < segment.localEpisodeStart ||
    localEpisodeNumber > segment.localEpisodeEnd
  ) {
    return null;
  }
  return (
    segment.providerEpisodeStart +
    (localEpisodeNumber - segment.localEpisodeStart)
  );
}

export function providerSegmentsOverlap(
  left: ProviderEpisodeSegment,
  right: ProviderEpisodeSegment,
): boolean {
  if (
    !validateProviderEpisodeSegment(left).ok ||
    !validateProviderEpisodeSegment(right).ok
  ) {
    return false;
  }
  return (
    left.providerEpisodeStart <= right.providerEpisodeEnd &&
    right.providerEpisodeStart <= left.providerEpisodeEnd
  );
}

export function localSegmentsOverlap(
  left: ProviderEpisodeSegment,
  right: ProviderEpisodeSegment,
): boolean {
  if (
    !validateProviderEpisodeSegment(left).ok ||
    !validateProviderEpisodeSegment(right).ok
  ) {
    return false;
  }
  return (
    left.localEpisodeStart <= right.localEpisodeEnd &&
    right.localEpisodeStart <= left.localEpisodeEnd
  );
}
