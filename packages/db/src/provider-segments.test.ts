import { describe, expect, test } from "bun:test";

import {
  localSegmentsOverlap,
  mapLocalEpisodeToProvider,
  mapProviderEpisodeToLocal,
  providerSegmentsOverlap,
  validateProviderEpisodeSegment,
  type ProviderEpisodeSegment,
} from "./provider-segments";

const splitCour: ProviderEpisodeSegment = {
  providerEpisodeStart: 13,
  providerEpisodeEnd: 24,
  localEpisodeStart: 1,
  localEpisodeEnd: 12,
};

describe("provider episode segments", () => {
  test("validates an offset split-cour segment", () => {
    expect(validateProviderEpisodeSegment(splitCour)).toEqual({ ok: true });
  });

  test("rejects unequal or reversed ranges", () => {
    expect(
      validateProviderEpisodeSegment({
        ...splitCour,
        localEpisodeEnd: 11,
      }),
    ).toEqual({ ok: false, reason: "unequal-span" });
    expect(
      validateProviderEpisodeSegment({
        ...splitCour,
        providerEpisodeEnd: 12,
      }),
    ).toEqual({ ok: false, reason: "reversed-provider-range" });
  });

  test("maps provider numbering onto restarted local numbering", () => {
    expect(mapProviderEpisodeToLocal(splitCour, 13)).toBe(1);
    expect(mapProviderEpisodeToLocal(splitCour, 24)).toBe(12);
    expect(mapProviderEpisodeToLocal(splitCour, 12)).toBeNull();
  });

  test("maps local numbering back to the real provider numbering", () => {
    expect(mapLocalEpisodeToProvider(splitCour, 1)).toBe(13);
    expect(mapLocalEpisodeToProvider(splitCour, 12)).toBe(24);
    expect(mapLocalEpisodeToProvider(splitCour, 13)).toBeNull();
  });

  test("detects provider and local overlap independently", () => {
    const firstCour: ProviderEpisodeSegment = {
      providerEpisodeStart: 1,
      providerEpisodeEnd: 12,
      localEpisodeStart: 1,
      localEpisodeEnd: 12,
    };
    const secondCour = splitCour;
    expect(providerSegmentsOverlap(firstCour, secondCour)).toBe(false);
    expect(localSegmentsOverlap(firstCour, secondCour)).toBe(true);
  });
});
