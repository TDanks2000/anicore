import { drizzle } from "drizzle-orm/postgres-js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

import { getDatabaseConfig } from "./db-config";
import * as providerMappingSchema from "./provider-mapping-schema";
import * as coreSchema from "./schema";

const SYNC_LEASE_HEARTBEAT_MS = 60_000;
const SYNC_LEASE_STALE_MINUTES = 5;

const schema = {
	...coreSchema,
	...providerMappingSchema,
};

type PostgresClient = ReturnType<typeof postgres>;

let clientInstance: PostgresClient | null = null;
let dbInstance: ReturnType<typeof createDb> | null = null;

function getClient(): PostgresClient {
	if (!clientInstance) {
		const databaseConfig = getDatabaseConfig();
		clientInstance = postgres(databaseConfig.url, { ssl: databaseConfig.ssl });
	}
	return clientInstance;
}

function createDb() {
	return drizzle(getClient(), { schema });
}

function getDb(): ReturnType<typeof createDb> {
	if (!dbInstance) {
		dbInstance = createDb();
	}
	return dbInstance;
}

/**
 * Validates database configuration without opening a connection.
 *
 * The client is created lazily so that importing this module stays free of
 * side effects — otherwise any module that transitively imports `@anicore/db`
 * would require DATABASE_URL, including unit tests of pure helpers. Long-lived
 * entrypoints call this at startup to keep the original fail-fast behaviour.
 */
export function assertDatabaseConfigured(): void {
	getDatabaseConfig();
}

export const db = new Proxy({} as ReturnType<typeof createDb>, {
	get(_target, property) {
		const instance = getDb() as unknown as Record<string | symbol, unknown>;
		const value = instance[property];
		return typeof value === "function" ? value.bind(instance) : value;
	},
	has(_target, property) {
		return property in (getDb() as object);
	},
});

export type Db = typeof db;
export interface SyncLease {
	release(succeeded?: boolean): Promise<void>;
}

export async function tryAcquireSyncLease(): Promise<SyncLease | null> {
	const client = getClient();
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
	if (!clientInstance) return;
	await clientInstance.end();
	clientInstance = null;
	dbInstance = null;
}
