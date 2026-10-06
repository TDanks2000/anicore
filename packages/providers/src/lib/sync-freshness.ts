import type { ProviderAnimeData } from "../providers/types";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Refresh distant releases periodically, but wake up before their release window. */
export function animeRefreshTtl(
  data: Pick<ProviderAnimeData, "status" | "startDate" | "nextEpisodeAirsAt">,
  language = false,
  now = Date.now(),
): number {
  if (data.status === "FINISHED" || data.status === "CANCELLED") {
    return language ? DAY : 7 * DAY;
  }
  const start = data.startDate ? Date.parse(data.startDate) : NaN;
  if (data.status === "NOT_YET_RELEASED" && start > now + 7 * DAY) {
    return Math.min(30 * DAY, start - now - 7 * DAY);
  }
  if (data.status === "NOT_YET_RELEASED" && !Number.isFinite(start)) return 7 * DAY;

  const airing = (data.nextEpisodeAirsAt ?? 0) * 1000;
  // Keep metadata checks within a day and check again just after the next episode.
  if (data.status === "RELEASING" && airing > now) {
    return Math.min(DAY, airing - now + HOUR);
  }
  return 6 * HOUR;
}

export interface FreshnessStage {
  stage: string;
  failures: number;
  nextDueAt: number | null;
  payloadJson: string | null;
}

/** Missing, failed, expired, or damaged stage snapshots must still be repaired. */
export function allSyncStagesFresh(
  states: FreshnessStage[],
  requiredStages: string[],
  now = Date.now(),
): boolean {
  const byStage = new Map(states.map((state) => [state.stage, state]));
  return (
    states.every((state) => state.failures === 0) &&
    requiredStages.every((name) => {
      const state = byStage.get(name);
      if (!state || state.failures || (state.nextDueAt ?? 0) <= now || state.payloadJson === null)
        return false;
      try {
        JSON.parse(state.payloadJson);
        return true;
      } catch {
        return false;
      }
    })
  );
}
