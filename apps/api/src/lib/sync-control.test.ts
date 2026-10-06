import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncControl, SyncStoppedError } from "./sync-control";
import {
  readSyncMonitorControlState,
  readSyncMonitorStatus,
  SyncMonitor,
  writeSyncMonitorControlState,
} from "./sync-monitor";

let directory: string;
let previousDirectory: string | undefined;
let controls: SyncControl;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "anicore-sync-control-"));
  previousDirectory = process.env.ANICORE_SYNC_MONITOR_DIR;
  process.env.ANICORE_SYNC_MONITOR_DIR = directory;
  controls = new SyncControl(10);
});

afterEach(() => {
  controls.dispose();
  if (previousDirectory === undefined) delete process.env.ANICORE_SYNC_MONITOR_DIR;
  else process.env.ANICORE_SYNC_MONITOR_DIR = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
});

function monitor(): SyncMonitor {
  const result = new SyncMonitor({
    mode: "dry-run",
    total: 2,
    startIndex: 0,
    endIndex: 2,
    parallel: 2,
    providers: ["anilist"],
  });
  controls.attach(result);
  return result;
}

test("acknowledges pause during an active wait and blocks work until resume", async () => {
  const status = monitor();
  const waiting = controls.sleep(200);
  writeSyncMonitorControlState("pause", "Pause requested");
  await Bun.sleep(40);
  expect(readSyncMonitorControlState().acknowledgedAt).not.toBeNull();
  expect(readSyncMonitorStatus()?.state).toBe("paused");
  status.stage("provider-finished");
  expect(readSyncMonitorStatus()?.currentStage).toBe("paused");
  let released = false;
  const work = controls.waitForRelease().then((result) => {
    released = result;
  });
  await Bun.sleep(40);
  expect(released).toBe(false);
  writeSyncMonitorControlState("resume", "Resume requested");
  await work;
  await waiting;
  expect(released).toBe(true);
  expect(readSyncMonitorStatus()?.state).toBe("running");
  expect(readSyncMonitorControlState().acknowledgedAt).not.toBeNull();
});

test("stop interrupts a long retry wait and aborts provider requests promptly", async () => {
  monitor();
  const started = Date.now();
  const waiting = controls.sleep(60_000).catch((error: unknown) => error);
  const provider = new Promise<unknown>((resolve) => {
    controls.signal.addEventListener("abort", () => resolve(controls.signal.reason), {
      once: true,
    });
  });
  writeSyncMonitorControlState("stop", "Stop requested");
  expect(await waiting).toBeInstanceOf(SyncStoppedError);
  expect(await provider).toBeInstanceOf(SyncStoppedError);
  expect(Date.now() - started).toBeLessThan(500);
  expect(await controls.waitForRelease()).toBe(false);
  expect(readSyncMonitorControlState().acknowledgedAt).not.toBeNull();
  expect(readSyncMonitorStatus()?.state).toBe("stopping");
});

test("monitor initialization preserves a command received during startup", async () => {
  writeSyncMonitorControlState("pause", "Pause during startup");
  await Bun.sleep(40);
  monitor();
  expect(readSyncMonitorControlState().command).toBe("pause");
  expect(readSyncMonitorStatus()?.state).toBe("paused");
  writeSyncMonitorControlState("stop", "Stop while paused");
  expect(await controls.waitForRelease()).toBe(false);
});

test("dashboard control responses include the applied state without waiting for another poll", async () => {
  const previousCode = process.env.ANICORE_SYNC_MONITOR_CODE;
  process.env.ANICORE_SYNC_MONITOR_CODE = "control-test-code";
  try {
    const { app } = await import("../app");
    monitor();
    for (const [command, state] of [
      ["pause", "paused"],
      ["resume", "running"],
      ["stop", "stopping"],
    ]) {
      const response = await app.handle(
        new Request(`http://localhost/sync-monitor/control/${command}`, {
          method: "POST",
          headers: { Authorization: "Bearer control-test-code" },
        }),
      );
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.control.command).toBe(command);
      expect(payload.control.acknowledgedAt).not.toBeNull();
      expect(payload.status.state).toBe(state);
    }
  } finally {
    if (previousCode === undefined) delete process.env.ANICORE_SYNC_MONITOR_CODE;
    else process.env.ANICORE_SYNC_MONITOR_CODE = previousCode;
  }
});
