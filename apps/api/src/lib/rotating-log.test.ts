import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRotatingLog } from "./rotating-log";

test("rotation bounds archives and retains newest complete lines", () => {
  const directory = mkdtempSync(join(tmpdir(), "anicore-log-test-"));
  try {
    const path = join(directory, "events.jsonl");
    for (let i = 0; i < 20; i++) appendRotatingLog(path, `${i}\n`, 8, 2);
    expect(readdirSync(directory).sort()).toEqual([
      "events.jsonl",
      "events.jsonl.1",
      "events.jsonl.2",
    ]);
    expect(readFileSync(path, "utf8")).toContain("19\n");
    expect(readFileSync(`${path}.1`, "utf8").endsWith("\n")).toBe(true);
    writeFileSync(`${path}.rotate-lock`, String(process.pid));
    appendRotatingLog(path, "live writer\n", 8, 2);
    expect(readFileSync(path, "utf8")).toContain("live writer\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
