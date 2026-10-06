import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditLanguageStatus } from "../scripts/audit-language-status";
import { auditMappings } from "../scripts/audit-mappings";
import { atomicWriteJson } from "./atomic-write-json";
import { appendSyncMonitorEvent } from "./sync-monitor";
import { isAnySyncActive } from "./sync-process";

export function startAuditScheduler(
  options: {
    intervalMs?: number;
    directory?: string;
    now?: () => number;
    active?: () => boolean;
    audit?: () => Promise<unknown>;
    onError?: (error: unknown) => void;
  } = {},
) {
  const hours = Number(process.env.ANICORE_AUDIT_INTERVAL_HOURS ?? 24);
  const interval = options.intervalMs ?? hours * 3600_000;
  if (!Number.isFinite(interval) || interval < 0) throw new Error("Invalid audit interval");
  const directory = resolve(options.directory ?? "data/audits");
  const now = options.now ?? Date.now;
  const active = options.active ?? isAnySyncActive;
  const audit =
    options.audit ??
    (async () => ({ mappings: await auditMappings(), languages: await auditLanguageStatus() }));
  let lastRun = 0;
  try {
    lastRun =
      Number(JSON.parse(readFileSync(resolve(directory, "latest.json"), "utf8")).completedAt) || 0;
  } catch {}
  let running: Promise<void> | null = null;
  let stopped = false;
  let retryAfter = 0;
  const check = () => {
    if (
      stopped ||
      interval === 0 ||
      running ||
      active() ||
      now() < retryAfter ||
      now() - lastRun < interval
    )
      return running ?? Promise.resolve();
    running = (async () => {
      try {
        const report = await audit();
        const completedAt = now();
        mkdirSync(directory, { recursive: true });
        atomicWriteJson(resolve(directory, "latest.json"), { completedAt, report });
        lastRun = completedAt;
        if (!options.audit) {
          const audits = report as { mappings: { ok: boolean }; languages: { ok: boolean } };
          const clean = audits.mappings.ok && audits.languages.ok;
          appendSyncMonitorEvent(
            clean ? "info" : "error",
            clean
              ? "Scheduled audits passed; inspect data/audits/latest.json"
              : "Scheduled audits found integrity errors; inspect data/audits/latest.json",
            { event: "audit.completed" },
          );
        }
      } catch (error) {
        retryAfter = now() + 15 * 60_000;
        (options.onError ?? ((failure) => console.error("Scheduled audit failed", failure)))(error);
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };
  const timer = interval === 0 ? null : setInterval(() => void check(), 60_000);
  timer?.unref?.();
  void check();
  return {
    check,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await running;
    },
  };
}
