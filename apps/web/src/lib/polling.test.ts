import { describe, expect, test } from "bun:test";

import { nextPollDelay, type PollTiming } from "./polling";

const timing: PollTiming = { activeMs: 2500, idleMs: 5000, maxBackoffMs: 20_000 };

describe("nextPollDelay", () => {
  test("polls fast while active and slower while idle", () => {
    expect(nextPollDelay(0, true, timing)).toBe(2500);
    expect(nextPollDelay(0, false, timing)).toBe(5000);
  });

  test("backs off exponentially on consecutive failures", () => {
    expect(nextPollDelay(1, true, timing)).toBe(5000);
    expect(nextPollDelay(2, true, timing)).toBe(10_000);
    expect(nextPollDelay(3, true, timing)).toBe(20_000);
  });

  test("caps backoff at the configured maximum", () => {
    expect(nextPollDelay(20, true, timing)).toBe(20_000);
    expect(nextPollDelay(20, false, timing)).toBe(20_000);
  });
});
