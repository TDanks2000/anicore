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

  test("data and logs have deep links", () => {
    expect(viewFromHash("#/data")).toBe("data");
    expect(viewFromHash("#data")).toBe("data");
    expect(viewFromHash("#/logs")).toBe("logs");
    expect(viewFromHash("#/logs?level=error")).toBe("logs");
  });

  test("review has a deep link", () => {
    expect(viewFromHash("#/review")).toBe("review");
    expect(viewFromHash("#review")).toBe("review");
    expect(viewFromHash("#/review?status=unknown")).toBe("review");
  });
});
