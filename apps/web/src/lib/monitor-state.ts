import {
  isControlPending,
  type SyncMonitorControlState,
  type SyncMonitorStatus,
} from "@anicore/sync-monitor";

export type SyncControlMode = "start" | "pause" | "resume";

/**
 * Which primary control the monitor should offer. A command is only offered
 * while a sync process is actually active, so this matches the API's own gate
 * (`isAnySyncActive`): a stale paused status file left behind by a process that
 * was killed from the terminal must not produce a Resume button, because the
 * API would reject that command with a 409.
 */
export function syncControlMode(input: {
  active: boolean;
  status: SyncMonitorStatus | null;
  control: SyncMonitorControlState | null;
}): SyncControlMode {
  if (!input.active) return "start";
  if (input.status?.state === "paused") return "resume";

  // A queued pause is not a paused run yet; keep the Pause button (spinning)
  // until the loop acknowledges it.
  if (input.control?.command === "pause") {
    return isControlPending(input.control) ? "pause" : "resume";
  }

  return "pause";
}

const LIVE_RUN_STATES: ReadonlySet<string> = new Set(["running", "paused", "stopping"]);

/**
 * The run state to display. When no process is alive, the last state written
 * by a process that died (running/paused/stopping) is shown as stopped instead
 * of implying the run is still waiting for input.
 */
export function displayRunState(
  status: SyncMonitorStatus | null,
  active: boolean,
): SyncMonitorStatus["state"] | null {
  if (!status) return null;
  if (!active && LIVE_RUN_STATES.has(status.state)) return "stopped";
  return status.state;
}
