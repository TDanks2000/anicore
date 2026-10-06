import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Bounded archives, with a process lock for API/sync writers sharing a log. */
export function appendRotatingLog(
  path: string,
  line: string,
  maxBytes = 5 * 1024 * 1024,
  archives = 3,
): void {
  if (maxBytes < 1 || archives < 1 || !Number.isInteger(archives))
    throw new Error("Invalid log limits");
  mkdirSync(dirname(path), { recursive: true });
  // Ordinary appends do not need a rotation lock. O_APPEND preserves concurrent
  // writes; a threshold race can overshoot by a few lines before the next rotation.
  let size = 0;
  try {
    size = statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (size + Buffer.byteLength(line) <= maxBytes) {
    appendFileSync(path, line, "utf8");
    return;
  }
  const lock = `${path}.rotate-lock`;
  let descriptor: number | undefined;
  try {
    try {
      descriptor = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Recover a lock left by an exited writer. Live writers keep ownership.
      try {
        const pid = Number(readFileSync(lock, "utf8"));
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code === "ESRCH") unlinkSync(lock);
          }
        } else if (Date.now() - statSync(lock).mtimeMs > 60_000) unlinkSync(lock);
      } catch {
        /* Another writer may have released it. */
      }
      // Append immediately; the next lock owner handles rotation. No event loss.
      appendFileSync(path, line, "utf8");
      return;
    }
    writeFileSync(descriptor, String(process.pid));
    if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > maxBytes) {
      try {
        if (existsSync(`${path}.${archives}`)) unlinkSync(`${path}.${archives}`);
        for (let i = archives - 1; i >= 1; i--) {
          if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
        }
        renameSync(path, `${path}.1`);
      } catch (error) {
        console.warn("Log rotation deferred; retaining new event", error);
      }
    }
    appendFileSync(path, line, "utf8");
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      unlinkSync(lock);
    }
  }
}
