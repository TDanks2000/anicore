import { describe, expect, test } from "bun:test";

import { applyProviderEpisodeSegments } from "./segmented-source-mapping";

describe("applyProviderEpisodeSegments", () => {
	test("maps a provider suffix onto local episode numbering", () => {
		const episodes = Array.from({ length: 48 }, (_, index) => ({
			providerEpisodeNumber: String(index + 1),
			title: `Episode ${index + 1}`,
		}));

		const mapped = applyProviderEpisodeSegments(episodes, [
			{
				providerEpisodeStart: 25,
				providerEpisodeEnd: 48,
				localEpisodeStart: 1,
				localEpisodeEnd: 24,
			},
		]);

		expect(mapped).toHaveLength(24);
		expect(mapped[0]).toMatchObject({
			providerEpisodeNumber: "25",
			localEpisodeNumber: 1,
		});
		expect(mapped[23]).toMatchObject({
			providerEpisodeNumber: "48",
			localEpisodeNumber: 24,
		});
	});

	test("filters provider episodes outside explicit segments", () => {
		const mapped = applyProviderEpisodeSegments(
			[
				{ providerEpisodeNumber: "1" },
				{ providerEpisodeNumber: "2" },
				{ providerEpisodeNumber: "3" },
				{ providerEpisodeNumber: "4" },
			],
			[
				{
					providerEpisodeStart: 2,
					providerEpisodeEnd: 3,
					localEpisodeStart: 1,
					localEpisodeEnd: 2,
				},
			],
		);

		expect(mapped.map((episode) => episode.providerEpisodeNumber)).toEqual([
			"2",
			"3",
		]);
		expect(mapped.map((episode) => episode.localEpisodeNumber)).toEqual([1, 2]);
	});

	test("rejects overlapping provider ranges", () => {
		expect(() =>
			applyProviderEpisodeSegments([{ providerEpisodeNumber: "2" }], [
				{
					providerEpisodeStart: 1,
					providerEpisodeEnd: 2,
					localEpisodeStart: 1,
					localEpisodeEnd: 2,
				},
				{
					providerEpisodeStart: 2,
					providerEpisodeEnd: 3,
					localEpisodeStart: 3,
					localEpisodeEnd: 4,
				},
			]),
		).toThrow("overlapping provider ranges");
	});

	test("rejects overlapping local ranges", () => {
		expect(() =>
			applyProviderEpisodeSegments([{ providerEpisodeNumber: "1" }], [
				{
					providerEpisodeStart: 1,
					providerEpisodeEnd: 2,
					localEpisodeStart: 1,
					localEpisodeEnd: 2,
				},
				{
					providerEpisodeStart: 3,
					providerEpisodeEnd: 4,
					localEpisodeStart: 2,
					localEpisodeEnd: 3,
				},
			]),
		).toThrow("overlapping local ranges");
	});

	test("rejects malformed provider episode numbers", () => {
		expect(() =>
			applyProviderEpisodeSegments(
				[{ providerEpisodeNumber: "special" }],
				[
					{
						providerEpisodeStart: 1,
						providerEpisodeEnd: 1,
						localEpisodeStart: 1,
						localEpisodeEnd: 1,
					},
				],
			),
		).toThrow("invalid provider episode number");
	});
});
