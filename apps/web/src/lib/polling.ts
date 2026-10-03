export interface PollTiming {
  activeMs: number;
  idleMs: number;
  maxBackoffMs: number;
}

/**
 * Delay before the next poll. Runs fast while a sync is active, slower when
 * idle, and backs off exponentially while requests keep failing.
 */
export function nextPollDelay(failures: number, active: boolean, timing: PollTiming): number {
  if (failures > 0) {
    return Math.min(timing.activeMs * 2 ** Math.min(failures, 6), timing.maxBackoffMs);
  }
  return active ? timing.activeMs : timing.idleMs;
}
