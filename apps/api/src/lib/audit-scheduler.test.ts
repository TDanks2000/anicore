import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAuditScheduler } from "./audit-scheduler";

test("scheduled audits defer during sync, run single-flight and preserve cadence across restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anicore-audit-test-"));
  let now = 10000;
  let active = true;
  let calls = 0;
  const options = {
    directory,
    intervalMs: 1000,
    now: () => now,
    active: () => active,
    audit: async () => {
      calls++;
      await Bun.sleep(10);
      return { ok: true };
    },
  };
  const scheduler = startAuditScheduler(options);
  try {
    await scheduler.check();
    expect(calls).toBe(0);
    active = false;
    await Promise.all([scheduler.check(), scheduler.check()]);
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(join(directory, "latest.json"), "utf8")).report.ok).toBe(true);
    await scheduler.check();
    expect(calls).toBe(1);
    await scheduler.stop();
    const resumed = startAuditScheduler(options);
    await resumed.check();
    expect(calls).toBe(1);
    now += 1001;
    await resumed.check();
    expect(calls).toBe(2);
    await resumed.stop();
  } finally {
    await scheduler.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
