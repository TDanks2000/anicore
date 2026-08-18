export interface DerivedAirdateLanguageAssertion {
	languageCode: string;
	mediaType: "audio" | "subtitle";
}

/**
 * An AniList air date only establishes that an episode has aired. For Japanese
 * origin anime that is sufficient for a low-confidence original Japanese audio
 * assertion, but it is not evidence that an English subtitle track exists.
 */
export function derivedAirdateLanguageAssertions(
	countryOfOrigin: string | null | undefined,
): DerivedAirdateLanguageAssertion[] {
	return countryOfOrigin?.trim().toUpperCase() === "JP"
		? [{ languageCode: "ja", mediaType: "audio" }]
		: [];
}
