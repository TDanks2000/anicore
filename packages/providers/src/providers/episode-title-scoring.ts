export interface NumberedEpisodeTitle {
  number?: number;
  providerEpisodeNumber?: string | null;
  title: string;
}

function explicitEpisodeNumber(title: string): number | null {
  const match =
    title.match(
      /\b(?:episode|ep|session|act|case|chapter)\s*#?\s*(\d{1,4})\b/i,
    ) ?? title.match(/#\s*(\d{1,4})\b/);
  if (!match?.[1]) return null;

  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function hasConflictingExplicitEpisodeNumbers(
  titles: NumberedEpisodeTitle[],
): boolean {
  let checked = 0;
  let matching = 0;
  let conflicting = 0;

  for (const title of titles) {
    const mappedNumber =
      title.number ?? Number(title.providerEpisodeNumber ?? NaN);
    if (!Number.isInteger(mappedNumber) || mappedNumber <= 0) continue;

    const explicitNumber = explicitEpisodeNumber(title.title);
    if (explicitNumber === null) continue;

    checked++;
    if (explicitNumber === mappedNumber) {
      matching++;
    } else {
      conflicting++;
    }
  }

  return checked >= 3 && conflicting > matching;
}
