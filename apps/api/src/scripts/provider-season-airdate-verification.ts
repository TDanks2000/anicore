export const MAX_PROVIDER_START_DATE_DELTA_DAYS = 180;

export type ProviderSeasonAirdateRejectReason =
  | "target-start-date-unavailable"
  | "provider-airdate-unavailable"
  | "provider-start-date-mismatch";

export interface ProviderSeasonAirdateResult {
  ok: boolean;
  reason: ProviderSeasonAirdateRejectReason | null;
  targetStartDate: string | null;
  providerFirstAirDate: string | null;
  startDateDeltaDays: number | null;
}

function parseIsoDate(value: string | null | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return timestamp;
}

export function earliestProviderAirDate(
  values: Array<string | null | undefined>,
): string | null {
  let earliest: { value: string; timestamp: number } | null = null;
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const timestamp = parseIsoDate(trimmed);
    if (timestamp === null) continue;
    if (!earliest || timestamp < earliest.timestamp) {
      earliest = { value: trimmed, timestamp };
    }
  }
  return earliest?.value ?? null;
}

export function verifyProviderSeasonAirdate(input: {
  targetStartDate: string | null;
  providerFirstAirDate: string | null;
}): ProviderSeasonAirdateResult {
  const targetTimestamp = parseIsoDate(input.targetStartDate);
  if (targetTimestamp === null) {
    return {
      ok: false,
      reason: "target-start-date-unavailable",
      targetStartDate: input.targetStartDate,
      providerFirstAirDate: input.providerFirstAirDate,
      startDateDeltaDays: null,
    };
  }

  const providerTimestamp = parseIsoDate(input.providerFirstAirDate);
  if (providerTimestamp === null) {
    return {
      ok: false,
      reason: "provider-airdate-unavailable",
      targetStartDate: input.targetStartDate,
      providerFirstAirDate: input.providerFirstAirDate,
      startDateDeltaDays: null,
    };
  }

  const deltaDays = Math.round(
    Math.abs(providerTimestamp - targetTimestamp) / (24 * 60 * 60 * 1000),
  );
  if (deltaDays > MAX_PROVIDER_START_DATE_DELTA_DAYS) {
    return {
      ok: false,
      reason: "provider-start-date-mismatch",
      targetStartDate: input.targetStartDate,
      providerFirstAirDate: input.providerFirstAirDate,
      startDateDeltaDays: deltaDays,
    };
  }

  return {
    ok: true,
    reason: null,
    targetStartDate: input.targetStartDate,
    providerFirstAirDate: input.providerFirstAirDate,
    startDateDeltaDays: deltaDays,
  };
}
