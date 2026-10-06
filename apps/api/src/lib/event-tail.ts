import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const CHUNK_BYTES = 64 * 1024;

/** Read only the newest nonempty lines, with a byte budget even for malformed logs. */
export function readEventTail(path: string, limit: number, maxLineBytes: number): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    let position = fstatSync(descriptor).size;
    let budget = (limit + 1) * (maxLineBytes + 1);
    const chunks: Buffer[] = [];
    let lines = 0;
    let nonempty = false;
    while (position > 0 && budget > 0) {
      const length = Math.min(position, budget, CHUNK_BYTES);
      position -= length;
      budget -= length;
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(descriptor, buffer, 0, length, position);
      const chunk = buffer.subarray(0, read);
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] !== 10) {
          nonempty = true;
        } else if (nonempty) {
          nonempty = false;
          if (++lines === limit) {
            return Buffer.concat([chunk.subarray(i + 1), ...chunks.reverse()]).toString("utf8");
          }
        }
      }
      chunks.push(chunk);
    }
    const tail = Buffer.concat(chunks.reverse());
    // Do not parse a fragment when the byte budget cuts through a line.
    const start = position > 0 ? tail.indexOf(10) + 1 : 0;
    if (position > 0 && start === 0) return "";
    return tail.subarray(start).toString("utf8");
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
