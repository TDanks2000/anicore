import { describe, expect, test } from "bun:test";

import { derivedAirdateLanguageAssertions } from "./derived-airdate-language";

describe("derived air-date language evidence", () => {
	test("derives only original Japanese audio for Japanese-origin anime", () => {
		expect(derivedAirdateLanguageAssertions("JP")).toEqual([
		{ languageCode: "ja", mediaType: "audio" },
	]);
		expect(derivedAirdateLanguageAssertions(" jp ")).toEqual([
		{ languageCode: "ja", mediaType: "audio" },
	]);
	});

	test("does not invent English subtitle availability from an air date", () => {
		expect(
			derivedAirdateLanguageAssertions("JP").some(
				(assertion) =>
					assertion.languageCode === "en" &&
					assertion.mediaType === "subtitle",
			),
		).toBe(false);
	});

	test("does not assume Japanese audio for non-Japanese or unknown origin", () => {
		expect(derivedAirdateLanguageAssertions("CN")).toEqual([]);
		expect(derivedAirdateLanguageAssertions("KR")).toEqual([]);
		expect(derivedAirdateLanguageAssertions(null)).toEqual([]);
	});
});
