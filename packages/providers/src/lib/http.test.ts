import { describe, expect, test } from "bun:test";

import { formatHttpError } from "./http";

describe("formatHttpError", () => {
  test("includes structured JSON error details", async () => {
    const response = new Response(
      JSON.stringify({ errors: [{ message: "field is invalid" }] }),
      {
        status: 422,
        statusText: "Unprocessable Entity",
        headers: { "Content-Type": "application/json" },
      },
    );

    await expect(formatHttpError("provider failed", response)).resolves.toBe(
      "provider failed: 422 Unprocessable Entity: field is invalid",
    );
  });

  test("includes plain text error details", async () => {
    const response = new Response("temporarily unavailable", {
      status: 503,
      statusText: "Service Unavailable",
    });

    await expect(formatHttpError("provider failed", response)).resolves.toBe(
      "provider failed: 503 Service Unavailable: temporarily unavailable",
    );
  });
});
