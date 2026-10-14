export interface RateLimiter {
  /** Records one hit for `key`; false when the key is already at its limit for the current window. */
  take(key: string): boolean;
  /** Number of keys being tracked. */
  size(): number;
}

/**
 * Sliding-window limiter kept in memory, for a single server instance. At most `maxKeys` keys are tracked.
 * When full it drops keys whose hits have expired, then the least recently used keys that are under their
 * limit. A key at its limit is never dropped (that would reset it); if every tracked key is at its limit,
 * new keys are refused until the window passes.
 */
export function createRateLimiter(opts: { limit: number; windowMs: number; maxKeys?: number; now?: () => number }): RateLimiter {
  const hits = new Map<string, number[]>(); // insertion order = least recently used first
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  const live = (times: number[], t: number) => times.filter((x) => t - x < opts.windowMs);

  const makeRoom = (t: number) => {
    for (const [key, times] of hits) if (live(times, t).length === 0) hits.delete(key);
    if (hits.size < maxKeys) return;
    const target = Math.floor(maxKeys * 0.9);
    for (const [key, times] of hits) {
      if (hits.size <= target) break;
      if (live(times, t).length < opts.limit) hits.delete(key);
    }
  };

  return {
    take(key) {
      const t = now();
      if (!hits.has(key) && hits.size >= maxKeys) {
        makeRoom(t);
        if (hits.size >= maxKeys) return false;
      }
      const recent = live(hits.get(key) ?? [], t);
      const allowed = recent.length < opts.limit;
      if (allowed) recent.push(t);
      hits.delete(key);
      hits.set(key, recent);
      return allowed;
    },
    size: () => hits.size,
  };
}

export class RateLimitError extends Error {
  constructor() {
    super("too many receipts this hour, try again later");
  }
}
