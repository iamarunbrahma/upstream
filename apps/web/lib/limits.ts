export interface RateLimiter {
  /** Records one hit for `key`; false when the key is already at its limit for the current window. */
  take(key: string): boolean;
  /** Number of keys being tracked. */
  size(): number;
}

interface Slot {
  start: number;
  count: number;
}

/**
 * Fixed-window limiter kept in memory, for a single server instance. Every call is O(1) amortized.
 * Keys are stored in window-start order, so expired keys sit at the front and are dropped from there.
 * A live key is never dropped (dropping one would reset its limit). If all `maxKeys` keys are live,
 * new keys are refused until the oldest window ends; with the default 100k keys that takes ~100k distinct
 * callers inside one window. A shared store with TTLs is the fix once the app runs on more than one instance.
 */
export function createRateLimiter(opts: { limit: number; windowMs: number; maxKeys?: number; now?: () => number }): RateLimiter {
  const slots = new Map<string, Slot>();
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 100_000;
  const expired = (slot: Slot, t: number) => t - slot.start >= opts.windowMs;

  const dropExpiredFront = (t: number) => {
    for (const [key, slot] of slots) {
      if (!expired(slot, t)) return;
      slots.delete(key);
    }
  };

  return {
    take(key) {
      const t = now();
      let slot = slots.get(key);
      if (slot && expired(slot, t)) {
        slots.delete(key);
        slot = undefined;
      }
      if (!slot) {
        if (slots.size >= maxKeys) dropExpiredFront(t);
        if (slots.size >= maxKeys) return false;
        slot = { start: t, count: 0 };
        slots.set(key, slot);
      }
      if (slot.count >= opts.limit) return false;
      slot.count += 1;
      return true;
    },
    size: () => slots.size,
  };
}

export class RateLimitError extends Error {
  constructor() {
    super("too many receipts this hour, try again later");
  }
}
