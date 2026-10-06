import { describe, expect, test } from "bun:test";
import { benchmarkApi, benchmarkOptions } from "./benchmark-api";

describe("API benchmark", () => {
  test("bounds concurrency and rejects paths that escape the selected server", () => {
    expect(() => benchmarkOptions(["--concurrency=1000"])).toThrow();
    expect(() => benchmarkOptions(["--requests=0"])).toThrow();
    expect(() => benchmarkOptions(["--path=//other-host/anime"])).toThrow();
    expect(() => benchmarkOptions(["--base-url=http://user:secret@localhost"])).toThrow();
  });

  test("consumes responses, observes concurrency, and keeps failed requests out of latency percentiles", async () => {
    let active = 0;
    let maximum = 0;
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(request.method).toBe("GET");
        const number = ++requests;
        maximum = Math.max(maximum, ++active);
        await Bun.sleep(10);
        active--;
        return new Response("payload", { status: number === 3 ? 503 : 200 });
      },
    });
    try {
      const options = benchmarkOptions([
        `--base-url=http://localhost:${server.port}`,
        "--requests=8",
        "--concurrency=2",
        "--warmup=1",
        "--path=/anime",
      ]);
      const reports = await benchmarkApi(options);
      expect(requests).toBe(9);
      expect(maximum).toBe(2);
      expect(reports[0]).toMatchObject({
        requests: 8,
        successes: 7,
        failures: 1,
        statuses: { "200": 7, "503": 1 },
        bytes: 56,
      });
      expect(reports[0]?.p50Ms).toBeGreaterThan(0);
    } finally {
      await server.stop(true);
    }
  });
});
