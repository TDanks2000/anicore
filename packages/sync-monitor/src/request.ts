export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Keep the deadline active through body consumption, then release timer/listener. */
export async function withRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Request timeout must be between 1 and 2147483647 milliseconds");
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Request timed out. Please try again.", "TimeoutError"));
  }, timeoutMs);
  try {
    controller.signal.throwIfAborted();
    const result = await operation(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
