export interface UsageEntry {
  lastUsedMs: number;
  /** Explicit prefix this resource belongs to, or null if not tenant-managed. */
  prefix: string | null;
}

/**
 * Tracks last-used timestamps and explicit prefix ownership for resources.
 * Designed to be wired into stores via an optional field — when undefined,
 * the optional chaining `store.usageTracker?.touch()` is a single falsy check.
 */
export class UsageTracker {
  private entries = new Map<string, UsageEntry>();

  /** Update the last-used timestamp for an already-registered resource. No-op if not registered. */
  touch(name: string): void {
    const entry = this.entries.get(name);
    if (entry) {
      entry.lastUsedMs = Date.now();
    }
  }

  /** Register a resource with an explicit prefix. Also sets lastUsedMs to now. */
  register(name: string, prefix: string | null): void {
    this.entries.set(name, { lastUsedMs: Date.now(), prefix });
  }

  /** Remove a resource from tracking. */
  delete(name: string): void {
    this.entries.delete(name);
  }

  /** Get the entry for a resource, or undefined if not tracked. */
  get(name: string): UsageEntry | undefined {
    return this.entries.get(name);
  }

  /** Number of tracked resources. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Iterate entries starting after `cursor`. Returns up to `budget` entries.
   * When the end is reached, wraps around to the beginning.
   * Returns the entries visited and whether a full cycle was completed.
   */
  scan(
    cursor: string | undefined,
    budget: number,
  ): { visited: Array<[string, UsageEntry]>; nextCursor: string | undefined; wrapped: boolean } {
    const maxToVisit = Math.min(budget, this.entries.size);
    const visited: Array<[string, UsageEntry]> = [];
    let wrapped = false;
    let pastCursor = cursor === undefined;

    // First pass: from cursor to end
    for (const [name, entry] of this.entries) {
      if (visited.length >= maxToVisit) {
        const nextCursor = visited.length > 0 ? visited[visited.length - 1][0] : cursor;
        return { visited, nextCursor, wrapped: false };
      }
      if (!pastCursor) {
        if (name === cursor) {
          pastCursor = true;
        }
        continue;
      }
      visited.push([name, entry]);
    }

    // Wrapped around — continue from start up to and including cursor
    wrapped = true;
    for (const [name, entry] of this.entries) {
      if (visited.length >= maxToVisit) break;
      visited.push([name, entry]);
      if (cursor !== undefined && name === cursor) break;
    }

    const nextCursor = visited.length > 0 ? visited[visited.length - 1][0] : undefined;
    return { visited, nextCursor, wrapped };
  }

  /** Get all entries — primarily for listing/inspection. */
  allEntries(): ReadonlyMap<string, UsageEntry> {
    return this.entries;
  }

  /** Clear all entries. */
  clear(): void {
    this.entries.clear();
  }
}
