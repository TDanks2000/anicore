import { describe, expect, test } from "bun:test";

import { parseRepairMappingsArgs } from "./repair-mappings-cli";

describe("parseRepairMappingsArgs", () => {
  test("defaults to dry-run", () => {
    expect(parseRepairMappingsArgs([])).toEqual({ mode: "dry-run" });
  });

  test("accepts explicit dry-run", () => {
    expect(parseRepairMappingsArgs(["--dry-run"])).toEqual({ mode: "dry-run" });
  });

  test("requires explicit apply mode for writes", () => {
    expect(parseRepairMappingsArgs(["--apply"])).toEqual({ mode: "apply" });
  });

  test("rejects conflicting modes", () => {
    expect(() => parseRepairMappingsArgs(["--dry-run", "--apply"])).toThrow(
      "--dry-run and --apply cannot be used together",
    );
  });

  test("rejects unknown arguments", () => {
    expect(() => parseRepairMappingsArgs(["--force"])).toThrow(
      "Unknown db:repair-mappings argument: --force",
    );
  });
});
