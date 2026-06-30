import { describe, expect, test } from "bun:test";

import {
  analyzeDbShape,
  expectedIndexes,
  expectedTables,
  legacyTables,
} from "./db-shape";

describe("analyzeDbShape", () => {
  test("passes when normalized tables and key indexes are present", () => {
    const report = analyzeDbShape(
      expectedTables.map((tableName) => ({ tableName })),
      expectedIndexes.map(({ tableName, indexName }) => ({ tableName, indexName })),
    );

    expect(report.ok).toBe(true);
    expect(report.missingTables).toEqual([]);
    expect(report.presentLegacyTables).toEqual([]);
    expect(report.missingIndexes).toEqual([]);
  });

  test("fails when legacy studio or tag tables remain", () => {
    const report = analyzeDbShape(
      [
        ...expectedTables.map((tableName) => ({ tableName })),
        ...legacyTables.map((tableName) => ({ tableName })),
      ],
      expectedIndexes.map(({ tableName, indexName }) => ({ tableName, indexName })),
    );

    expect(report.ok).toBe(false);
    expect(report.presentLegacyTables).toEqual(["anime_studios", "anime_tags"]);
  });

  test("fails when normalized join tables or indexes are missing", () => {
    const report = analyzeDbShape(
      expectedTables
        .filter((tableName) => tableName !== "anime_studio_links")
        .map((tableName) => ({ tableName })),
      expectedIndexes
        .filter(
          ({ indexName }) => indexName !== "anime_studio_links_anime_studio_idx",
        )
        .map(({ tableName, indexName }) => ({ tableName, indexName })),
    );

    expect(report.ok).toBe(false);
    expect(report.missingTables).toContain("anime_studio_links");
    expect(report.missingIndexes).toContainEqual({
      tableName: "anime_studio_links",
      indexName: "anime_studio_links_anime_studio_idx",
    });
  });
});
