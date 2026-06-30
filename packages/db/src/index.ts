import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getDatabaseConfig } from "./db-config";
import * as schema from "./schema";

const databaseConfig = getDatabaseConfig();
const client = postgres(databaseConfig.url, { ssl: databaseConfig.ssl });

export const db = drizzle(client, { schema });

export type Db = typeof db;

export async function closeDb(): Promise<void> {
	await client.end();
}
