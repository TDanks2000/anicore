import { describe, expect, test } from "bun:test";
import { validateAnilistCast } from "./languages";

describe("AniList voice-cast identity", () => {
  const media = {
    id: 1,
    characters: {
      pageInfo: { hasNextPage: false },
      edges: [
        {
          role: "MAIN",
          node: { id: 1 },
          voiceActors: [{ id: 95012, name: { full: "Steven Blum" }, languageV2: "English" }],
        },
      ],
    },
  };
  test("uses only the requested media and validated voice credits", () => {
    expect(validateAnilistCast({ data: { Media: media } }, 1)).toEqual({
      characters: media.characters.edges,
      hasNextPage: false,
    });
    expect(() => validateAnilistCast({ data: { Media: media } }, 5)).toThrow("identity");
    expect(() => validateAnilistCast({ errors: [{ message: "offline" }] }, 1)).toThrow();
    expect(() =>
      validateAnilistCast(
        { data: { Media: { ...media, characters: { ...media.characters, pageInfo: {} } } } },
        1,
      ),
    ).toThrow("pagination");
  });
  test("malformed actors fail before persistence", () => {
    expect(() =>
      validateAnilistCast(
        {
          data: {
            Media: {
              ...media,
              characters: {
                ...media.characters,
                edges: [
                  {
                    ...media.characters.edges[0],
                    voiceActors: [{ id: 1, name: {}, languageV2: "English" }],
                  },
                ],
              },
            },
          },
        },
        1,
      ),
    ).toThrow("voice credit");
  });
});
