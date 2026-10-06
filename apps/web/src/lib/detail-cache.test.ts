import { describe, expect, test } from "bun:test";
import { DetailCache } from "./detail-cache";

describe("detail cache", () => {
  test("catalogue pages use their own limits and refreshing invalidates every page", () => {
    const cache = new DetailCache<number>(30_000, 2);
    cache.set("server#page1", 1, 1000);
    cache.set("server#page2", 2, 1000);
    expect(cache.get("server#page1", 30_999)?.fresh).toBe(true);
    expect(cache.get("server#page1", 31_000)?.fresh).toBe(false);
    cache.set("server#page3", 3, 31_000);
    expect(cache.get("server#page2", 31_000)).toBeUndefined();
    cache.invalidateAll();
    expect(cache.get("server#page1", 31_000)).toEqual({ value: 1, fresh: false });
    expect(cache.get("server#page3", 31_000)).toEqual({ value: 3, fresh: false });
  });
  test("expires without losing the last good result; refresh restores freshness", () => {
    const cache = new DetailCache<string>();
    cache.set("server#1", "old", 1000);
    expect(cache.get("server#1", 60_999)).toEqual({ value: "old", fresh: true });
    expect(cache.get("server#1", 61_000)).toEqual({ value: "old", fresh: false });
    cache.set("server#1", "new", 61_000);
    expect(cache.get("server#1", 61_001)).toEqual({ value: "new", fresh: true });
    cache.invalidate("server#1");
    expect(cache.get("server#1", 61_002)).toEqual({ value: "new", fresh: false });
  });

  test("evicts the least recently used entry and separates servers", () => {
    const cache = new DetailCache<number>();
    for (let i = 0; i < 50; i++) cache.set(`server#${i}`, i);
    cache.get("server#0");
    cache.set("other-server#0", 100);
    expect(cache.get("server#1")).toBeUndefined();
    expect(cache.get("server#0")?.value).toBe(0);
    expect(cache.get("other-server#0")?.value).toBe(100);
    cache.delete("server#0");
    expect(cache.get("server#0")).toBeUndefined();
  });
});
