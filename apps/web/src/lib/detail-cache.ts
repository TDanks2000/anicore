const DETAIL_TTL_MS = 60_000;
const MAX_DETAILS = 50;

/** A small LRU cache; stale values remain available while a refresh is in flight. */
export class DetailCache<T> {
  private entries = new Map<string, { value: T; checkedAt: number }>();

  get(key: string, now = Date.now()): { value: T; fresh: boolean } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return {
      value: entry.value,
      fresh: now >= entry.checkedAt && now - entry.checkedAt < DETAIL_TTL_MS,
    };
  }

  set(key: string, value: T, now = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, checkedAt: now });
    if (this.entries.size > MAX_DETAILS) this.entries.delete(this.entries.keys().next().value!);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.checkedAt = Number.NEGATIVE_INFINITY;
  }
}
