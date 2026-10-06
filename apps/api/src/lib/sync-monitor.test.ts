import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-write-json";
import {
  appendSyncMonitorEvent,
  readSyncMonitorEvents,
  readSyncMonitorStatus,
  SyncMonitor,
  writeSyncMonitorControlState,
} from "./sync-monitor";

const originalRename = fs.renameSync;
let directory: string;
let previousDirectory: string | undefined;
let rename: ReturnType<typeof spyOn<typeof fs, "renameSync">>;
let wait: ReturnType<typeof spyOn<typeof Atomics, "wait">>;
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;

function fileError(code: string): Error & { code: string } {
  return Object.assign(new Error(`File operation failed: ${code}`), { code });
}

function createMonitor(): SyncMonitor {
  return new SyncMonitor({
    mode: "dry-run",
    total: 2,
    startIndex: 0,
    endIndex: 2,
    parallel: 1,
    providers: ["anilist"],
  });
}

beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), "anicore-sync-monitor-"));
  previousDirectory = process.env.ANICORE_SYNC_MONITOR_DIR;
  process.env.ANICORE_SYNC_MONITOR_DIR = directory;
  rename = spyOn(fs, "renameSync");
  wait = spyOn(Atomics, "wait").mockReturnValue("timed-out");
  warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  rename.mockRestore();
  wait.mockRestore();
  warn.mockRestore();
  if (previousDirectory === undefined) delete process.env.ANICORE_SYNC_MONITOR_DIR;
  else process.env.ANICORE_SYNC_MONITOR_DIR = previousDirectory;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("atomic monitor writes", () => {
  test("bounds serialized events and invalidates cached tails on file changes", () => {
    appendSyncMonitorEvent("error", "\u0001".repeat(30000));
    const first = readSyncMonitorEvents();
    expect(first).toHaveLength(1);
    first[0]!.message = "Mutated caller value";
    expect(readSyncMonitorEvents()[0]!.message).not.toBe("Mutated caller value");
    appendSyncMonitorEvent("info", "New event");
    expect(readSyncMonitorEvents().at(-1)!.message).toBe("New event");
  });
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    test(`retries ${code} without exposing a partial snapshot`, () => {
      const path = join(directory, "status.json");
      fs.writeFileSync(path, JSON.stringify({ state: "old" }));
      let attempts = 0;
      rename.mockImplementation((source, destination) => {
        expect(JSON.parse(fs.readFileSync(path, "utf-8"))).toEqual({ state: "old" });
        if (attempts++ < 2) throw fileError(code);
        originalRename(source, destination);
      });

      atomicWriteJson(path, { state: "new" });

      expect(JSON.parse(fs.readFileSync(path, "utf-8"))).toEqual({ state: "new" });
      expect(rename).toHaveBeenCalledTimes(3);
      expect(wait).toHaveBeenCalledTimes(2);
      expect(fs.readdirSync(directory)).toEqual(["status.json"]);
    });
  }

  test("bounds retries and preserves the previous snapshot on a persistent lock", () => {
    const path = join(directory, "status.json");
    fs.writeFileSync(path, JSON.stringify({ state: "old" }));
    const error = fileError("EPERM");
    rename.mockImplementation(() => {
      throw error;
    });

    expect(() => atomicWriteJson(path, { state: "new" })).toThrow(error);
    expect(rename).toHaveBeenCalledTimes(6);
    expect(wait.mock.calls.map((call) => call[3])).toEqual([20, 40, 80, 160, 320]);
    expect(JSON.parse(fs.readFileSync(path, "utf-8"))).toEqual({ state: "old" });
    expect(fs.readdirSync(directory)).toEqual(["status.json"]);
  });

  test("does not retry unrelated errors and cleans up the temporary file", () => {
    const error = fileError("ENOSPC");
    rename.mockImplementation(() => {
      throw error;
    });

    expect(() => atomicWriteJson(join(directory, "status.json"), {})).toThrow(error);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});

describe("sync monitor status locks", () => {
  test("continues updating in memory and publishes the latest state after the lock clears", () => {
    const monitor = createMonitor();
    rename.mockImplementation(() => {
      throw fileError("EPERM");
    });

    expect(() => monitor.stage("anilist", 0, 123)).not.toThrow();
    expect(() => monitor.recordError("Provider failed", 0, 123)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(readSyncMonitorStatus()?.currentStage).toBe("starting");

    rename.mockImplementation(originalRename);
    monitor.complete({ created: 0, updated: 1, failed: 1 });

    const status = readSyncMonitorStatus();
    expect(status?.state).toBe("completed");
    expect(status?.currentAnilistId).toBe(123);
    expect(status?.recentErrors).toEqual(["Provider failed"]);
    expect(status?.stats).toEqual({ created: 0, updated: 1, failed: 1 });
    expect(fs.readdirSync(directory).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  test("can start and finish while only the status file is locked", () => {
    rename.mockImplementation((source, destination) => {
      if (destination === `${directory}/status.json`) throw fileError("EPERM");
      originalRename(source, destination);
    });

    const monitor = createMonitor();
    expect(() => monitor.complete({ created: 0, updated: 2, failed: 0 })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("still reports failed control writes to the caller", () => {
    rename.mockImplementation(() => {
      throw fileError("EPERM");
    });

    expect(() => writeSyncMonitorControlState("stop", "Stop requested")).toThrow("EPERM");
  });

  test("does not hide unrelated status write errors", () => {
    const monitor = createMonitor();
    rename.mockImplementation(() => {
      throw fileError("ENOSPC");
    });

    expect(() => monitor.stage("anilist")).toThrow("ENOSPC");
  });
});
