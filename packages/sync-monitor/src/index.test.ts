import { describe, expect, test } from "bun:test";

import { SyncMonitorClient, SyncMonitorRequestError } from "./index";

describe("SyncMonitorClient", () => {
  test("keeps the deadline active when response headers arrive but the body stalls", async () => {
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init!.signal!;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const client = new SyncMonitorClient({
      baseUrl: "http://localhost:3000",
      accessCode: "test",
      timeoutMs: 10,
      fetcher,
    });
    await expect(client.getSnapshot()).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("includes API error details in rejected requests", async () => {
    const fetcher: typeof fetch = Object.assign(
      async () =>
        new Response(JSON.stringify({ error: "No active sync process to pause" }), {
          status: 409,
          statusText: "Conflict",
          headers: { "Content-Type": "application/json" },
        }),
      {
        preconnect: () => undefined,
      },
    );

    const client = new SyncMonitorClient({
      baseUrl: "http://localhost:3000",
      accessCode: "test-code",
      fetcher,
    });

    const error = await client.pause().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SyncMonitorRequestError);
    expect(error).toMatchObject({
      status: 409,
      statusText: "Conflict",
      detail: "No active sync process to pause",
      message: "Sync monitor request failed (409 Conflict): No active sync process to pause",
    });
  });

  test("reads the unified snapshot with an event limit", async () => {
    let requestedUrl = "";
    const fetcher: typeof fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ revision: "r1", events: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      { preconnect: () => undefined },
    );

    const client = new SyncMonitorClient({
      baseUrl: "http://localhost:3000/",
      accessCode: "test-code",
      fetcher,
    });

    const snapshot = await client.getSnapshot(25);
    expect(requestedUrl).toBe("http://localhost:3000/sync-monitor/snapshot?eventLimit=25");
    expect(snapshot.revision).toBe("r1");
  });
});
