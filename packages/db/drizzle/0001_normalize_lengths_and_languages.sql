-- Kitsu's GraphQL API reports episode lengths in seconds, and earlier syncs
-- stored them unchanged as minutes. Kitsu was the only automatic writer of
-- this column, so every Kitsu-mapped length is a seconds value.
UPDATE `episodes`
SET `length_minutes` = max(1, cast(round(`length_minutes` / 60.0) as integer))
WHERE `length_minutes` IS NOT NULL
  AND `id` IN (SELECT `episode_id` FROM `episode_mappings` WHERE `provider` = 'kitsu');
--> statement-breakpoint
-- Language codes are now keyed by their primary subtag (pt-br -> pt). Fold
-- existing regional rows into their base language. Statuses are recomputed
-- by the next language sync; a base row that already exists wins.
UPDATE `anime_language_evidence`
SET `language_code` = substr(`language_code`, 1, instr(`language_code`, '-') - 1)
WHERE instr(`language_code`, '-') > 1;
--> statement-breakpoint
DELETE FROM `anime_language_status`
WHERE instr(`language_code`, '-') > 1
  AND `is_manual_override` = 0
  AND EXISTS (
    SELECT 1 FROM `anime_language_status` AS `base`
    WHERE `base`.`anime_id` = `anime_language_status`.`anime_id`
      AND `base`.`media_type` = `anime_language_status`.`media_type`
      AND `base`.`language_code` = substr(`anime_language_status`.`language_code`, 1, instr(`anime_language_status`.`language_code`, '-') - 1)
  );
--> statement-breakpoint
UPDATE OR IGNORE `anime_language_status`
SET `language_code` = substr(`language_code`, 1, instr(`language_code`, '-') - 1)
WHERE instr(`language_code`, '-') > 1;
--> statement-breakpoint
UPDATE OR IGNORE `episode_language_status`
SET `language_code` = substr(`language_code`, 1, instr(`language_code`, '-') - 1)
WHERE instr(`language_code`, '-') > 1;
--> statement-breakpoint
DELETE FROM `episode_language_status`
WHERE instr(`language_code`, '-') > 1 AND `provider` <> 'manual';
--> statement-breakpoint
-- Sync-created cross-references were never elected primary, so single-mapping
-- reads found none. A provider's only non-fuzzy mapping is its primary.
UPDATE `anime_mappings`
SET `is_primary` = 1
WHERE `is_primary` = 0
  AND `source` <> 'fuzzy'
  AND NOT EXISTS (
    SELECT 1 FROM `anime_mappings` AS `other`
    WHERE `other`.`anime_id` = `anime_mappings`.`anime_id`
      AND `other`.`provider` = `anime_mappings`.`provider`
      AND `other`.`id` <> `anime_mappings`.`id`
  );
