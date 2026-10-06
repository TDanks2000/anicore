-- External content avoids duplicating the anime text. This virtual table is
-- managed here because Drizzle's table schema does not represent FTS5 tables.
CREATE VIRTUAL TABLE anime_search USING fts5(
  title_romaji, title_english, title_native, title_user_preferred, synonyms_json, slug,
  content='anime', content_rowid='id', tokenize='trigram', columnsize=0
);
--> statement-breakpoint
CREATE TRIGGER anime_search_insert AFTER INSERT ON anime BEGIN
  INSERT INTO anime_search(rowid, title_romaji, title_english, title_native, title_user_preferred, synonyms_json, slug)
  VALUES (new.id, new.title_romaji, new.title_english, new.title_native, new.title_user_preferred, new.synonyms_json, new.slug);
END;
--> statement-breakpoint
CREATE TRIGGER anime_search_delete AFTER DELETE ON anime BEGIN
  INSERT INTO anime_search(anime_search, rowid, title_romaji, title_english, title_native, title_user_preferred, synonyms_json, slug)
  VALUES ('delete', old.id, old.title_romaji, old.title_english, old.title_native, old.title_user_preferred, old.synonyms_json, old.slug);
END;
--> statement-breakpoint
CREATE TRIGGER anime_search_update AFTER UPDATE OF id, title_romaji, title_english, title_native, title_user_preferred, synonyms_json, slug ON anime
WHEN old.id IS NOT new.id OR old.title_romaji IS NOT new.title_romaji
  OR old.title_english IS NOT new.title_english OR old.title_native IS NOT new.title_native
  OR old.title_user_preferred IS NOT new.title_user_preferred
  OR old.synonyms_json IS NOT new.synonyms_json OR old.slug IS NOT new.slug
BEGIN
  INSERT INTO anime_search(anime_search, rowid, title_romaji, title_english, title_native, title_user_preferred, synonyms_json, slug)
  VALUES ('delete', old.id, old.title_romaji, old.title_english, old.title_native, old.title_user_preferred, old.synonyms_json, old.slug);
  INSERT INTO anime_search(rowid, title_romaji, title_english, title_native, title_user_preferred, synonyms_json, slug)
  VALUES (new.id, new.title_romaji, new.title_english, new.title_native, new.title_user_preferred, new.synonyms_json, new.slug);
END;
--> statement-breakpoint
-- Backfill records stored before this migration.
INSERT INTO anime_search(anime_search) VALUES ('rebuild');
