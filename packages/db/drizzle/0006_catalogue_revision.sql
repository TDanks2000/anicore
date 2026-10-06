INSERT INTO catalogue_revision(id, revision) VALUES (1, 0);
--> statement-breakpoint
CREATE TRIGGER revision_anime_insert AFTER INSERT ON anime BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_update AFTER UPDATE ON anime BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_delete AFTER DELETE ON anime BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_episodes_insert AFTER INSERT ON episodes BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_episodes_update AFTER UPDATE ON episodes BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_episodes_delete AFTER DELETE ON episodes BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_mappings_insert AFTER INSERT ON anime_mappings BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_mappings_update AFTER UPDATE ON anime_mappings BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_mappings_delete AFTER DELETE ON anime_mappings BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_episode_mappings_insert AFTER INSERT ON episode_mappings BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_episode_mappings_update AFTER UPDATE ON episode_mappings BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_episode_mappings_delete AFTER DELETE ON episode_mappings BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_studio_links_insert AFTER INSERT ON anime_studio_links BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_studio_links_update AFTER UPDATE ON anime_studio_links BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_studio_links_delete AFTER DELETE ON anime_studio_links BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_tag_links_insert AFTER INSERT ON anime_tag_links BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_tag_links_update AFTER UPDATE ON anime_tag_links BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_tag_links_delete AFTER DELETE ON anime_tag_links BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_external_links_insert AFTER INSERT ON anime_external_links BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_external_links_update AFTER UPDATE ON anime_external_links BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_external_links_delete AFTER DELETE ON anime_external_links BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_relation_links_insert AFTER INSERT ON anime_relation_links BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_relation_links_update AFTER UPDATE ON anime_relation_links BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_relation_links_delete AFTER DELETE ON anime_relation_links BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_studios_insert AFTER INSERT ON studios BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_studios_update AFTER UPDATE ON studios BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_studios_delete AFTER DELETE ON studios BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_tags_insert AFTER INSERT ON tags BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_tags_update AFTER UPDATE ON tags BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_tags_delete AFTER DELETE ON tags BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_language_status_insert AFTER INSERT ON anime_language_status BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_language_status_update AFTER UPDATE ON anime_language_status BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_language_status_delete AFTER DELETE ON anime_language_status BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_language_evidence_insert AFTER INSERT ON anime_language_evidence BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_language_evidence_update AFTER UPDATE ON anime_language_evidence BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_language_evidence_delete AFTER DELETE ON anime_language_evidence BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_episode_language_status_insert AFTER INSERT ON episode_language_status BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_episode_language_status_update AFTER UPDATE ON episode_language_status BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_episode_language_status_delete AFTER DELETE ON episode_language_status BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_provider_mappings_insert AFTER INSERT ON anime_provider_mappings BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_provider_mappings_update AFTER UPDATE ON anime_provider_mappings BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_provider_mappings_delete AFTER DELETE ON anime_provider_mappings BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_provider_segments_insert AFTER INSERT ON anime_provider_segments BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_provider_segments_update AFTER UPDATE ON anime_provider_segments BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_anime_provider_segments_delete AFTER DELETE ON anime_provider_segments BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_provider_entities_insert AFTER INSERT ON provider_entities BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_provider_entities_update AFTER UPDATE ON provider_entities BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER revision_provider_entities_delete AFTER DELETE ON provider_entities BEGIN
  INSERT INTO catalogue_revision(id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END;
