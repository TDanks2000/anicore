import { describe, expect, test } from "bun:test";

import { parseIntegerFlag, selectSyncIds } from "./sync-cli";

describe("sync ID selection", () => {
  test("new IDs exclude database IDs before limits and sort numerically", () => {
    const ids = [10, 2, 100, 1];
    expect(selectSyncIds(ids, new Set([2, 10]), true, false)).toEqual([1, 100]);
    expect(selectSyncIds(ids, new Set([2, 10]), true, true)).toEqual([100, 1]);
    expect(selectSyncIds(ids, new Set([2, 10]), false, true)).toEqual([100, 10, 2, 1]);
    expect(ids).toEqual([10, 2, 100, 1]);
    expect(selectSyncIds(ids, new Set(ids), true, true)).toEqual([]);
  });
});

describe("sync CLI integer flags", () => {
  test("returns undefined when a flag is absent", () => {
    expect(parseIntegerFlag([], "--limit=", 1)).toBeUndefined();
  });

  test("parses positive and non-negative integers", () => {
    expect(parseIntegerFlag(["--limit=25"], "--limit=", 1)).toBe(25);
    expect(parseIntegerFlag(["--from-index=0"], "--from-index=", 0)).toBe(0);
  });

  test("rejects malformed numbers instead of partially parsing them", () => {
    expect(() => parseIntegerFlag(["--limit=abc"], "--limit=", 1)).toThrow(
      "--limit must be a positive integer",
    );
    expect(() => parseIntegerFlag(["--limit=10abc"], "--limit=", 1)).toThrow(
      "--limit must be a positive integer",
    );
    expect(() => parseIntegerFlag(["--limit=1.5"], "--limit=", 1)).toThrow(
      "--limit must be a positive integer",
    );
  });

  test("enforces each flag's lower bound", () => {
    expect(() => parseIntegerFlag(["--limit=0"], "--limit=", 1)).toThrow(
      "--limit must be a positive integer",
    );
    expect(() => parseIntegerFlag(["--from-index=-1"], "--from-index=", 0)).toThrow(
      "--from-index must be a non-negative integer",
    );
  });
});
