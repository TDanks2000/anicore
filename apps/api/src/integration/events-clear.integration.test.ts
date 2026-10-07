import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "../app";
import {
  appendSyncMonitorEvent,
  readSyncMonitorEvents,
  readSyncMonitorStatus,
  SyncMonitor,
} from "../lib/sync-monitor";

let directory: string;
let originalDirectory: string | undefined;
let originalCode: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "anicore-events-clear-"));
  originalDirectory = process.env.ANICORE_SYNC_MONITOR_DIR;
  originalCode = process.env.ANICORE_SYNC_MONITOR_CODE;
  process.env.ANICORE_SYNC_MONITOR_DIR = directory;
  process.env.ANICORE_SYNC_MONITOR_CODE = "clear-test-code";
});
afterEach(() => {
  if (originalDirectory === undefined) delete process.env.ANICORE_SYNC_MONITOR_DIR;
  else process.env.ANICORE_SYNC_MONITOR_DIR = originalDirectory;
  if (originalCode === undefined) delete process.env.ANICORE_SYNC_MONITOR_CODE;
  else process.env.ANICORE_SYNC_MONITOR_CODE = originalCode;
  rmSync(directory, { recursive: true, force: true });
});
function clear(code?: string) {
  return app.handle(
    new Request("http://localhost/sync-monitor/events/clear", {
      method: "POST",
      headers: code ? { Authorization: `Bearer ${code}` } : {},
    }),
  );
}

test("clearing events requires monitor authorization and preserves rejected callers' logs", async () => {
  appendSyncMonitorEvent("error", "Keep this event");
  expect((await clear()).status).toBe(401);
  expect((await clear("wrong-code")).status).toBe(401);
  expect(readSyncMonitorEvents()[0]?.message).toBe("Keep this event");
});

test("clears current and archived events during a run without altering its status", async () => {
  const monitor = new SyncMonitor({
    mode: "sync",
    total: 2,
    startIndex: 0,
    endIndex: 2,
    parallel: 1,
    providers: ["anilist"],
  });
  monitor.recordError("Provider failed", 0, 123);
  const before = readSyncMonitorStatus();
  const path = join(directory, "events.jsonl");
  for (let index = 1; index <= 3; index++) writeFileSync(`${path}.${index}`, "archived event\n");
  readSyncMonitorEvents(); // Populate the tail cache before clearing.
  const beforeSnapshot = await (
    await app.handle(
      new Request("http://localhost/sync-monitor/snapshot", {
        headers: { Authorization: "Bearer clear-test-code" },
      }),
    )
  ).json();
  const response = await clear("clear-test-code");
  expect(response.status).toBe(200);
  const snapshot = await response.json();
  expect(snapshot.events).toEqual([]);
  expect(snapshot.active).toBe(true);
  expect(snapshot.revision).not.toBe(beforeSnapshot.revision);
  expect(readSyncMonitorEvents()).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("");
  for (let index = 1; index <= 3; index++) expect(existsSync(`${path}.${index}`)).toBe(false);
  expect(readSyncMonitorStatus()).toEqual(before);
  appendSyncMonitorEvent("info", "New event after clearing");
  expect(readSyncMonitorEvents().map((event) => event.message)).toEqual([
    "New event after clearing",
  ]);
});

test("refuses clearing while another writer holds the rotation lock", async () => {
  appendSyncMonitorEvent("info", "Keep this event");
  writeFileSync(join(directory, "events.jsonl.rotate-lock"), String(process.pid));
  const response = await clear("clear-test-code");
  expect(response.status).toBe(409);
  expect(readSyncMonitorEvents()[0]?.message).toBe("Keep this event");
});
