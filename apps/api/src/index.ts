import { assertDatabaseConfigured, closeDb } from "@anicore/db";
import { installProxyFetch } from "@anicore/providers/lib/proxy";
import { app } from "./app";
import { startAuditScheduler } from "./lib/audit-scheduler";
import { startAutomaticSyncScheduler } from "./lib/automatic-sync";
import { stopApiStartedSyncProcess } from "./lib/sync-process";

assertDatabaseConfigured();
installProxyFetch();

function readPort(value: string | undefined): number {
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

const port = readPort(process.env.PORT);
const hostname = process.env.HOST ?? "localhost";

app.listen({ hostname, port });
const automaticSyncScheduler = startAutomaticSyncScheduler();
const auditScheduler = startAuditScheduler();
let shuttingDown = false;

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  automaticSyncScheduler.stop();
  console.info(`AniCore API shutting down after ${signal}`);

  try {
    await app.stop();
    await stopApiStartedSyncProcess();
    await auditScheduler.stop();
    await closeDb();
    process.exit(0);
  } catch (error) {
    console.error("AniCore API shutdown failed", error);
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}

console.log(`AniCore API running at http://${hostname}:${port} (docs at /docs)`);
