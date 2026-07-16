import { describe, expect, test } from "bun:test";

import {
	isTransientAnilistError,
	withAnilistRetry,
} from "./anilist-rate-limit";

describe("AniList retries", () => {
	test("retries transient server failures", async () => {
		let attempts = 0;
		const waits: number[] = [];

		const result = await withAnilistRetry(
			async () => {
				attempts++;
				if (attempts === 1) throw new Error("Request failed with status 500");
				return "ok";
			},
			undefined,
			async (milliseconds) => waits.push(milliseconds),
		);

		expect(result).toBe("ok");
		expect(attempts).toBe(2);
		expect(waits).toEqual([1_000]);
	});

	test("does not retry permanent client failures", async () => {
		let attempts = 0;

		await expect(
			withAnilistRetry(
				async () => {
					attempts++;
					throw new Error("Request failed with status 400");
				},
				undefined,
				async () => undefined,
			),
		).rejects.toThrow("status 400");
		expect(attempts).toBe(1);
		expect(isTransientAnilistError("Request failed with status 503")).toBe(true);
	});
});
