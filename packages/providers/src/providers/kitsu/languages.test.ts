import { describe, expect, test } from "bun:test";
import {
  type KitsuStreamingLink,
  streamingLanguageAssertions,
  validateStreamingLinks,
} from "./languages";

describe("Kitsu streaming language metadata", () => {
  const link: KitsuStreamingLink = {
    id: "2260",
    type: "streamingLinks",
    attributes: { url: "http://www.crunchyroll.com/cowboy-bebop", subs: ["en"], dubs: ["ja"] },
  };
  test("uses explicit track arrays, including original audio, without treating the stream URL as a dub", () => {
    expect(streamingLanguageAssertions("1", [link])).toMatchObject([
      {
        languageCode: "ja",
        mediaType: "audio",
        confidence: 75,
        sourceUrl: "https://kitsu.io/api/edge/anime/1/streaming-links#2260",
      },
      { languageCode: "en", mediaType: "subtitle", confidence: 75 },
    ]);
    expect(
      streamingLanguageAssertions("1", [
        { ...link, attributes: { ...link.attributes, subs: [], dubs: [] } },
      ]),
    ).toEqual([]);
  });
  test("normalizes regional languages and rejects unknown labels and invalid destinations", () => {
    expect(
      streamingLanguageAssertions("1", [
        {
          ...link,
          attributes: { ...link.attributes, subs: ["pt_BR", "en", "en", "Unknown", "foobar"] },
        },
      ]).map((row) => row.languageCode),
    ).toEqual(["ja", "pt", "en"]);
    expect(
      streamingLanguageAssertions("1", [
        { ...link, attributes: { ...link.attributes, url: "javascript:alert(1)" } },
      ]),
    ).toEqual([]);
  });
  test("malformed arrays and IDs never reach snapshot replacement", () => {
    for (const value of [
      null,
      {},
      [{ ...link, id: "" }],
      [{ ...link, attributes: { ...link.attributes, subs: "en" } }],
    ])
      expect(() => validateStreamingLinks(value)).toThrow();
    expect(validateStreamingLinks([link])).toEqual([link]);
  });
});
