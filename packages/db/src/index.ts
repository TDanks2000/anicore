import { drizzle } from "drizzle-orm/postgres-js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

import { getDatabaseConfig } from "./db-config";
import * as schema from "./schema";

const databaseConfig = getDatabaseConfig();
const client = postgres(databaseConfig.url, { ssl: databaseConfig.ssl });
const SYNC_LEASE_HEARTBEAT_MS = 60_000;
const SYNC_LEASE_STALE_MINUTES = 5;

export const db = drizzle(client, { schema });

export type Db = typeof db;

export interface SyncLease {
	release(succeeded?: boolean): Promise<void>;
}

export async function tryAcquireSyncLease(): Promise<SyncLease | null> {
	const token = randomUUID();
	const heartbeatAt = new Date().toISOString();
	const leaseId = await client.begin(async (sql) => {
		await sql`LOCK TABLE sync_runs IN EXCLUSIVE MODE`;
		await sql`
			UPDATE sync_runs
			SET status = 'failed',
				finished_at = NOW(),
				error_message = 'Recovered stale sync lease'
			WHERE provider = 'anilist'
				AND kind = 'full'
				AND status = 'running'
				AND COALESCE(
					(metadata_json::jsonb ->> 'heartbeatAt')::timestamptz,
					started_at
				) < NOW() - (${SYNC_LEASE_STALE_MINUTES} * INTERVAL '1 minute')
		`;
		const active = await sql<{ id: number }[]>`
			SELECT id
			FROM sync_runs
			WHERE provider = 'anilist'
				AND kind = 'full'
				AND status = 'running'
			LIMIT 1
		`;
		if (active.length > 0) return null;

		const inserted = await sql<{ id: number }[]>`
			INSERT INTO sync_runs (provider, kind, status, metadata_json)
			VALUES (
				'anilist',
				'full',
				'running',
				${JSON.stringify({ leaseToken: token, heartbeatAt })}
			)
			RETURNING id
		`;
		return inserted[0]?.id ?? null;
	});

	if (leaseId === null) return null;

	const heartbeat = setInterval(() => {
		void client`
			UPDATE sync_runs
			SET metadata_json = jsonb_set(
				metadata_json::jsonb,
				'{heartbeatAt}',
				to_jsonb(NOW()::text)
			)::text
			WHERE id = ${leaseId}
				AND status = 'running'
		`.catch((error) =>
			console.error(
				JSON.stringify({
					event: "sync.lease_heartbeat.failed",
					err: error instanceof Error ? error.message : String(error),
				}),
			),
		);
	}, SYNC_LEASE_HEARTBEAT_MS);
	heartbeat.unref?.();

	let released = false;
	return {
		async release(succeeded = true): Promise<void> {
			if (released) return;
			released = true;
			clearInterval(heartbeat);
			await client`
				UPDATE sync_runs
				SET status = ${succeeded ? "success" : "failed"},
					finished_at = NOW(),
					error_message = ${succeeded ? null : "Sync process failed"}
				WHERE id = ${leaseId}
					AND status = 'running'
			`;
		},
	};
}

export async function closeDb(): Promise<void> {
	await client.end();
}
