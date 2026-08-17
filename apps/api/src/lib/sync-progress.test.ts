import { describe, expect, test } from "bun:test";

import type { Progress } from "@anicore/providers/lib/cache";
import {
	advanceSyncCheckpoint,
	createSyncCheckpointState,
} from "./sync-progress";

describe("sync progress checkpointing", () => {
	test("holds the checkpoint at the first failed index", () => {
		const progress: Progress = {
			version: 1,
			lastIndex: 0,
			stats: { created: 0, updated: 0, failed: 0 },
		};
		let state = createSyncCheckpointState();

		state = advanceSyncCheckpoint(
			progress,
			{ created: 0, updated: 1, failed: 0 },
			0,
			state,
		);
		expect(progress.lastIndex).toBe(1);

		state = advanceSyncCheckpoint(
			progress,
			{ created: 0, updated: 1, failed: 1 },
			1,
			state,
		);
		expect(progress.lastIndex).toBe(1);
		expect(state.firstFailedIndex).toBe(1);

		state = advanceSyncCheckpoint(
			progress,
			{ created: 0, updated: 2, failed: 1 },
			2,
			state,
		);
		expect(progress.lastIndex).toBe(1);
		expect(progress.stats).toEqual({ created: 0, updated: 2, failed: 1 });
	});
});
