import { afterEach, describe, expect, test } from "bun:test";

import { authorizeAdminWrite, isAdminAuthenticated } from "./admin-auth";

describe("admin write authentication", () => {
	afterEach(() => {
		delete process.env.ANICORE_ADMIN_TOKEN;
	});

	test("allows read-only requests without an admin token", () => {
		expect(
			authorizeAdminWrite({
				method: "GET",
				pathname: "/anime/1",
				headers: {},
			}),
		).toEqual({ ok: true });
	});

	test("leaves sync monitor writes to the monitor access-code guard", () => {
		expect(
			authorizeAdminWrite({
				method: "POST",
				pathname: "/sync-monitor/control/pause",
				headers: {},
			}),
		).toEqual({ ok: true });
	});

	test("disables non-monitor writes when no admin token is configured", () => {
		expect(
			authorizeAdminWrite({
				method: "POST",
				pathname: "/anime/",
				headers: {},
			}),
		).toEqual({
			ok: false,
			status: 503,
			error: "API writes are disabled until ANICORE_ADMIN_TOKEN is configured",
		});
	});

	test("accepts bearer and explicit admin-token headers", () => {
		process.env.ANICORE_ADMIN_TOKEN = "test-admin-token";

		expect(
			authorizeAdminWrite({
				method: "PATCH",
				pathname: "/admin/anime/1/language-override",
				headers: { authorization: "Bearer test-admin-token" },
			}),
		).toEqual({ ok: true });

		expect(
			authorizeAdminWrite({
				method: "DELETE",
				pathname: "/future-admin-route",
				headers: { "x-anicore-admin-token": "test-admin-token" },
			}),
		).toEqual({ ok: true });
	});

	test("exposes a boolean admin check without converting public reads into write auth failures", () => {
		expect(isAdminAuthenticated({})).toBe(false);

		process.env.ANICORE_ADMIN_TOKEN = "test-admin-token";
		expect(
			isAdminAuthenticated({ authorization: "Bearer wrong-token" }),
		).toBe(false);
		expect(
			isAdminAuthenticated({ authorization: "Bearer test-admin-token" }),
		).toBe(true);
		expect(
			isAdminAuthenticated({
				"x-anicore-admin-token": "test-admin-token",
			}),
		).toBe(true);
	});

	test("rejects invalid admin tokens", () => {
		process.env.ANICORE_ADMIN_TOKEN = "test-admin-token";

		expect(
			authorizeAdminWrite({
				method: "POST",
				pathname: "/episodes/",
				headers: { authorization: "Bearer wrong-token" },
			}),
		).toEqual({ ok: false, status: 401, error: "Invalid admin token" });
	});
});
