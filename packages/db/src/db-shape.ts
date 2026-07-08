export const expectedTables = [
  "anime",
  "anime_external_links",
  "anime_language_evidence",
  "anime_language_status",
  "anime_mappings",
  "anime_relation_links",
  "anime_studio_links",
  "anime_tag_links",
  "episode_language_status",
  "episode_mappings",
  "episodes",
  "studios",
  "sync_runs",
  "tags",
] as const;

export const legacyTables = [
  "anime_studios",
  "anime_tags",
  "episode_audio_status",
] as const;

export const expectedIndexes = [
  { tableName: "anime_mappings", indexName: "anime_mappings_provider_id_idx" },
  { tableName: "anime_language_status", indexName: "anime_language_status_anime_language_media_idx" },
  { tableName: "episode_language_status", indexName: "episode_language_status_anime_episode_language_media_idx" },
  { tableName: "anime_studio_links", indexName: "anime_studio_links_anime_studio_idx" },
  { tableName: "anime_tag_links", indexName: "anime_tag_links_anime_tag_idx" },
  { tableName: "episode_mappings", indexName: "episode_mappings_provider_episode_id_idx" },
  { tableName: "studios", indexName: "studios_anilist_id_idx" },
  { tableName: "studios", indexName: "studios_normalized_name_idx" },
  { tableName: "tags", indexName: "tags_normalized_name_idx" },
] as const;

export interface TableMetadata {
  tableName: string;
}

export interface IndexMetadata {
  tableName: string;
  indexName: string;
}

export interface MissingIndex {
  tableName: string;
  indexName: string;
}

export interface DbShapeReport {
  ok: boolean;
  expectedTablesPresent: string[];
  missingTables: string[];
  presentLegacyTables: string[];
  expectedIndexesPresent: Array<{ tableName: string; indexName: string }>;
  missingIndexes: MissingIndex[];
}

export function analyzeDbShape(
  tableRows: TableMetadata[],
  indexRows: IndexMetadata[],
): DbShapeReport {
  const tableNames = new Set(tableRows.map((row) => row.tableName));
  const indexKeys = new Set(
    indexRows.map((row) => `${row.tableName}:${row.indexName}`),
  );

  const expectedTablesPresent = expectedTables.filter((tableName) =>
    tableNames.has(tableName),
  );
  const missingTables = expectedTables.filter(
    (tableName) => !tableNames.has(tableName),
  );
  const presentLegacyTables = legacyTables.filter((tableName) =>
    tableNames.has(tableName),
  );

  const expectedIndexesPresent = expectedIndexes.filter(({ tableName, indexName }) =>
    indexKeys.has(`${tableName}:${indexName}`),
  );
  const missingIndexes = expectedIndexes.filter(
    ({ tableName, indexName }) => !indexKeys.has(`${tableName}:${indexName}`),
  );

  return {
    ok:
      missingTables.length === 0 &&
      presentLegacyTables.length === 0 &&
      missingIndexes.length === 0,
    expectedTablesPresent: [...expectedTablesPresent],
    missingTables: [...missingTables],
    presentLegacyTables: [...presentLegacyTables],
    expectedIndexesPresent: [...expectedIndexesPresent],
    missingIndexes: [...missingIndexes],
  };
}
