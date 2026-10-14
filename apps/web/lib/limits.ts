export interface RateLimiter {
  /** Records one hit for `key`; false when the key is already at its limit for the current window. */
  take(key: string): boolean;
}

/** Sliding-window limiter kept in memory. Enough for one server instance; a shared store is needed if it scales out. */
export function createRateLimiter(opts: { limit: number; windowMs: number; now?: () => number }): RateLimiter {
  const hits = new Map<string, number[]>();
  const now = opts.now ?? Date.now;
  return {
    take(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => t - x < opts.windowMs);
      if (recent.length >= opts.limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
  };
}

export class RateLimitError extends Error {
  constructor() {
    super("too many receipts this hour, try again later");
  }
}
