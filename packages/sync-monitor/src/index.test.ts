import { describe, expect, test } from "bun:test";

import { SyncMonitorClient } from "./index";

describe("SyncMonitorClient", () => {
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

    await expect(client.pause()).rejects.toThrow(
      "Sync monitor request failed (409 Conflict): No active sync process to pause",
    );
  });
});
