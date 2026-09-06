import { describe, expect, test } from "bun:test";

import { normalizeComparableTitle, titleSimilarity } from "./title-similarity";

describe("title similarity", () => {
  test("normalizes punctuation and diacritics", () => {
    expect(normalizeComparableTitle("Pokémon: Horizons!")).toBe("pokemon horizons");
    expect(titleSimilarity("Pokémon: Horizons", "Pokemon Horizons")).toBe(1);
  });

  test("preserves voiced and semi-voiced kana distinctions", () => {
    expect(normalizeComparableTitle("バナナ")).not.toBe(normalizeComparableTitle("ハナナ"));
    expect(normalizeComparableTitle("パンダ")).not.toBe(normalizeComparableTitle("ハンダ"));
    expect(normalizeComparableTitle("ハ\u3099ナナ")).toBe(normalizeComparableTitle("バナナ"));
    expect(normalizeComparableTitle("ハ\u309Aンダ")).toBe(normalizeComparableTitle("パンダ"));
    expect(titleSimilarity("バナナ", "ハナナ")).toBeLessThan(1);
  });

  test("normalizes halfwidth kana to their fullwidth equivalents", () => {
    expect(normalizeComparableTitle("ｶﾞﾝﾀﾞﾑ")).toBe(normalizeComparableTitle("ガンダム"));
    expect(titleSimilarity("ｶﾞﾝﾀﾞﾑ", "ガンダム")).toBe(1);
  });

  test("preserves non-Latin combining marks", () => {
    expect(normalizeComparableTitle("क़")).not.toBe(normalizeComparableTitle("क"));
  });

  test("treats reordered identical tokens as a strong match", () => {
    expect(titleSimilarity("Hero Academia My", "My Hero Academia")).toBe(1);
  });

  test("does not overrate short titles that share one word", () => {
    expect(titleSimilarity("Blue Lock", "Blue Period")).toBeLessThan(0.5);
    expect(titleSimilarity("Love Live", "Love Stage")).toBeLessThan(0.5);
  });

  test("retains tolerance for small spelling differences", () => {
    expect(
      titleSimilarity("Cyberpunk Edgerunners", "Cyberpunk: Edgerunner"),
    ).toBeGreaterThan(0.7);
  });

  test("does not treat a longer related franchise title as exact identity", () => {
    expect(
      titleSimilarity("Sword Art Online", "Sword Art Online Alternative"),
    ).toBeLessThan(1);
  });

  describe("requirement 1: Japanese romanisation variance", () => {
    const romanisationGroups: Array<{ label: string; forms: string[] }> = [
      { label: "yuusha/yuusha/yusha", forms: ["Yuusha", "Yūsha", "Yusha"] },
      { label: "shounen/shonen/shonen", forms: ["Shounen", "Shōnen", "Shonen"] },
      { label: "juujutsu/jujutsu/jujutsu", forms: ["Juujutsu", "Jūjutsu", "Jujutsu"] },
      { label: "ohgami/ougami/ogami", forms: ["Ohgami", "Ougami", "Ōgami"] },
    ];

    for (const group of romanisationGroups) {
      for (let i = 0; i < group.forms.length; i++) {
        for (let j = i + 1; j < group.forms.length; j++) {
          const a = group.forms[i] as string;
          const b = group.forms[j] as string;
          test(`${group.label}: "${a}" vs "${b}" scores >= 0.95`, () => {
            expect(titleSimilarity(a, b)).toBeGreaterThanOrEqual(0.95);
          });
        }
      }
    }

    test("folding does not touch native (non-Latin) script", () => {
      // Sanity check that the fold only ever operates on Latin runs: kana
      // strings containing visually-unrelated characters must stay distinct.
      expect(normalizeComparableTitle("クール")).not.toBe(normalizeComparableTitle("クル"));
    });
  });

  describe("requirement 2: symbol/conjunction equivalence", () => {
    test("ampersand and full-width ampersand both fold to 'and'", () => {
      expect(normalizeComparableTitle("A & B")).toBe("a and b");
      expect(normalizeComparableTitle("A ＆ B")).toBe("a and b");
      expect(titleSimilarity("A & B", "A ＆ B")).toBe(1);
      expect(titleSimilarity("A & B", "A and B")).toBe(1);
    });

    test("multiplication sign and multiplication-x both fold to 'x'", () => {
      expect(normalizeComparableTitle("Tom × Jerry")).toBe("tom x jerry");
      expect(normalizeComparableTitle("Tom ✕ Jerry")).toBe("tom x jerry");
      expect(titleSimilarity("Tom × Jerry", "Tom x Jerry")).toBe(1);
      expect(titleSimilarity("Tom ✕ Jerry", "Tom x Jerry")).toBe(1);
    });

    test("'+' folds to 'plus' only when it separates words", () => {
      expect(normalizeComparableTitle("Hero+Villain")).toBe("hero plus villain");
      expect(titleSimilarity("Hero+Villain", "Hero plus Villain")).toBe(1);
      // Trailing "+" with nothing after it is not "separating words", so it
      // is simply stripped like ordinary punctuation instead of becoming a
      // spurious "plus" token.
      expect(normalizeComparableTitle("Ends+")).toBe("ends");
    });
  });

  describe("requirement 3: ordinal / season canonicalisation", () => {
    const sameOrdinalForms = [
      "Title 2nd Season",
      "Title Season 2",
      "Title S2",
      "Title II",
      "Title Part 2",
      "Title 2nd Cour",
    ];

    for (let i = 0; i < sameOrdinalForms.length; i++) {
      for (let j = i + 1; j < sameOrdinalForms.length; j++) {
        const a = sameOrdinalForms[i] as string;
        const b = sameOrdinalForms[j] as string;
        test(`"${a}" and "${b}" canonicalise to the same ordinal`, () => {
          expect(titleSimilarity(a, b)).toBe(1);
        });
      }
    }

    test("conflicting explicit ordinals must not score >= 0.9", () => {
      expect(titleSimilarity("Title II", "Title III")).toBeLessThan(0.9);
      expect(titleSimilarity("Sword Art Online II", "Sword Art Online III")).toBeLessThan(0.9);
      expect(titleSimilarity("Title 2nd Season", "Title 3rd Season")).toBeLessThan(0.9);
      expect(titleSimilarity("Title Season 2", "Title Season 3")).toBeLessThan(0.9);
      expect(titleSimilarity("Title S2", "Title S3")).toBeLessThan(0.9);
      expect(titleSimilarity("Title Part 2", "Title Part 3")).toBeLessThan(0.9);
    });

    test("a bare roman numeral is only canonicalised in the trailing position", () => {
      // Single-token titles are not treated as sequel numbering; this keeps
      // the pronoun "I" and other incidental single letters from being
      // mistaken for a roman numeral ordinal.
      expect(normalizeComparableTitle("I")).toBe("i");
    });
  });

  describe("requirement 4: length-aware scoring", () => {
    test("a short title that is a strict prefix of a longer one scores clearly below 0.9", () => {
      expect(
        titleSimilarity("Fate/stay night", "Fate/stay night: Unlimited Blade Works"),
      ).toBeLessThan(0.9);
      expect(titleSimilarity("Gintama", "Gintama: The Final")).toBeLessThan(0.9);
    });

    test("transliteration/punctuation noise still scores >= 0.9", () => {
      expect(titleSimilarity("Cardcaptor Sakura", "Card Captor Sakura")).toBeGreaterThanOrEqual(
        0.9,
      );
      expect(
        titleSimilarity(
          "Re:Zero kara Hajimeru Isekai Seikatsu",
          "Re Zero kara Hajimeru Isekai Seikatsu",
        ),
      ).toBeGreaterThanOrEqual(0.9);
    });

    test("two two-word titles sharing exactly one word do not score highly", () => {
      expect(titleSimilarity("Blue Lock", "Blue Period")).toBeLessThan(0.5);
      expect(titleSimilarity("Love Live", "Love Stage")).toBeLessThan(0.5);
    });
  });
  describe("sequel numbering", () => {
    test("word-form ordinals reach the same token as digit forms", () => {
      expect(
        titleSimilarity(
          "Monogatari Series: Second Season",
          "Monogatari Series Season 2",
        ),
      ).toBe(1);
      // Initial D numbers its seasons as "Stage".
      expect(
        titleSimilarity("Initial D Fourth Stage", "Initial D Stage 4"),
      ).toBe(1);
    });

    test("a bare trailing sequel number separates a sequel from its base", () => {
      // Without trailing-number canonicalisation these score ~0.98, because
      // the two strings differ by a single character.
      expect(
        titleSimilarity(
          "Kono Subarashii Sekai ni Shukufuku wo!",
          "Kono Subarashii Sekai ni Shukufuku wo! 2",
        ),
      ).toBeLessThanOrEqual(0.6);
      expect(titleSimilarity("Steins;Gate", "Steins Gate 0")).toBeLessThanOrEqual(
        0.6,
      );
    });

    test("season 1 is not treated as a sequel of the unnumbered title", () => {
      // Uses a long base title so the containment penalty (which keys on the
      // length gap) stays out of the way and the ordinal rule is what is
      // actually under test.
      const base = "Kono Subarashii Sekai ni Shukufuku wo!";
      const seasonOne = titleSimilarity(base, `${base} 1`);
      const seasonTwo = titleSimilarity(base, `${base} 2`);
      // Season 1 keeps its uncapped similarity; season 2 is capped as a sequel.
      expect(seasonOne).toBeGreaterThan(0.8);
      expect(seasonTwo).toBeLessThanOrEqual(0.6);
      expect(seasonOne).toBeGreaterThan(seasonTwo);
    });

    test("a title that is itself a number is not read as a sequel marker", () => {
      expect(normalizeComparableTitle("86")).toBe("86");
      expect(normalizeComparableTitle("91 Days")).toBe("91 days");
      // "second" here is a unit of time, not an ordinal.
      expect(normalizeComparableTitle("5 Centimeters per Second")).toBe(
        "5 centimeters per second",
      );
    });
  });
});
