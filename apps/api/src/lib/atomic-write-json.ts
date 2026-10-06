import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

const RENAME_RETRY_DELAYS_MS = [20, 40, 80, 160, 320];
const retrySignal = new Int32Array(new SharedArrayBuffer(4));

export function isRetryableFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY")
  );
}

/** Keep readers on a complete snapshot, including while Windows holds a file lock. */
export function atomicWriteJson(path: string, value: unknown): void {
  const tmpPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(value, null, 2), { flag: "wx" });
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmpPath, path);
        return;
      } catch (error) {
        const delay = RENAME_RETRY_DELAYS_MS[attempt];
        if (!isRetryableFileError(error) || delay === undefined) throw error;
        // The monitor API is synchronous; bound the wait to 620ms in total.
        Atomics.wait(retrySignal, 0, 0, delay);
      }
    }
  } finally {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Cleanup must not mask the original write/rename error.
    }
  }
}
