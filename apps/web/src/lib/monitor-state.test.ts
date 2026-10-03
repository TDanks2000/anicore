import { describe, expect, test } from "bun:test";
import type { SyncMonitorControlState, SyncMonitorStatus } from "@anicore/sync-monitor";

import { displayRunState, syncControlMode } from "./monitor-state";

const control = (command: SyncMonitorControlState["command"]): SyncMonitorControlState => ({
  version: 1,
  command,
  requestedAt: "2026-01-01T00:00:00Z",
  requestedBy: "api",
  message: null,
  acknowledgedAt: null,
});

const status = (state: SyncMonitorStatus["state"]): SyncMonitorStatus =>
  ({ state }) as SyncMonitorStatus;

describe("monitor state", () => {
  test("offers Start whenever no process is active, even if the status says paused", () => {
    expect(
      syncControlMode({ active: false, status: status("paused"), control: control("pause") }),
    ).toBe("start");
    expect(syncControlMode({ active: false, status: null, control: control(null) })).toBe("start");
  });

  test("offers Resume only for an active paused process", () => {
    expect(
      syncControlMode({ active: true, status: status("paused"), control: control("pause") }),
    ).toBe("resume");
    // An acknowledged pause counts as paused even before the status catches up.
    expect(
      syncControlMode({
        active: true,
        status: status("running"),
        control: { ...control("pause"), acknowledgedAt: "2026-01-01T00:00:01Z" },
      }),
    ).toBe("resume");
  });

  test("keeps offering Pause while a pause request is still unacknowledged", () => {
    expect(
      syncControlMode({ active: true, status: status("running"), control: control("pause") }),
    ).toBe("pause");
  });

  test("offers Pause for an active running process", () => {
    expect(
      syncControlMode({ active: true, status: status("running"), control: control(null) }),
    ).toBe("pause");
    expect(syncControlMode({ active: true, status: null, control: control(null) })).toBe("pause");
  });

  test("shows a dead process's last live state as stopped", () => {
    expect(displayRunState(status("paused"), false)).toBe("stopped");
    expect(displayRunState(status("running"), false)).toBe("stopped");
    expect(displayRunState(status("stopping"), false)).toBe("stopped");
  });

  test("keeps finished and active states as written", () => {
    expect(displayRunState(status("paused"), true)).toBe("paused");
    expect(displayRunState(status("completed"), false)).toBe("completed");
    expect(displayRunState(status("failed"), false)).toBe("failed");
    expect(displayRunState(status("stopped"), false)).toBe("stopped");
    expect(displayRunState(null, false)).toBeNull();
  });
});
