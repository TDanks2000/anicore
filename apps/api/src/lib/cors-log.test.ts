import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logCors, resolveCorsLogPath } from "./cors-log";

const absolute = join(tmpdir(), `anicore-cors-test-${process.pid}.log`);
process.env.ANICORE_CORS_LOG = absolute;

afterAll(() => rmSync(absolute, { force: true }));

describe("resolveCorsLogPath", () => {
  test("defaults to the API data logs directory", () => {
    const path = resolveCorsLogPath({});
    expect(path.endsWith(join("apps", "api", "data", "logs", "cors.log"))).toBe(true);
  });

  test("resolves a relative override against the working directory", () => {
    const path = resolveCorsLogPath({ ANICORE_CORS_LOG: "logs/cors.log" });
    expect(path).toBe(join(process.cwd(), "logs", "cors.log"));
  });

  test("keeps an absolute override as-is", () => {
    expect(resolveCorsLogPath({ ANICORE_CORS_LOG: absolute })).toBe(absolute);
  });
});

describe("logCors", () => {
  test("appends a timestamped line to the configured file", () => {
    logCors("[cors] ALLOWED GET /anime origin=http://localhost:5173 allowed=[]");
    const contents = readFileSync(absolute, "utf8");
    expect(contents).toContain("[cors] ALLOWED GET /anime origin=http://localhost:5173");
  });
});
