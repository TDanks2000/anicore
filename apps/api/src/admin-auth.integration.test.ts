import { afterEach, describe, expect, test } from "bun:test";

import { app } from "./app";

async function json(response: Response): Promise<unknown> {
	return response.json();
}

describe("global admin write guard", () => {
	afterEach(() => {
		delete process.env.ANICORE_ADMIN_TOKEN;
	});

	test("fails closed when the admin token is not configured", async () => {
		const response = await app.handle(
			new Request("http://localhost/anime/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ titleRomaji: "Protected write" }),
			}),
		);

		expect(response.status).toBe(503);
		expect(await json(response)).toEqual({
			error: "API writes are disabled until ANICORE_ADMIN_TOKEN is configured",
		});
	});

	test("rejects a valid write request with the wrong token", async () => {
		process.env.ANICORE_ADMIN_TOKEN = "test-admin-token";

		const response = await app.handle(
			new Request("http://localhost/anime/", {
				method: "POST",
				headers: {
					Authorization: "Bearer wrong-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ titleRomaji: "Protected write" }),
			}),
		);

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe(
			'Bearer realm="AniCore Admin"',
		);
		expect(await json(response)).toEqual({ error: "Invalid admin token" });
	});
});
