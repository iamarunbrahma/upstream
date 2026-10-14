import { describe, expect, it } from "vitest";
import { accountForToken, bearerToken, createDevice, hashToken, newToken } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { packageCache } from "../lib/db/schema";
import { CACHE_TTL_MS, resolveWithCache } from "../lib/resolver/cache";
import type { HttpGetJson } from "../lib/resolver/registry";

async function freshDb() {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  return db;
}

const counting = (status: number, body: unknown) => {
  const state = { calls: 0 };
  const http: HttpGetJson = async () => {
    state.calls++;
    return { status, body };
  };
  return { http, state };
};

describe("device tokens", () => {
  it("creates a device whose token maps back to its account, storing only a hash", async () => {
    const db = await freshDb();
    const { token, accountId } = await createDevice(db, "laptop");
    expect(token).toMatch(/^upk_[\w-]{32}$/);
    expect(await accountForToken(db, token)).toBe(accountId);
    expect(await accountForToken(db, newToken())).toBeNull();
    expect(hashToken(token)).not.toContain(token);
  });

  it("reads bearer tokens from the Authorization header", () => {
    expect(bearerToken(new Request("http://x", { headers: { authorization: "Bearer upk_abc" } }))).toBe("upk_abc");
    expect(bearerToken(new Request("http://x"))).toBeNull();
  });
});

describe("resolveWithCache", () => {
  const zod = { status: 200, body: { description: "schema validation", homepage: "https://zod.dev" } };

  it("fetches once and serves from cache within the TTL", async () => {
    const db = await freshDb();
    const { http, state } = counting(zod.status, zod.body);
    const t0 = new Date("2026-10-14T00:00:00Z");
    expect((await resolveWithCache(db, "npm", "zod", http, t0)).description).toBe("schema validation");
    await resolveWithCache(db, "npm", "zod", http, new Date(t0.getTime() + 1000));
    expect(state.calls).toBe(1);
    await resolveWithCache(db, "npm", "zod", http, new Date(t0.getTime() + CACHE_TTL_MS + 1));
    expect(state.calls).toBe(2);
  });

  it("ignores answers cached by an older version of the lookup", async () => {
    const db = await freshDb();
    const stale = { ecosystem: "npm" as const, name: "zod", found: true, description: "old answer", homepage: null, repo: null, docsHosts: [], fundingUrls: [] };
    await db.insert(packageCache).values({ key: "npm:zod", data: stale, fetchedAt: new Date() });
    const { http, state } = counting(zod.status, zod.body);
    expect((await resolveWithCache(db, "npm", "zod", http)).description).toBe("schema validation");
    expect(state.calls).toBe(1);
  });

  it("does not cache server errors and returns not-found meanwhile", async () => {
    const db = await freshDb();
    const down = counting(503, null);
    expect((await resolveWithCache(db, "npm", "zod", down.http)).found).toBe(false);
    const up = counting(zod.status, zod.body);
    expect((await resolveWithCache(db, "npm", "zod", up.http)).found).toBe(true);
    expect(up.state.calls).toBe(1);
  });
});
