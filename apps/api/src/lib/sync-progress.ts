import type { Progress } from "@anicore/providers/lib/cache";
import type { SyncStats } from "@anicore/providers/lib/sync-engine";

export interface SyncCheckpointState {
	firstFailedIndex: number | null;
	previousFailedCount: number;
}

export function createSyncCheckpointState(): SyncCheckpointState {
	return {
		firstFailedIndex: null,
		previousFailedCount: 0,
	};
}

export function advanceSyncCheckpoint(
	progress: Progress,
	stats: SyncStats,
	index: number,
	state: SyncCheckpointState,
): SyncCheckpointState {
	const firstFailedIndex =
		state.firstFailedIndex ??
		(stats.failed > state.previousFailedCount ? index : null);

	progress.lastIndex = firstFailedIndex ?? index + 1;
	progress.stats = stats;

	return {
		firstFailedIndex,
		previousFailedCount: stats.failed,
	};
}
