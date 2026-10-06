/** Filter before applying indexes/limits, with numeric rather than lexical ordering. */
export function selectSyncIds(
  ids: number[],
  existingIds: Set<number>,
  newIdsOnly: boolean,
  reverse: boolean,
): number[] {
  return ids
    .filter((id) => !newIdsOnly || !existingIds.has(id))
    .sort((a, b) => (reverse ? b - a : a - b));
}

export function parseIntegerFlag(
  args: string[],
  prefix: string,
  minimum: number,
): number | undefined {
  const value = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (value === undefined) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    const label = prefix.endsWith("=") ? prefix.slice(0, -1) : prefix;
    const requirement = minimum === 0 ? "a non-negative integer" : "a positive integer";
    throw new Error(`${label} must be ${requirement}`);
  }

  return parsed;
}
