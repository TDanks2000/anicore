export function normalizeComparableTitle(value: string): string {
  const decomposed = value.normalize("NFKD");
  let normalized = "";
  let lastBaseIsLatin = false;

  for (const character of decomposed) {
    if (/\p{M}/u.test(character)) {
      // Latin accents are presentation variants for matching purposes, while
      // marks in scripts such as Japanese kana can change the character.
      if (!lastBaseIsLatin) normalized += character;
      continue;
    }

    normalized += character;
    lastBaseIsLatin = /\p{Script=Latin}/u.test(character);
  }

  // Symbol/conjunction equivalence must run before punctuation stripping so the
  // words they stand for survive as real tokens instead of being erased. NFKD
  // already folds full-width ASCII (e.g. "＆") onto plain "&", so a single
  // ASCII-facing pass here covers both forms.
  const withSymbolWords = applySymbolEquivalents(normalized.normalize("NFC"));
  const lowered = withSymbolWords.toLowerCase();

  const cleaned = lowered
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Ordinal canonicalisation must run on the clean word tokens before vowel
  // folding: folding "ou" -> "o" would otherwise corrupt the literal keyword
  // "cour" (as in "2nd Cour") into "cor" before it can be recognised.
  const withCanonicalOrdinals = canonicalizeOrdinals(cleaned);

  return foldLatinLongVowels(withCanonicalOrdinals).replace(/\s+/g, " ").trim();
}

/**
 * Maps symbols that stand in for words onto their word form. This must run
 * before punctuation stripping, otherwise "&", "×"/"✕" and "+" would simply
 * vanish into whitespace and the words they represent would be lost entirely
 * rather than merely reformatted.
 */
function applySymbolEquivalents(value: string): string {
  return value
    .replace(/&/g, " and ")
    .replace(/[×✕]/g, " x ")
    .replace(/([\p{L}\p{N}])\s*\+\s*(?=[\p{L}\p{N}])/gu, "$1 plus ");
}

// Doubled-vowel / digraph romanisations of Japanese long vowels that should
// collapse onto the same canonical short form NFKD already produces for
// macron spellings (e.g. "ū" -> "u"). "oh" is only folded when followed by a
// consonant so that "oh" itself and vowel-initial words like "ohio" survive
// untouched. TRADEOFF: this intentionally also folds some ordinary English
// sequences ("four" -> "for", "moon" -> "mon", "about" -> "abot"). Because the
// fold is applied identically to both sides of every comparison, this only
// causes a false match when two otherwise-different English words collide
// after folding, which is rare in anime titles compared to the transliteration
// variance it correctly resolves ("Yuusha"/"Yūsha"/"Yusha", "Ohgami"/"Ōgami").
function foldLatinVowelRun(run: string): string {
  return run
    .replace(/oh(?=[bcdfgjklmnpqrstvwxyz])/g, "o")
    .replace(/ou/g, "o")
    .replace(/uu/g, "u")
    .replace(/oo/g, "o");
}

// Restrict the fold to contiguous Latin-script runs so native CJK text (which
// is never matched by \p{Script=Latin}) is never touched.
function foldLatinLongVowels(value: string): string {
  return value.replace(/\p{Script=Latin}+/gu, (run) => foldLatinVowelRun(run));
}

// Keywords that mark the token beside them as a sequel/season counter rather
// than part of the work's name. "stage" is included for the Initial D style
// ("First Stage" / "Fourth Stage"), which is otherwise indistinguishable from
// an ordinary noun.
const ORDINAL_KEYWORDS = "season|part|cour|stage";

const WORD_ORDINAL_VALUES: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
};

const ROMAN_NUMERAL_VALUES: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
  xi: 11,
  xii: 12,
};

/**
 * Canonicalises every explicit sequel/season marker ("2nd Season",
 * "Season 2", "S2", "Part 2", "2nd Cour", roman numeral "II") onto the same
 * internal token, "ordinalN". This lets identical entries collapse to an
 * exact normalized match regardless of phrasing, and gives titleSimilarity a
 * reliable signal to detect and penalize CONFLICTING ordinals (e.g. "II" vs
 * "III"), which is the largest source of wrong sequel-vs-sequel mappings.
 *
 * Bare roman numerals are only canonicalised when they are the final token of
 * a multi-word title. Roman numeral letters overlap with the pronoun "i" and
 * the "x" produced by the ×/✕ symbol fold above, so restricting to the
 * trailing position keeps the (much more common) sequel-numbering use case
 * without corrupting ordinary sentences or crossover titles.
 */
