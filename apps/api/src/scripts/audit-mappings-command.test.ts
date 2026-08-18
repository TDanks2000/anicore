import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { parseAuditCommandArgs } from "./audit-mappings-command";

const repoRoot = "/tmp/anicore";

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
    expect(
      parseAuditCommandArgs(["--write", "reports/mappings.json"], repoRoot),
    ).toEqual({
      auditArgs: [],
      writePath: resolve(repoRoot, "reports/mappings.json"),
    });
  });

  test("accepts --write=<path> and preserves unrelated arguments", () => {
    expect(
      parseAuditCommandArgs(
        ["--future-option", "--write=reports/mappings.json"],
        repoRoot,
      ),
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
