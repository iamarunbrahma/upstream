export interface RateLimiter {
  /** Records one hit for `key`; false when the key is already at its limit for the current window. */
  take(key: string): boolean;
  /** Number of keys being tracked. */
  size(): number;
}

/**
 * Sliding-window limiter kept in memory, for a single server instance. At most `maxKeys` keys are tracked:
 * keys whose hits have all expired are dropped first, then the least recently used, so a flood of
 * distinct keys can't exhaust memory.
 */
export function createRateLimiter(opts: { limit: number; windowMs: number; maxKeys?: number; now?: () => number }): RateLimiter {
  const hits = new Map<string, number[]>(); // insertion order = least recently used first
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;

  const shrink = (t: number) => {
    for (const [key, times] of hits) if (t - times[times.length - 1]! >= opts.windowMs) hits.delete(key);
    if (hits.size <= maxKeys) return;
    const target = Math.floor(maxKeys * 0.9);
    for (const key of hits.keys()) {
      if (hits.size <= target) break;
      hits.delete(key);
    }
  };

  return {
    take(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => t - x < opts.windowMs);
      const allowed = recent.length < opts.limit;
      if (allowed) recent.push(t);
      hits.delete(key);
      hits.set(key, recent);
      if (hits.size > maxKeys) shrink(t);
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
