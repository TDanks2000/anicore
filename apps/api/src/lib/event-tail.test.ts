import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEventTail } from "./event-tail";

const directory = mkdtempSync(join(tmpdir(), "anicore-event-tail-"));
const path = join(directory, "events.jsonl");
afterEach(() => rmSync(path, { force: true }));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("bounded event tails", () => {
  test("matches the previous line selection across chunks, unicode and blank lines", () => {
    const lines = Array.from({ length: 4000 }, (_, id) =>
      JSON.stringify({ id, message: "日本語".repeat(20) }),
    );
    writeFileSync(path, `${lines.join("\n\n")}\n\n`);
    for (const limit of [1, 80, 500]) {
      const expected = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-limit);
      expect(
        readEventTail(path, limit, 16 * 1024)
          .split("\n")
          .filter(Boolean),
      ).toEqual(expected);
    }
  });

  test("retains an unterminated final line and handles a short file", () => {
    writeFileSync(path, 'first\n\n{"partial":');
    expect(readEventTail(path, 1, 16 * 1024)).toBe('{"partial":');
    expect(readEventTail(path, 10, 16 * 1024)).toBe('first\n\n{"partial":');
  });

  test("bounds a huge malformed tail and never returns a cut-off JSON fragment", () => {
    writeFileSync(path, `${"x".repeat(1_000_000)}\n{"id":2}\n`);
    expect(readEventTail(path, 2, 128)).toBe('{"id":2}\n');
    writeFileSync(path, "x".repeat(1_000_000));
    expect(readEventTail(path, 2, 128)).toBe("");
  });

  test("missing files remain an empty event history", () => {
    expect(readEventTail(path, 10, 128)).toBe("");
  });
});
