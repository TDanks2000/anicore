/** A small LRU cache; stale values remain available while a refresh is in flight. */
export class DetailCache<T> {
  private entries = new Map<string, { value: T; checkedAt: number }>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly maxEntries = 50,
  ) {}

  get(key: string, now = Date.now()): { value: T; fresh: boolean } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return {
      value: entry.value,
      fresh: now >= entry.checkedAt && now - entry.checkedAt < this.ttlMs,
    };
  }

  set(key: string, value: T, now = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, checkedAt: now });
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.checkedAt = Number.NEGATIVE_INFINITY;
  }

  invalidateAll(): void {
    for (const entry of this.entries.values()) entry.checkedAt = Number.NEGATIVE_INFINITY;
  }
}
