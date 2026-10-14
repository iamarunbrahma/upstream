export interface RateLimiter {
  /** Records one hit for `key`; false when the key is already at its limit for the current window. */
  take(key: string): boolean;
  /** Number of keys being tracked. */
  size(): number;
}

interface Slot {
  start: number;
  count: number;
  /** Hits in the previous window, still partly counted so a caller can't burst across a boundary. */
  prev: number;
}

/**
 * Sliding-window limiter kept in memory, for a single server instance. Every call is O(1) amortized.
 * It keeps a count for the current window plus the previous one, and counts the previous window in
 * proportion to how much of it still overlaps the last `windowMs` (the usual sliding-window estimate).
 * Keys sit roughly in window-start order, so stale keys are dropped from the front. A live key is never
 * dropped (that would reset its limit). If all `maxKeys` keys are live, new keys are refused until the
 * oldest windows end; with the default 100k keys that takes ~100k distinct callers. A shared store with
 * TTLs is the fix once the app runs on more than one instance.
 */
export function createRateLimiter(opts: { limit: number; windowMs: number; maxKeys?: number; now?: () => number }): RateLimiter {
  const slots = new Map<string, Slot>();
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 100_000;
  // Once two windows have passed, neither the current nor the previous count matters any more.
  const stale = (slot: Slot, t: number) => t - slot.start >= 2 * opts.windowMs;

  const dropStaleFront = (t: number) => {
    for (const [key, slot] of slots) {
      if (!stale(slot, t)) return;
      slots.delete(key);
    }
  };

  return {
    take(key) {
      const t = now();
      let slot = slots.get(key);
      if (slot && stale(slot, t)) {
        slots.delete(key);
        slot = undefined;
      } else if (slot && t - slot.start >= opts.windowMs) {
        // Roll forward one window; re-insert so the map stays roughly in window-start order.
        slots.delete(key);
        slot = { start: slot.start + opts.windowMs, count: 0, prev: slot.count };
        slots.set(key, slot);
      }
      if (!slot) {
        if (slots.size >= maxKeys) dropStaleFront(t);
        if (slots.size >= maxKeys) return false;
        slot = { start: t, count: 0, prev: 0 };
        slots.set(key, slot);
      }
      const prevWeight = 1 - (t - slot.start) / opts.windowMs;
      if (slot.count + slot.prev * prevWeight >= opts.limit) return false;
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
