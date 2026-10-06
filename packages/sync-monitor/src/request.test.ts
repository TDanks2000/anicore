import { describe, expect, test } from "bun:test";
import { withRequestDeadline } from "./request";

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("request deadline", () => {
  test("times out a stalled operation", async () => {
    await expect(withRequestDeadline(waitForAbort, undefined, 10)).rejects.toMatchObject({
      name: "TimeoutError",
      message: "Request timed out. Please try again.",
    });
  });

  test("preserves caller cancellation and its reason", async () => {
    const caller = new AbortController();
    const request = withRequestDeadline(waitForAbort, caller.signal);
    const reason = new Error("View changed");
    caller.abort(reason);
    await expect(request).rejects.toBe(reason);
  });

  test("does not start an operation that is already cancelled", async () => {
    const caller = new AbortController();
    caller.abort();
    let started = false;
    await expect(
      withRequestDeadline(async () => {
        started = true;
      }, caller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toBe(false);
  });

  test("releases timer and caller listener after success", async () => {
    const caller = new AbortController();
    let captured: AbortSignal | undefined;
    expect(
      await withRequestDeadline(
        async (signal) => {
          captured = signal;
          return 42;
        },
        caller.signal,
        10,
      ),
    ).toBe(42);
    caller.abort();
    await Bun.sleep(20);
    expect(captured!.aborted).toBe(false);
  });

  test("releases timer and caller listener after failure", async () => {
    const caller = new AbortController();
    let captured: AbortSignal | undefined;
    await expect(
      withRequestDeadline(
        async (signal) => {
          captured = signal;
          throw new Error("Network failure");
        },
        caller.signal,
        10,
      ),
    ).rejects.toThrow("Network failure");
    caller.abort();
    await Bun.sleep(20);
    expect(captured!.aborted).toBe(false);
  });

  test("rejects invalid deadlines", async () => {
    for (const timeout of [0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      await expect(
        withRequestDeadline(async () => true, undefined, timeout),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });
});
