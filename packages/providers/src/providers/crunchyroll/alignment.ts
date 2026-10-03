import type { CrunchyrollEpisode, CrunchyrollSeason, CrunchyrollSeries } from "./client";

/**
 * Aligns one AniCore anime with a slice of a Crunchyroll series.
 *
 * Crunchyroll groups episodes into its own seasons, which rarely match AniList
 * entries one to one: a split cour can be half of a Crunchyroll season, and a
 * long runner spans many seasons numbered absolutely. An alignment is accepted
 * only when it is anchored, either by the premiere date or by an exact fit of
 * a whole season, and complete; every ambiguity abstains instead of guessing.
 */

export interface CrunchyrollCatalogue {
  series: CrunchyrollSeries;
  seasons: Array<{ season: CrunchyrollSeason; episodes: CrunchyrollEpisode[] }>;
}

export interface AlignmentTarget {
  status: string | null;
  episodeCount: number | null;
  startDate: string | null;
  /** Normal (non-special) canonical episodes and every title known for each. */
  episodes: Array<{ number: number; titles: string[] }>;
}

/**
 * 1: premiere date and an exact whole-season fit agree.
 * 2: anchored on the premiere date.
 * 3: an exact whole-season fit with no matching premiere date.
 */
export type AlignmentTier = 1 | 2 | 3;

export interface CrunchyrollAlignment {
  /** The season when the slice lies in one season, otherwise the whole series. */
  entity: { kind: "season"; id: string } | { kind: "series"; id: string };
  /** Crunchyroll episode number aligned with local episode 1. */
  firstNumber: number;
  length: number;
  tier: AlignmentTier;
  episodes: Array<{ localNumber: number; episode: CrunchyrollEpisode }>;
}

export type AlignmentResult =
  | { ok: true; alignment: CrunchyrollAlignment }
  | { ok: false; reason: string };

const DATE_TOLERANCE_DAYS = 2;
const DAY_MS = 86_400_000;

/** A numbered main episode; recaps ("13.5"), specials ("SP1") and PVs are excluded. */
export function isMainEpisode(episode: CrunchyrollEpisode): boolean {
  return (
    episode.episodeNumber !== null &&
    /^\d+$/.test(episode.episode) &&
    Number(episode.episode) === episode.episodeNumber
  );
}

function dayDistance(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const left = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const right = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.abs(left - right) / DAY_MS;
}

function mainEpisodes(episodes: CrunchyrollEpisode[]): CrunchyrollEpisode[] | null {
  const mains = episodes
    .filter(isMainEpisode)
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber || a.episodeNumber! - b.episodeNumber!);
  const numbers = new Set(mains.map((episode) => episode.episodeNumber));
  // Two episodes claiming one number make every number in the season suspect.
  if (numbers.size !== mains.length) return null;
  // Back catalogue often carries the date it was uploaded rather than aired,
  // shared by most of the season. Such dates prove nothing either way.
  return hasUploadDates(mains) ? mains.map((episode) => ({ ...episode, airDate: null })) : mains;
}

export function hasUploadDates(episodes: CrunchyrollEpisode[]): boolean {
  const dated = episodes.filter((episode) => episode.airDate);
  if (dated.length < 3) return false;
  const counts = new Map<string, number>();
  for (const episode of dated)
    counts.set(episode.airDate!, (counts.get(episode.airDate!) ?? 0) + 1);
  return Math.max(...counts.values()) > dated.length / 2;
}

interface NumberedSeason {
  season: CrunchyrollSeason;
  mains: CrunchyrollEpisode[];
  min: number;
  max: number;
}

/**
 * The run of seasons continuing the anchor season's numbering, e.g. One Piece
 * arcs numbered 1-61, 62-143, 144-206. A season that restarts or overlaps the
 * numbering (a recap compilation, a re-cut, a new cour numbered from 1) is
 * skipped rather than ending the chain.
 */
