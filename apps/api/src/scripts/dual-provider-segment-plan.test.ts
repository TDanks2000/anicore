import { describe, expect, test } from "bun:test";

import {
  buildAlignedProviderSegment,
  buildDualProviderSegmentPlan,
  type ProviderEpisodeAlignmentRow,
} from "./dual-provider-segment-plan";

function rows(
  animeId: number,
  providerStart: number,
  providerEnd: number,
  localStart: number,
): ProviderEpisodeAlignmentRow[] {
  return Array.from(
    { length: providerEnd - providerStart + 1 },
    (_, index) => ({
      animeId,
      providerEpisodeId: String(10_000 + providerStart + index),
      providerEpisodeNumber: providerStart + index,
      localEpisodeNumber: localStart + index,
      localKind: "normal",
    }),
  );
}

describe("aligned provider segments", () => {
  test("supports an explicit provider 13-24 to local 1-12 offset", () => {
    const result = buildAlignedProviderSegment(20, rows(20, 13, 24, 1));
    expect(result.reason).toBeNull();
    expect(result.segment).toMatchObject({
      providerEpisodeStart: 13,
      providerEpisodeEnd: 24,
      localEpisodeStart: 1,
      localEpisodeEnd: 12,
      offset: 12,
      episodeCount: 12,
    });
  });

  test("rejects a local numbering gap", () => {
    const input = rows(20, 13, 24, 1);
    input[5]!.localEpisodeNumber = 7;
    expect(buildAlignedProviderSegment(20, input).reason).toBe(
      "duplicate-local-episode-number",
    );
  });

  test("rejects non-normal local episodes", () => {
    const input = rows(20, 13, 24, 1);
    input[0]!.localKind = "special";
    expect(buildAlignedProviderSegment(20, input).reason).toBe(
      "non-normal-local-episode",
    );
  });
});

describe("dual provider segment planning", () => {
  test("accepts owner 1-12 followed by orphan 13-24", () => {
    const result = buildDualProviderSegmentPlan(
      "owner-then-orphan-adjacent",
      10,
      rows(10, 1, 12, 1),
      20,
      rows(20, 13, 24, 1),
    );
    expect(result.reason).toBeNull();
    expect(result.ownerSegment?.offset).toBe(0);
    expect(result.orphanSegment?.offset).toBe(12);
  });

  test("accepts orphan first followed by owner", () => {
    const result = buildDualProviderSegmentPlan(
      "orphan-then-owner-adjacent",
      10,
      rows(10, 13, 24, 1),
      20,
      rows(20, 1, 12, 1),
    );
    expect(result.reason).toBeNull();
    expect(result.ownerSegment?.providerEpisodeStart).toBe(13);
    expect(result.orphanSegment?.providerEpisodeEnd).toBe(12);
  });

  test("rejects a provider gap despite an adjacent ownership label", () => {
    const result = buildDualProviderSegmentPlan(
      "owner-then-orphan-adjacent",
      10,
      rows(10, 1, 12, 1),
      20,
      rows(20, 14, 24, 1),
    );
    expect(result.reason).toBe("segment-order-mismatch");
  });
});
