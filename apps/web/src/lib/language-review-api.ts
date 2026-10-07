import { withRequestDeadline } from "@anicore/sync-monitor/request";
import type { AnimeLanguageStatusRow, LanguageMediaType } from "./anime-api";

export interface LanguageReviewItem extends AnimeLanguageStatusRow {
  anime: { id: number; titleRomaji: string; titleEnglish: string | null } | null;
}

export interface LanguageReviewFilters {
  languageCode: string;
  mediaType: "" | LanguageMediaType;
  status: "" | "unknown" | "possible";
}

export class LanguageReviewRequestError extends Error {
  constructor(public readonly status: number) {
    super(
      status === 401
        ? "Admin session expired or token rejected. Connect with a valid admin token."
        : status === 503
          ? "Admin access is disabled. Configure ANICORE_ADMIN_TOKEN on the API."
          : `Unable to load the review queue (HTTP ${status}).`,
    );
  }
}

export async function fetchLanguageReviewQueue(
  baseUrl: string,
  token: string,
  filters: LanguageReviewFilters,
  page: number,
  signal?: AbortSignal,
): Promise<{ items: LanguageReviewItem[]; total: number | null }> {
  const params = new URLSearchParams({
    includeAnime: "true",
    limit: "25",
    offset: String((page - 1) * 25),
  });
  if (filters.languageCode.trim()) params.set("languageCode", filters.languageCode.trim());
  if (filters.mediaType) params.set("mediaType", filters.mediaType);
  if (filters.status) params.set("status", filters.status);
  return withRequestDeadline(async (requestSignal) => {
    const response = await fetch(
      `${baseUrl.replace(/\/+$/, "")}/admin/language-status/review-queue?${params}`,
      {
        signal: requestSignal,
        cache: "no-store",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      },
    );
    if (!response.ok) throw new LanguageReviewRequestError(response.status);
    const items = (await response.json()) as LanguageReviewItem[];
    // Older deployments ignore includeAnime; don't silently show a broken workspace.
    if (!Array.isArray(items) || items.some((item) => !("anime" in item)))
      throw new Error("This API does not support the review workspace yet. Update the API first.");
    const raw = response.headers.get("X-Total-Count");
    const total = raw === null || raw.trim() === "" ? null : Number(raw);
    return {
      items,
      total: total !== null && Number.isInteger(total) && total >= 0 ? total : null,
    };
  }, signal);
}
