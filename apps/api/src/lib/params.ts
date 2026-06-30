export function parseId(value: string): number | null {
  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  return id;
}

export function parseLimit(value: string | undefined, fallback = 50): number {
  const limit = Number(value ?? fallback);

  if (!Number.isInteger(limit) || limit <= 0) {
    return fallback;
  }

  return Math.min(limit, 100);
}
