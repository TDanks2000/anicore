# Changelog

All notable changes to this project, newest first.

- ✨ Accept MyAnimeList cross-references as proof of Kitsu identity, not just AniList ones. Kitsu publishes them far more often, and both already arrive in the search payload.
- ✨ Record the Kitsu and MyAnimeList links AnimeSchedule publishes, once its own AniList link is confirmed to resolve to the same anime.
- ✨ Add a matching evaluator that grades the fuzzy matcher against Kitsu's authoritative cross-references and reports precision, recall and abstentions. Held-out accuracy is 100% precision at 98% recall, up from 91% recall.
- 🐛 Stop discarding a whole Kitsu search when one record in it fails to serialize. Kitsu violates its own schema on some titles, which was silently leaving anime unmatched.
- 🐛 Use exact premiere dates to tell apart franchise entries that share a title, year and episode count, instead of abstaining on the tie.
- 🐛 Stop treating a shared franchise or anthology title, such as `Minna no Uta`, as evidence that two unrelated works are the same.
- 🐛 Recognize `2nd Season`, `Season 2`, `Part 2`, `II` and a bare trailing number as the same sequel marker, and stop scoring a sequel as a near-perfect match for its own base title.
- 🐛 Fold Japanese long-vowel romanizations so `Yuusha`, `Yūsha` and `Yusha` match.
- 🐛 Keep an exact premiere date from being overruled by an episode count that only differs by catalogue counting convention.
- 🐛 Enforce at most one primary mapping per anime and provider in the database, and elect a primary for the 53 groups that had none, so single-mapping reads are deterministic.
- 🐛 Preserve Japanese voiced kana and other non-Latin marks when matching anime titles.
- 🐛 Reject Kitsu fuzzy matches between movies and TV entries while retaining authoritative cross-references.
- 🐛 Preserve saved mapping audit reports when an audit crashes or produces invalid output.
