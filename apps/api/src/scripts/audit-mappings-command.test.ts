import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  parseAuditCommandArgs,
  parseAuditReportOutput,
  writeAuditReport,
} from "./audit-mappings-command";

const repoRoot = "/tmp/anicore";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("parseAuditCommandArgs", () => {
  test("keeps the normal audit command unchanged without --write", () => {
    expect(parseAuditCommandArgs([], repoRoot)).toEqual({
      auditArgs: [],
      writePath: null,
    });
  });

  test("writes to mapping-audit.json at the repository root by default", () => {
    expect(parseAuditCommandArgs(["--write"], repoRoot)).toEqual({
      auditArgs: [],
      writePath: resolve(repoRoot, "mapping-audit.json"),
    });
  });

  test("accepts a path after --write", () => {
    expect(parseAuditCommandArgs(["--write", "reports/mappings.json"], repoRoot)).toEqual({
      auditArgs: [],
      writePath: resolve(repoRoot, "reports/mappings.json"),
    });
  });

  test("accepts --write=<path> and preserves unrelated arguments", () => {
    expect(
      parseAuditCommandArgs(["--future-option", "--write=reports/mappings.json"], repoRoot),
    ).toEqual({
      auditArgs: ["--future-option"],
      writePath: resolve(repoRoot, "reports/mappings.json"),
    });
  });

  test("rejects an empty --write= path", () => {
    expect(() => parseAuditCommandArgs(["--write="], repoRoot)).toThrow(
      "--write= requires a non-empty file path",
    );
  });
});

describe("parseAuditReportOutput", () => {
  test("accepts a successful report", () => {
    const report = { ok: true, generatedAt: "2026-09-06T12:00:00.000Z", findings: [] };
    expect(parseAuditReportOutput(JSON.stringify(report))).toEqual(report);
  });

  test("accepts a report with findings even when ok is false", () => {
    const report = parseAuditReportOutput(
      JSON.stringify({
        ok: false,
        generatedAt: "2026-09-06T12:00:00.000Z",
        findings: [{ code: "mapping.issue" }],
        summary: { error: 1, warning: 0, info: 0 },
      }),
    );

    expect(report).toEqual({
      ok: false,
      generatedAt: "2026-09-06T12:00:00.000Z",
      findings: [{ code: "mapping.issue" }],
      summary: { error: 1, warning: 0, info: 0 },
    });
  });

  test.each([
    "",
    "null",
    "[]",
    "not json",
    JSON.stringify({ ok: false, error: "database unavailable" }),
    JSON.stringify({ ok: "false", generatedAt: "now", findings: [] }),
    JSON.stringify({ ok: false, generatedAt: "now", findings: {} }),
  ])("rejects malformed or error-only output: %s", (output) => {
    expect(parseAuditReportOutput(output)).toBeNull();
  });
});

describe("writeAuditReport", () => {
  test("preserves an existing report when output is invalid", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "anicore-audit-"));
    temporaryDirectories.push(directory);
    const reportPath = resolve(directory, "mapping-audit.json");
    await writeFile(reportPath, "previous report\n");

    expect(
      await writeAuditReport(reportPath, JSON.stringify({ ok: false, error: "audit crashed" })),
    ).toBe(false);
    expect(await readFile(reportPath, "utf8")).toBe("previous report\n");
  });

  test("writes a valid report", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "anicore-audit-"));
    temporaryDirectories.push(directory);
    const reportPath = resolve(directory, "nested/mapping-audit.json");
    const output = JSON.stringify({
      ok: false,
      generatedAt: "2026-09-06T12:00:00.000Z",
      findings: [{ code: "mapping.issue" }],
      summary: { error: 1, warning: 0, info: 0 },
    });

    expect(await writeAuditReport(reportPath, output)).toBe(true);
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
      ok: false,
      generatedAt: "2026-09-06T12:00:00.000Z",
      findings: [{ code: "mapping.issue" }],
      summary: { error: 1, warning: 0, info: 0 },
    });
  });
});
