import {
	localSegmentsOverlap,
	mapProviderEpisodeToLocal,
	providerSegmentsOverlap,
	validateProviderEpisodeSegment,
	type ProviderEpisodeSegment,
} from "@anicore/db/provider-segments";

export interface SegmentedProviderEpisode {
	providerEpisodeNumber: string;
}

export type SegmentedProviderEpisodeMatch<T extends SegmentedProviderEpisode> = T & {
	localEpisodeNumber: number;
};

function validatedSegments(
	segments: ProviderEpisodeSegment[],
): ProviderEpisodeSegment[] {
	if (segments.length === 0) {
		throw new Error("Segmented provider mapping has no explicit segments");
	}

	const sorted = [...segments].sort(
		(a, b) =>
			a.providerEpisodeStart - b.providerEpisodeStart ||
			a.localEpisodeStart - b.localEpisodeStart,
	);

	for (const segment of sorted) {
		const validation = validateProviderEpisodeSegment(segment);
		if (!validation.ok) {
			throw new Error(
				`Invalid provider segment (${validation.reason ?? "unknown"}): ${segment.providerEpisodeStart}-${segment.providerEpisodeEnd} -> ${segment.localEpisodeStart}-${segment.localEpisodeEnd}`,
			);
		}
	}

	for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
			const left = sorted[leftIndex]!;
			const right = sorted[rightIndex]!;
			if (providerSegmentsOverlap(left, right)) {
				throw new Error("Segmented provider mapping has overlapping provider ranges");
			}
			if (localSegmentsOverlap(left, right)) {
				throw new Error("Segmented provider mapping has overlapping local ranges");
			}
		}
	}

	return sorted;
}

export function applyProviderEpisodeSegments<T extends SegmentedProviderEpisode>(
	episodes: T[],
	segments: ProviderEpisodeSegment[],
): Array<SegmentedProviderEpisodeMatch<T>> {
	const validSegments = validatedSegments(segments);
	const seenProviderNumbers = new Set<number>();
	const seenLocalNumbers = new Set<number>();
	const result: Array<SegmentedProviderEpisodeMatch<T>> = [];

	for (const episode of episodes) {
		const providerEpisodeNumber = Number(episode.providerEpisodeNumber);
		if (!Number.isInteger(providerEpisodeNumber) || providerEpisodeNumber <= 0) {
			throw new Error(
				`Segmented provider mapping received invalid provider episode number: ${episode.providerEpisodeNumber}`,
			);
		}
		if (seenProviderNumbers.has(providerEpisodeNumber)) {
			throw new Error(
				`Segmented provider mapping received duplicate provider episode number: ${providerEpisodeNumber}`,
			);
		}
		seenProviderNumbers.add(providerEpisodeNumber);

		let localEpisodeNumber: number | null = null;
		for (const segment of validSegments) {
			const mapped = mapProviderEpisodeToLocal(segment, providerEpisodeNumber);
			if (mapped === null) continue;
			if (localEpisodeNumber !== null) {
				throw new Error(
					`Provider episode ${providerEpisodeNumber} matched multiple explicit segments`,
				);
			}
			localEpisodeNumber = mapped;
		}
		if (localEpisodeNumber === null) continue;

		if (seenLocalNumbers.has(localEpisodeNumber)) {
			throw new Error(
				`Segmented provider mapping maps multiple provider episodes to local episode ${localEpisodeNumber}`,
			);
		}
		seenLocalNumbers.add(localEpisodeNumber);
		result.push({ ...episode, localEpisodeNumber });
	}

	return result.sort(
		(a, b) =>
			a.localEpisodeNumber - b.localEpisodeNumber ||
			Number(a.providerEpisodeNumber) - Number(b.providerEpisodeNumber),
	);
}
