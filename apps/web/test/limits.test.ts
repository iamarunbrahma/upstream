import { describe, expect, it } from "vitest";
import { clientKey } from "../lib/http";
import { createRateLimiter } from "../lib/limits";

describe("createRateLimiter", () => {
  it("keeps memory bounded when it sees many distinct keys", () => {
    const lim = createRateLimiter({ limit: 5, windowMs: 1000, maxKeys: 100, now: () => 0 });
    for (let i = 0; i < 10_000; i++) lim.take(`k${i}`);
    expect(lim.size()).toBeLessThanOrEqual(100);
  });

  it("drops keys whose hits have all expired before evicting live ones", () => {
    let t = 0;
    const lim = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 2, now: () => t });
    lim.take("old");
    t = 2000;
    lim.take("live");
    lim.take("new");
    expect(lim.take("live")).toBe(false);
  });
});

describe("createRateLimiter under a flood", () => {
  it("never evicts a key that is at its limit, so flooding with new keys can't reset it", () => {
    const lim = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 10, now: () => 0 });
    expect(lim.take("attacker")).toBe(true);
    expect(lim.take("attacker")).toBe(false);
    for (let i = 0; i < 1000; i++) lim.take(`junk-${i}`);
    expect(lim.take("attacker")).toBe(false);
    expect(lim.size()).toBeLessThanOrEqual(10);
  });
});

describe("createRateLimiter windows", () => {
  it("doesn't let a caller double the limit across a window boundary", () => {
    let t = 0;
    const lim = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
    lim.take("a");
    t = 990;
    lim.take("a"); // limit used up at the end of the first window
    let allowed = 0;
    for (t = 1000; t <= 1002; t++) allowed += Number(lim.take("a"));
    expect(allowed).toBe(1); // a plain fixed window would allow 2 more here
    t = 2600;
    expect(lim.take("a")).toBe(true);
  });
});

describe("createRateLimiter cost", () => {
  it("handles a flood of new keys in constant time per call", () => {
    const lim = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2000, now: () => 0 });
    const start = performance.now();
    for (let i = 0; i < 200_000; i++) lim.take(`k${i}`);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("clientKey", () => {
  const withXff = (xff: string) => new Request("http://x", { headers: { "x-forwarded-for": xff } });

  it("uses the address the hosting proxy appended, not one the client sent", () => {
    expect(clientKey(withXff("203.0.113.9"))).toBe("203.0.113.9");
    expect(clientKey(withXff("1.1.1.1, 203.0.113.9"))).toBe("203.0.113.9");
    expect(clientKey(withXff("9.9.9.9, 8.8.8.8, 203.0.113.9"))).toBe("203.0.113.9");
  });

  it("falls back to one shared key when there is no proxy header", () => {
    expect(clientKey(new Request("http://x"))).toBe("unknown");
  });
});
