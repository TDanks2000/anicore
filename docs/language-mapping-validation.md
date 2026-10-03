# Language mapping validation

## Per-episode dub and subtitle mapping (2026-10-03, evening)

Validated against a migrated copy of the live catalogue (1,255 anime, taken while a full sync was running), live Crunchyroll, Kitsu and AniList responses, the API and the dashboard. The live database was not modified.

### Cowboy Bebop

The series-level status was already correct; what was missing was any episode-level evidence, so the dashboard showed `?/26`, every episode title was empty and episode lengths were stored in seconds (1,500 "minutes"). AniList's legacy link `crunchyroll.com/cowboy-bebop` now resolves to Crunchyroll series `GYVNXMVP6`, season `GY2PW587Y`, aligned 1–26 → 1–26. Its premiere dates are a trap: Crunchyroll gives episode 2 the TV Tokyo date AniList uses as the start date and episode 1 a later WOWOW date, so a date anchor would shift every episode by one. The alignment rejects that anchor because an earlier episode aired later, and accepts the exact season fit instead.

All five language providers then agree, with no errors or warnings:

| Track | Status | Episodes |
| --- | --- | ---: |
| English audio | confirmed (95) | 26/26 |
| Japanese audio | confirmed (95) | 26/26 |
| English subtitles | confirmed (95) | 26/26 |

Portuguese, previously split into `pt` and `pt-br`, is one row. Kitsu and MAL mappings are primary. Episodes carry titles ("Asteroid Blues", "Stray Dog Strut") and lengths in minutes.

### Catalogue run

| Result | Anime |
| --- | ---: |
| Aligned per episode: premiere date and season fit (tier 1) | 32 |
| Aligned per episode: premiere date (tier 2) | 9 |
| Aligned per episode: exact season fit (tier 3) | 46 |
| Series-level tracks only | 2 |
| No Crunchyroll link and no exact, premiere-anchored search match | 1,117 |
| Linked, but no numbered episodes in the GB catalogue | 28 |
| Linked, but no anchored complete alignment | 20 |
| Linked series no longer exists | 1 |
| Errors | 0 |

3,630 episodes were mapped. The catalogue so far is mostly 1980s–2000s back catalogue, much of which Crunchyroll does not carry; recent series align far more often (every Attack on Titan TV entry and both Frieren seasons align in the fixtures).

Abstentions are deliberate. Examples: the 1997 Berserk matched Crunchyroll's 2016 Berserk by title and was rejected on premiere date; Gundam SEED is carried as its 48-episode 2012 remaster against AniList's 50-episode original; Samurai Champloo, lain, NOIR and Elfen Lied have no episodes in the GB catalogue.

### Independent accuracy check

Kitsu supplies AniCore's canonical episode numbering, so every aligned episode's Crunchyroll title was compared with Kitsu's title for the same local number, and with Kitsu's titles shifted by ±1 and ±2 to detect off-by-N alignments.

- 81 of the 87 aligned anime had comparable titles; 3,137 of 3,377 episode titles agree (92.9%).
- No alignment agrees better under any shift, so no off-by-N mapping was found.
- Four anime agreed under 50%, all checked by hand: Digimon Adventure and Soukou no Strain use different translations (Crunchyroll translates the Japanese titles, Kitsu has the US broadcast titles); Fruits Basket (2001) is titled "Episode N" on Crunchyroll, which is now ignored; Comic Party Revolution is correct on Crunchyroll and wrong on Kitsu, whose Revolution episodes carry the 2001 series' titles.

`db:audit-languages` reports no findings: 7,388 evidence rows and 33,519 episode language rows, including Crunchyroll identity, episode-mapping, regional-negative and language-code checks.

## Earlier validation

Validated on 2026-10-03 against the existing local catalogue, live provider responses, the running API, and the dashboard at desktop and mobile sizes.

### Cowboy Bebop

AniList `1`, MAL `1`, Kitsu `1`, and AnimeSchedule `cowboy-bebop` identify the TV series. The movie stays separate: AniList/MAL `5` and Kitsu `2`.

The original bug treated AnimeSchedule's zero dub premiere as proof that no English dub existed, writing `missing` for all 26 episodes and `not_available` for the series. Its live payload actually contains distinct English dub/sub release-time markers. The corrected result confirms English audio and subtitles at confidence 90. Independent cast and Kitsu streaming metadata provide additional evidence. None of these metadata sources proves all 26 episodes individually, so episode coverage remains unknown.

A separate API bug hid subtitles: `t.UnionEnum` defaulted an omitted media filter to `audio`. The language endpoint now returns both media types unless the caller explicitly filters it.

### Catalogue refresh

All 105 stored anime were refreshed. A SQLite snapshot was saved before repairs to `apps/api/data/cache/language-repair-before.db`.

| English status | Before: audio | After: audio | Before: subtitles | After: subtitles |
| --- | ---: | ---: | ---: | ---: |
| Confirmed | 1 | 56 | 0 | 71 |
| Likely | 0 | 35 | 0 | 4 |
| Partial | 0 | 1 | 0 | 0 |
| Not available | 102 | 0 | 0 | 0 |
| Unknown | 1 | 13 | 105 | 30 |
| No stored status | 1 | 0 | 0 | 0 |

The final language pass completed with no errors. AniList cast lookup succeeded for all 105 anime. Jikan produced 96 optional-provider warnings because uncached MAL requests were unavailable upstream; its cached data remained usable, and the independent AniList provider supplied cast evidence. Rate-limit retries completed successfully.

Final reports, generated at approximately 07:44 UTC:

- `apps/api/data/cache/mapping-audit-final.json`: no mapping findings.
- `apps/api/data/cache/language-audit-final.json`: no language consistency findings; 930 evidence rows and 3,498 episode language rows.
- `apps/api/data/cache/language-catalogue-sync-final.log`: complete refresh and provider diagnostics.

### Verification

Regression coverage includes the real Cowboy Bebop payload, exact provider links, ambiguous identities, explicit release batches, future releases, episode-count conflicts, provider outages, snapshot rollback, manual overrides, source withdrawal, regional languages, omitted API filters, and duplicate/conflicting dashboard evidence.

The full test suite (380 tests), typecheck, lint and production build pass. Browser verification confirms that Cowboy Bebop shows both English tracks, evidence links, and `?/26` episode coverage, with no JavaScript errors or mobile horizontal overflow. Browser screenshots are saved in `apps/api/data/cache/cowboy-bebop-desktop.png` and `cowboy-bebop-mobile.png`.

These checks establish the implemented behavior and consistency of this catalogue. They are not a statistical guarantee that third-party catalogues are always correct. Unknown language or episode coverage remains unknown. Cast-only evidence remains likely, and catalogue streaming metadata does not establish current regional licensing.
