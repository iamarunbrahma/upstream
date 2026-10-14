import { beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb, type Db } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { maintainers, oauthStates } from "../lib/db/schema";
import {
  MAINTAINER_COOKIE,
  OAUTH_COOKIE,
  OAUTH_STATE_TTL_MS,
  consumeOAuthState,
  createMaintainerSession,
  endMaintainerSession,
  issueOAuthState,
  maintainerCookie,
  maintainerForSession,
  oauthCookie,
} from "../lib/maintainers/sessions";

const NOW = new Date("2026-10-14T10:00:00Z");
let db: Db;
beforeEach(async () => {
  db = createPgliteDb();
  await migrateDb(db, "pglite");
});

describe("OAuth states", () => {
  it("can be used once, by the browser they were issued to, for the provider they were issued for", async () => {
    const state = await issueOAuthState(db, "github", null, NOW);
    expect(await consumeOAuthState(db, "github", state, "someone-elses-cookie", NOW)).toBeNull();
    expect(await consumeOAuthState(db, "paypal", state, state, NOW)).toBeNull();
    expect(await consumeOAuthState(db, "github", state, state, NOW)).toEqual({ githubId: null });
    expect(await consumeOAuthState(db, "github", state, state, NOW)).toBeNull();
  });

  it("remembers who asked to link PayPal, and expires after 10 minutes", async () => {
    const state = await issueOAuthState(db, "paypal", 42, NOW);
    const late = new Date(NOW.getTime() + OAUTH_STATE_TTL_MS + 1);
    expect(await consumeOAuthState(db, "paypal", state, state, late)).toBeNull();
    const fresh = await issueOAuthState(db, "paypal", 42, NOW);
    expect(await consumeOAuthState(db, "paypal", fresh, fresh, NOW)).toEqual({ githubId: 42 });
  });

  it("clears out sign-ins nobody finished, so they can't pile up", async () => {
    await issueOAuthState(db, "github", null, NOW);
    await issueOAuthState(db, "github", null, new Date(NOW.getTime() + 2 * 86_400_000));
    expect(await db.select().from(oauthStates)).toHaveLength(1);
  });

  it("travels in a short-lived cookie that only the sign-in pages see", () => {
    expect(oauthCookie("abc", false)).toBe(`${OAUTH_COOKIE}=abc; HttpOnly; SameSite=Lax; Path=/maintainer; Max-Age=600`);
    expect(oauthCookie(null, true)).toBe(`${OAUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/maintainer; Max-Age=0; Secure`);
  });
});

describe("maintainer sessions", () => {
  it("find the maintainer signed in, until the session ends or expires", async () => {
    await db.insert(maintainers).values({ login: "alice", githubId: 7 });
    const s = await createMaintainerSession(db, 7, NOW);
    expect(await maintainerForSession(db, s, NOW)).toEqual({ login: "alice", githubId: 7 });
    expect(await maintainerForSession(db, s, new Date(NOW.getTime() + 31 * 86_400_000))).toBeNull();
    await endMaintainerSession(db, s);
    expect(await maintainerForSession(db, s, NOW)).toBeNull();
    expect(await maintainerForSession(db, "not-a-session", NOW)).toBeNull();
  });

  it("use their own cookie, separate from a funder's dashboard session", () => {
    expect(maintainerCookie("v", true)).toBe(`${MAINTAINER_COOKIE}=v; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000; Secure`);
    expect(maintainerCookie(null, false)).toBe(`${MAINTAINER_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  });

  it("allow one maintainer row per GitHub account", async () => {
    await db.insert(maintainers).values({ login: "alice", githubId: 7 });
    await expect(db.insert(maintainers).values({ login: "alice-renamed", githubId: 7 })).rejects.toThrow();
  });
});