function numberingChain(
  seasons: NumberedSeason[],
  anchorIndex: number,
): Map<number, CrunchyrollEpisode> {
  const chain = new Map<number, CrunchyrollEpisode>();
  const anchor = seasons[anchorIndex]!;
  for (const episode of anchor.mains) chain.set(episode.episodeNumber!, episode);
  let max = anchor.max;
  for (const next of seasons.slice(anchorIndex + 1)) {
    if (next.min !== max + 1) continue;
    for (const episode of next.mains) chain.set(episode.episodeNumber!, episode);
    max = next.max;
  }
  return chain;
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** "Episode 12", "Ep. 3": a numbered placeholder, not a title. */
export function isPlaceholderTitle(title: string | null | undefined): boolean {
  return !title || /^(?:episode|ep\.?|#)\s*\d+(?:\.\d+)?$/i.test(title.trim());
}

/** Loose episode-title agreement: translations differ, shifted alignments do not agree at all. */
export function episodeTitlesAgree(a: string, b: string): boolean {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  if (shorter.length >= 4 && ` ${longer} `.includes(` ${shorter} `)) return true;
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared++;
  return (2 * shared) / (leftTokens.size + rightTokens.size) >= 0.5;
}

function titleAgreement(
  pairs: CrunchyrollAlignment["episodes"],
  titles: Map<number, string[]>,
  shift: number,
): { compared: number; agreed: number } {
  let compared = 0;
  let agreed = 0;
  for (const { localNumber, episode } of pairs) {
    const local = titles.get(localNumber + shift);
    if (isPlaceholderTitle(episode.title) || !local?.length) continue;
    compared++;
    if (local.some((title) => episodeTitlesAgree(title, episode.title!))) agreed++;
  }
  return { compared, agreed };
}

/**
 * Rejects an alignment whose episode titles contradict it: either the titles
 * almost never agree, or they agree clearly better one or two episodes over,
 * which is the signature of an off-by-N alignment.
 */
export function titlesContradictAlignment(
  pairs: CrunchyrollAlignment["episodes"],
  titles: Map<number, string[]>,
): boolean {
  const aligned = titleAgreement(pairs, titles, 0);
  if (aligned.compared < 5) return false;
  const ratio = aligned.agreed / aligned.compared;
  if (ratio < 0.15) return true;
  for (const shift of [-2, -1, 1, 2]) {
    const shifted = titleAgreement(pairs, titles, shift);
    if (shifted.compared < 5) continue;
    const shiftedRatio = shifted.agreed / shifted.compared;
    if (shiftedRatio >= 0.5 && shiftedRatio > ratio + 0.25) return true;
  }
  return false;
}

interface Candidate {
  alignment: Omit<CrunchyrollAlignment, "tier">;
  dateAnchored: boolean;
  exactSeasonFit: boolean;
  complete: boolean;
  firstAirDate: string | null;
  anchorSeasonId: string;
}

function expectedLength(target: AlignmentTarget): number | null {
  if (target.episodeCount && target.episodeCount > 0) return target.episodeCount;
  const highest = Math.max(0, ...target.episodes.map((episode) => episode.number));
  return highest > 0 ? highest : null;
}

export function alignCrunchyroll(
  catalogue: CrunchyrollCatalogue,
  target: AlignmentTarget,
  options: { requireDateAnchor?: boolean } = {},
): AlignmentResult {
  const length = expectedLength(target);
  if (!length) return { ok: false, reason: "episode count unknown" };
  const finished = target.status === "FINISHED";

  const seasons: NumberedSeason[] = [];
  for (const { season, episodes } of [...catalogue.seasons].sort(
    (a, b) => a.season.sequenceNumber - b.season.sequenceNumber,
  )) {
    if (!season.isOriginal) continue;
    const mains = mainEpisodes(episodes);
    if (!mains?.length) continue;
    const numbers = mains.map((episode) => episode.episodeNumber!);
    seasons.push({ season, mains, min: Math.min(...numbers), max: Math.max(...numbers) });
  }
  if (!seasons.length) return { ok: false, reason: "no numbered Crunchyroll episodes" };

  const candidates = new Map<string, Candidate>();
  seasons.forEach((numbered, seasonIndex) => {
    const chain = numberingChain(seasons, seasonIndex);
    // Only the first premiere-date match counts: a double-episode premiere
    // shares one date, and the anime starts with the earlier of the two. A
    // match mid-season is a split cour only if everything before it aired
    // earlier; Cowboy Bebop's episode 2 carries the TV Tokyo premiere date
    // while episode 1 carries a later WOWOW one, and anchoring there would
    // shift every episode by one.
    const matchIndex = numbered.mains.findIndex(
      (episode) =>
        (dayDistance(episode.airDate, target.startDate) ?? Infinity) <= DATE_TOLERANCE_DAYS,
    );
    const anchorDate = numbered.mains[matchIndex]?.airDate;
    const dateIndex =
      matchIndex >= 0 &&
      numbered.mains
        .slice(0, matchIndex)
        .every((episode) => !episode.airDate || episode.airDate < anchorDate!)
        ? matchIndex
        : -1;
    for (const anchorIndex of new Set([0, dateIndex].filter((index) => index >= 0))) {
      const anchor = numbered.mains[anchorIndex]!;
      const firstNumber = anchor.episodeNumber!;
      const pairs: CrunchyrollAlignment["episodes"] = [];
      for (let localNumber = 1; localNumber <= length; localNumber++) {
        const episode = chain.get(firstNumber + localNumber - 1);
        if (episode) pairs.push({ localNumber, episode });
      }
      const seasonIds = new Set(pairs.map((pair) => pair.episode.seasonId));
      const exactSeasonFit =
        anchorIndex === 0 &&
        pairs.length === length &&
        numbered.mains.length === length &&
        seasonIds.size === 1;
      const key = `${numbered.season.id}:${firstNumber}`;
      const existing = candidates.get(key);
      candidates.set(key, {
        alignment: {
          entity:
            seasonIds.size > 1
              ? { kind: "series", id: catalogue.series.id }
              : { kind: "season", id: numbered.season.id },
          firstNumber,
          length,
          episodes: pairs,
        },
        dateAnchored: (existing?.dateAnchored ?? false) || anchorIndex === dateIndex,
        exactSeasonFit: (existing?.exactSeasonFit ?? false) || exactSeasonFit,
        // A finished entry must be wholly present; an airing one is checked
        // only against what has been released so far.
        complete: finished ? pairs.length === length : pairs.length > 0,
        firstAirDate: anchor.airDate,
        anchorSeasonId: numbered.season.id,
      });
    }
  });

  const titles = new Map(target.episodes.map((episode) => [episode.number, episode.titles]));
  const startYear = target.startDate ? Number(target.startDate.slice(0, 4)) : null;
  const tiered: Array<{ tier: AlignmentTier; candidate: Candidate }> = [];
  for (const candidate of candidates.values()) {
    if (!candidate.complete) continue;
    if (titlesContradictAlignment(candidate.alignment.episodes, titles)) continue;
    const airYear = candidate.firstAirDate ? Number(candidate.firstAirDate.slice(0, 4)) : null;
    const yearCompatible = !startYear || !airYear || Math.abs(airYear - startYear) <= 1;
    let tier: AlignmentTier | null = null;
    if (candidate.dateAnchored && candidate.exactSeasonFit) tier = 1;
    else if (candidate.dateAnchored) tier = 2;
    else if (
      !options.requireDateAnchor &&
      finished &&
      candidate.exactSeasonFit &&
      length >= 2 &&
      yearCompatible
    )
      tier = 3;
    if (tier) tiered.push({ tier, candidate });
  }
  if (!tiered.length) return { ok: false, reason: "no anchored, complete alignment" };

  const best = Math.min(...tiered.map((item) => item.tier)) as AlignmentTier;
  const winners = tiered.filter((item) => item.tier === best);
  if (winners.length > 1) return { ok: false, reason: `ambiguous tier ${best} alignment` };
  // A premiere date and a whole-season fit pointing at different offsets of
  // the same season contradict each other (Cowboy Bebop's TV Tokyo dates sit
  // one episode off its WOWOW order); a same-sized season elsewhere does not.
  const winner = winners[0]!.candidate;
  if (
    best === 2 &&
    tiered.some(
      (item) => item.tier === 3 && item.candidate.anchorSeasonId === winner.anchorSeasonId,
    )
  )
    return { ok: false, reason: "premiere date and season fit disagree" };
  return { ok: true, alignment: { ...winners[0]!.candidate.alignment, tier: best } };
}

/**
 * Whether a linked single-season series can stand for an anime it could not be
 * aligned with episode by episode. AniList links films and sequels to their
 * parent show's page, so the season must be about the same size and from the
 * same years; anything else would attribute another work's tracks.
 */
export function seasonPlausiblyThisAnime(
  catalogue: CrunchyrollCatalogue,
  target: AlignmentTarget & { format: string | null },
): boolean {
  if (catalogue.seasons.length !== 1 || target.format === "MOVIE") return false;
  const length = expectedLength(target);
  const mains = mainEpisodes(catalogue.seasons[0]!.episodes);
  if (!length || !mains?.length) return false;
  if (Math.abs(mains.length - length) > Math.max(2, Math.round(length * 0.1))) return false;
  const firstAired = mains.find((episode) => episode.airDate)?.airDate;
  // Undated (upload-dated) seasons must at least match the episode count exactly.
  if (!firstAired) return mains.length === length;
  const startYear = target.startDate ? Number(target.startDate.slice(0, 4)) : null;
  return !startYear || Math.abs(Number(firstAired.slice(0, 4)) - startYear) <= 1;
}

export interface LinkedSibling {
  animeId: number;
  episodeCount: number | null;
  startDate: string | null;
}

/**
 * The season an anime owns when several anime publish the same Crunchyroll
 * link and nothing else tells their seasons apart (Vandread and its second
 * stage: two 13-episode seasons with upload dates only). Ordered by premiere,
 * the anime must pair one to one with the series' numbered seasons in order,
 * with equal episode counts throughout; anything else returns null.
 */
export function seasonBySiblingOrder(
  catalogue: CrunchyrollCatalogue,
  siblings: LinkedSibling[],
  animeId: number,
): CrunchyrollCatalogue | null {
  const seasons = [...catalogue.seasons]
    .filter((entry) => entry.season.isOriginal)
    .sort((a, b) => a.season.sequenceNumber - b.season.sequenceNumber)
    .map((entry) => ({ entry, mains: mainEpisodes(entry.episodes) }))
    .filter((item) => item.mains?.length);
  if (siblings.length < 2 || siblings.length !== seasons.length) return null;
  if (siblings.some((sibling) => !sibling.startDate || !sibling.episodeCount)) return null;
  const ordered = [...siblings].sort((a, b) => a.startDate!.localeCompare(b.startDate!));
  if (new Set(ordered.map((sibling) => sibling.startDate)).size !== ordered.length) return null;
  if (ordered.some((sibling, index) => sibling.episodeCount !== seasons[index]!.mains!.length))
    return null;
  const index = ordered.findIndex((sibling) => sibling.animeId === animeId);
  if (index < 0) return null;
  return { series: catalogue.series, seasons: [seasons[index]!.entry] };
}

const RESERVED_PATHS = new Set([
  "series",
  "watch",
  "videos",
  "news",
  "simulcasts",
  "simulcast",
  "search",
  "store",
  "comics",
  "games",
  "home",
]);

export type CrunchyrollLink = { seriesId: string } | { slug: string };

/**
 * Reads a Crunchyroll series reference from a catalogue link. Modern links
 * carry the series id; pre-2022 links carry only a slug, which still names the
 * series (`slug_title`) and must be resolved by search.
 */
export function parseCrunchyrollLink(value: string): CrunchyrollLink | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!["crunchyroll.com", "www.crunchyroll.com", "beta.crunchyroll.com"].includes(host))
    return null;
  if (url.username || url.password || url.port) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] && /^[a-z]{2}(?:-[a-z]{2,4})?$/i.test(segments[0]) && segments.length > 1)
    segments.shift();
  if (segments[0] === "series") {
    const id = segments[1];
    return id && /^[A-Z0-9]{6,40}$/.test(id) ? { seriesId: id } : null;
  }
  const slug = segments[0]?.toLowerCase();
  if (segments.length !== 1 || !slug || RESERVED_PATHS.has(slug)) return null;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? { slug } : null;
}

/** Crunchyroll locale ("en-US", "es-419") to AniCore's base language code. */
export function crunchyrollLanguage(locale: string): string | null {
  const base = locale.trim().split("-")[0]?.toLowerCase();
  return base && /^[a-z]{2,3}$/.test(base) ? base : null;
}

export function sameTitle(a: string, b: string): boolean {
  const left = normalizeTitle(a);
  return Boolean(left) && left === normalizeTitle(b);
}
