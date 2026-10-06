import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSyncMonitorRuntimeConfig,
  validateSyncMonitorRuntimeConfigPatch,
  writeSyncMonitorRuntimeConfig,
} from "./sync-monitor";
import { buildAutomaticSyncArgs, buildSyncStartArgs } from "./sync-process";

let directory: string;
let priorDirectory: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "anicore-start-options-"));
  priorDirectory = process.env.ANICORE_SYNC_MONITOR_DIR;
  process.env.ANICORE_SYNC_MONITOR_DIR = directory;
});
afterEach(() => {
  if (priorDirectory === undefined) delete process.env.ANICORE_SYNC_MONITOR_DIR;
  else process.env.ANICORE_SYNC_MONITOR_DIR = priorDirectory;
  rmSync(directory, { recursive: true, force: true });
});

test("saved new-ID and reverse settings reach manual starts and dry runs", () => {
  writeSyncMonitorRuntimeConfig({ newIdsOnly: true, idOrder: "descending" }, "api");
  expect(readSyncMonitorRuntimeConfig()).toMatchObject({ newIdsOnly: true, idOrder: "descending" });
  expect(buildSyncStartArgs()).toContain("--new-ids-only");
  expect(buildSyncStartArgs()).toContain("--reverse");
  expect(buildSyncStartArgs()).toContain("--dry-run");
  const args = buildSyncStartArgs({ newIdsOnly: false, idOrder: "ascending", dryRun: false });
  expect(args).not.toContain("--new-ids-only");
  expect(args).not.toContain("--reverse");
  expect(args).not.toContain("--dry-run");
  expect(buildAutomaticSyncArgs()).not.toContain("--new-ids-only");
});

test("legacy settings default to all IDs ascending and invalid patches fail", () => {
  const { newIdsOnly: _new, idOrder: _order, ...legacy } = readSyncMonitorRuntimeConfig();
  writeFileSync(join(directory, "runtime-config.json"), JSON.stringify(legacy));
  expect(readSyncMonitorRuntimeConfig()).toMatchObject({ newIdsOnly: false, idOrder: "ascending" });
  expect(() => validateSyncMonitorRuntimeConfigPatch({ idOrder: "bad" as "ascending" })).toThrow(
    "idOrder",
  );
  expect(() =>
    validateSyncMonitorRuntimeConfigPatch({ newIdsOnly: "yes" as unknown as boolean }),
  ).toThrow("newIdsOnly");
});

test("a saved zero start limit means no limit instead of crashing the sync CLI", () => {
  writeSyncMonitorRuntimeConfig({ startLimit: 0 }, "api");
  expect(buildSyncStartArgs().some((arg) => arg.startsWith("--limit="))).toBe(false);

  writeSyncMonitorRuntimeConfig({ startLimit: 25 }, "api");
  expect(buildSyncStartArgs()).toContain("--limit=25");
});
