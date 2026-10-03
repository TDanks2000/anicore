import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("installed proxy fetch observes saved routing changes between requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anicore-proxy-routing-"));
  try {
    const script = `
      import { installProxyFetch, writeProxySettings } from "./packages/providers/src/lib/proxy.ts";
      const calls = [];
      globalThis.fetch = async (_, init) => { calls.push(init?.proxy ?? "direct"); return new Response("ok"); };
      installProxyFetch();
      const settings = { mode: "custom", url: "http://proxy.example:8080", noProxy: "", maxAttempts: 1, timeoutMs: 100 };
      writeProxySettings(settings);
      await fetch("https://example.com");
      writeProxySettings({ ...settings, mode: "direct" });
      await fetch("https://example.com");
      writeProxySettings({ ...settings, noProxy: "example.com" });
      await fetch("https://example.com");
      console.log(JSON.stringify(calls));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: new URL("../../../..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"),
      env: {
        ...process.env,
        ANICORE_PROXY_CONFIG_PATH: join(directory, "config.json"),
        ANICORE_PROXY_URL: "http://environment.example:8080",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual(["http://proxy.example:8080", "direct", "direct"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
