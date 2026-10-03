import { describe, expect, test } from "bun:test";

import { viewFromHash } from "./views";

describe("dashboard views", () => {
  test("resolves catalog links with or without a leading slash", () => {
    expect(viewFromHash("#/catalog")).toBe("catalog");
    expect(viewFromHash("#catalog")).toBe("catalog");
    expect(viewFromHash("#/catalog?page=2")).toBe("catalog");
  });

  test("anything else is the monitor", () => {
    expect(viewFromHash("")).toBe("monitor");
    expect(viewFromHash("#/monitor")).toBe("monitor");
    expect(viewFromHash("#/unknown")).toBe("monitor");
  });
});
