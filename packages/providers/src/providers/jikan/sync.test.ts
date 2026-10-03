import { describe, expect, test } from "bun:test";
import { validateCharacters } from "./client";
import { voiceCastLanguages } from "./sync";

describe("MAL voice-cast evidence", () => {
  const character = {
    character: { mal_id: 1, name: "Spike" },
    role: "Main",
    voice_actors: [
      { language: "English", person: { mal_id: 12, name: "Steve Blum" } },
      { language: "Japanese", person: { mal_id: 11, name: "Koichi Yamadera" } },
      { language: "Portuguese (BR)", person: { mal_id: 13, name: "Actor" } },
    ],
  };
  test("records named languages and deduplicates credits without inventing full coverage", () => {
    const result = voiceCastLanguages([character, character]);
    expect(result).toEqual([
      { languageCode: "en", confidence: 75, characterCount: 1 },
      { languageCode: "ja", confidence: 75, characterCount: 1 },
      { languageCode: "pt", confidence: 75, characterCount: 1 },
    ]);
  });
  test("empty cast and unknown language labels establish no availability", () => {
    expect(voiceCastLanguages([])).toEqual([]);
    expect(
      voiceCastLanguages([
        {
          ...character,
          voice_actors: [{ language: "Unknown", person: { mal_id: 1, name: "Actor" } }],
        },
      ]),
    ).toEqual([]);
  });
  test("rejects malformed payloads before replacing stored evidence", () => {
    for (const value of [
      null,
      {},
      [{ ...character, voice_actors: null }],
      [{ ...character, voice_actors: [{ language: "English" }] }],
    ])
      expect(() => validateCharacters(value)).toThrow();
    expect(validateCharacters([character])).toEqual([character]);
  });
});
