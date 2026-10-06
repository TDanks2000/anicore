CREATE INDEX `anime_catalogue_title_idx` ON `anime` (lower("title_romaji"),`id`);--> statement-breakpoint
CREATE INDEX `anime_catalogue_score_idx` ON `anime` ("average_score" desc,`id`);--> statement-breakpoint
CREATE INDEX `anime_catalogue_popularity_idx` ON `anime` ("popularity" desc,`id`);--> statement-breakpoint
CREATE INDEX `anime_catalogue_format_score_idx` ON `anime` (`format`,"average_score" desc,`id`);