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