function canonicalizeOrdinals(value: string): string {
  const wordOrdinals = Object.keys(WORD_ORDINAL_VALUES).join("|");

  let result = value
    // Word-form ordinals ("Second Season", "Fourth Stage", "Part One") are as
    // common as digits in official titles and must reach the same token, or
    // "Monogatari Series Second Season" and "Monogatari Series Season 2" look
    // like different works.
    .replace(
      new RegExp(`\\b(${wordOrdinals})\\s+(?:${ORDINAL_KEYWORDS})\\b`, "g"),
      (_match, word: string) => `ordinal${WORD_ORDINAL_VALUES[word]}`,
    )
    .replace(
      new RegExp(`\\b(?:${ORDINAL_KEYWORDS})\\s+(${wordOrdinals})\\b`, "g"),
      (_match, word: string) => `ordinal${WORD_ORDINAL_VALUES[word]}`,
    )
    .replace(
      new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)\\s+(?:${ORDINAL_KEYWORDS})\\b`, "g"),
      (_match, num: string) => `ordinal${num}`,
    )
    .replace(
      new RegExp(`\\b(?:${ORDINAL_KEYWORDS})\\s+(\\d{1,2})\\b`, "g"),
      (_match, num: string) => `ordinal${num}`,
    )
    .replace(/\bs(\d{1,2})\b/g, (_match, num: string) => `ordinal${num}`);

  // A bare trailing number or roman numeral is the most common sequel marker
  // of all ("KonoSuba 2", "Steins;Gate 0", "Shingeki no Kyojin II"). Without
  // this, a sequel scores ~0.98 against its own base title, because the two
  // strings differ by a single character.
  //
  // Only the trailing position of a multi-word title qualifies. That keeps
  // titles which are themselves numbers or start with one ("86",
  // "5 Centimeters per Second", "91 Days") from being read as sequel markers,
  // and avoids the roman-numeral letters colliding with the pronoun "i" or the
  // "x" produced by the ×/✕ fold above.
  const tokens = result.split(" ").filter(Boolean);
  if (tokens.length > 1) {
    const lastToken = tokens[tokens.length - 1] as string;
    const ordinalValue = /^\d{1,2}$/.test(lastToken)
      ? Number(lastToken)
      : ROMAN_NUMERAL_VALUES[lastToken];
    if (ordinalValue !== undefined) {
      tokens[tokens.length - 1] = `ordinal${ordinalValue}`;
      result = tokens.join(" ");
    }
  }

  return result;
}

function tokenJaccard(a: string, b: string): number {
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection++;
  }

  const union = new Set([...aTokens, ...bTokens]).size;
  return union ? intersection / union : 0;
}

function ngrams(value: string, size = 3): Set<string> {
  const compact = value.replace(/\s+/g, " ");
  if (!compact) return new Set();
  if (compact.length <= size) return new Set([compact]);

  const grams = new Set<string>();
  for (let index = 0; index <= compact.length - size; index++) {
    grams.add(compact.slice(index, index + size));
  }
  return grams;
}

function diceCoefficient(a: string, b: string): number {
  const aGrams = ngrams(a);
  const bGrams = ngrams(b);
  if (!aGrams.size || !bGrams.size) return 0;

  let intersection = 0;
  for (const gram of aGrams) {
    if (bGrams.has(gram)) intersection++;
  }

  return (2 * intersection) / (aGrams.size + bGrams.size);
}

/**
 * Trigram Dice over the space-stripped strings. This exists specifically to
 * rescue re-tokenization noise like "Cardcaptor Sakura" vs "Card Captor
 * Sakura", where a word is merged/split but the underlying letters are
 * identical — the space-aware trigram score alone sits below the 0.9
 * threshold there. It is intentionally combined with (not a replacement for)
 * the containment penalty below: subset/superset titles ("Gintama" vs
 * "Gintama: The Final") also score highly on this metric, but get capped back
 * down by applyContainmentPenalty regardless of which metric produced the
 * pre-penalty score.
 */
function spacelessDiceCoefficient(a: string, b: string): number {
  return diceCoefficient(a.replace(/\s+/g, ""), b.replace(/\s+/g, ""));
}

function lengthRatio(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  return Math.min(a.length, b.length) / Math.max(a.length, b.length);
}

// Below this length ratio, a "shorter title's tokens are a subset of the
// longer title's tokens" relationship is treated as a franchise entry/subtitle
// distinction ("Gintama" vs "Gintama: The Final") rather than transliteration
// noise, and the score is capped. Above it, lengths are close enough that the
// difference is more likely spacing/hyphenation noise, so no penalty applies.
const CONTAINMENT_LENGTH_RATIO_THRESHOLD = 0.8;

/**
 * Caps the score when one title's token set is a strict subset of the
 * other's and the two titles differ substantially in length. Token-set
 * containment alone is not enough to penalize (see "does not overrate short
 * titles that share one word", which already fails containment because
 * neither side is a subset of the other) — it is specifically the
 * subset-plus-large-length-gap combination that signals "same prefix,
 * different work" rather than "same work, extra noise".
 */
function applyContainmentPenalty(score: number, normalizedA: string, normalizedB: string): number {
  const tokensA = new Set(normalizedA.split(" ").filter(Boolean));
  const tokensB = new Set(normalizedB.split(" ").filter(Boolean));
  const [shorter, longer] = tokensA.size <= tokensB.size ? [tokensA, tokensB] : [tokensB, tokensA];
  if (!shorter.size) return score;

  for (const token of shorter) {
    if (!longer.has(token)) return score;
  }

  const ratio = lengthRatio(normalizedA, normalizedB);
  if (ratio >= CONTAINMENT_LENGTH_RATIO_THRESHOLD) return score;

  return Math.min(score, ratio);
}

const ORDINAL_TOKEN_PATTERN = /^ordinal(\d{1,2})$/;

// A decisive cap, not a nudge: trigram Dice scores "Title II" vs "Title III"
// far too high because the strings differ by a single character, so token
// overlap alone cannot be trusted to catch conflicting sequel numbers.
const ORDINAL_CONFLICT_SCORE_CAP = 0.4;

function extractOrdinalNumbers(normalized: string): number[] {
  const numbers: number[] = [];
  for (const token of normalized.split(" ")) {
    const match = ORDINAL_TOKEN_PATTERN.exec(token);
    if (match?.[1]) numbers.push(Number(match[1]));
  }
  return numbers;
}

/**
 * True when both titles carry an explicit, canonicalised ordinal/season
 * marker and none of the numbers match (e.g. "ordinal2" vs "ordinal3"). A
 * title with no explicit ordinal at all is not considered conflicting with
 * one that has one — that case is handled by the containment/length scoring
 * instead, since it is a "is this the same show or a spin-off" question
 * rather than a "same show, different season" question.
 */
function hasConflictingOrdinals(normalizedA: string, normalizedB: string): boolean {
  const ordinalsA = extractOrdinalNumbers(normalizedA);
  const ordinalsB = extractOrdinalNumbers(normalizedB);
  if (!ordinalsA.length || !ordinalsB.length) return false;
  return !ordinalsA.some((value) => ordinalsB.includes(value));
}

// Softer than the both-sides-conflict cap: enough to stop a sequel from
// outscoring nothing on title alone, but still above MIN_FUZZY_TITLE_SIMILARITY
// so that agreeing year/season/episode-count evidence can still carry a genuine
// match. Base-vs-sequel pairs disagree on exactly that evidence, so they fail;
// a real match whose catalogues merely disagree about printing the number
// survives.
const UNPAIRED_SEQUEL_SCORE_CAP = 0.6;

/**
 * True when exactly one side is explicitly numbered as a second-or-later
 * entry and the other carries no ordinal at all — the "Kono Subarashii Sekai
 * ni Shukufuku wo!" vs "... wo! 2" shape.
 *
 * The containment penalty cannot catch this: appending " 2" barely changes the
 * string length, so the length ratio stays above its threshold precisely when
 * the added token is a short sequel number. Ordinal 1 is deliberately excluded,
 * because "X" and "X Season 1" genuinely are the same work.
 */
function hasUnpairedSequelOrdinal(normalizedA: string, normalizedB: string): boolean {
  const ordinalsA = extractOrdinalNumbers(normalizedA);
  const ordinalsB = extractOrdinalNumbers(normalizedB);
  if (ordinalsA.length && ordinalsB.length) return false;
  if (!ordinalsA.length && !ordinalsB.length) return false;

  const present = ordinalsA.length ? ordinalsA : ordinalsB;
  return present.some((value) => value >= 2);
}

/**
 * Conservative title similarity for identity matching.
 *
 * Exact normalized titles score 1. Otherwise we combine token-set overlap
 * with character trigrams, then apply two corrections on top: a containment
 * penalty for short titles that are a strict subset of a much longer title
 * (different franchise entries, not noise), and a decisive cap when the two
 * titles carry explicitly conflicting ordinals/seasons ("II" vs "III"),
 * which trigram Dice alone rates far too generously.
 */
export function titleSimilarity(a: string, b: string): number {
  const normalizedA = normalizeComparableTitle(a);
  const normalizedB = normalizeComparableTitle(b);
  if (!normalizedA || !normalizedB) return 0;
  if (normalizedA === normalizedB) return 1;

  let score = Math.max(
    tokenJaccard(normalizedA, normalizedB),
    diceCoefficient(normalizedA, normalizedB),
    spacelessDiceCoefficient(normalizedA, normalizedB),
  );

  score = applyContainmentPenalty(score, normalizedA, normalizedB);

  if (hasConflictingOrdinals(normalizedA, normalizedB)) {
    score = Math.min(score, ORDINAL_CONFLICT_SCORE_CAP);
  } else if (hasUnpairedSequelOrdinal(normalizedA, normalizedB)) {
    score = Math.min(score, UNPAIRED_SEQUEL_SCORE_CAP);
  }

  return score;
}
