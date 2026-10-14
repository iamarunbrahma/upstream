import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { maintainers } from "../lib/db/schema";
import type { GithubOAuth } from "../lib/maintainers/github-oauth";
import type { PayPalIdentity } from "../lib/maintainers/paypal-identity";
import { MAINTAINER_COOKIE, OAUTH_COOKIE, maintainerForSession } from "../lib/maintainers/sessions";
import { createRateLimiter } from "../lib/limits";
import type { Deps } from "../lib/receipts/service";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
const { GET: githubStart } = await import("../app/maintainer/github/start/route");
const { GET: githubCallback } = await import("../app/maintainer/github/callback/route");
const { GET: paypalStart } = await import("../app/maintainer/paypal/start/route");
const { GET: paypalCallback } = await import("../app/maintainer/paypal/callback/route");
const { POST: signOut } = await import("../app/maintainer/signout/route");

/** Who GitHub and PayPal say each code belongs to. */
let githubCodes: Record<string, { id: number; login: string } | null>;
let paypalCodes: Record<string, { payerId: string | null; verified: boolean | null } | null>;
const githubOAuth: GithubOAuth = {
  authorizeUrl: (state, redirectUri) => `https://github.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  identify: async (code) => githubCodes[code] ?? null,
};
const paypalIdentity: PayPalIdentity = {
  authorizeUrl: (state) => `https://paypal.test/authorize?state=${state}`,
  identify: async (code) => paypalCodes[code] ?? null,
};

beforeEach(async () => {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  h.deps = { db, http: async () => ({ status: 404, body: null }), model: null, githubOAuth, paypalIdentity } as unknown as Deps;
  githubCodes = { alice: { id: 7, login: "Alice" }, bob: { id: 8, login: "bob" } };
  paypalCodes = { ok: { payerId: "PAYER-A", verified: true }, unverified: { payerId: "PAYER-U", verified: false } };
});

const cookieValue = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0]!
    .slice(name.length + 1);
const get = (path: string, cookies: Record<string, string | undefined> = {}) =>
  new Request(`http://up.test${path}`, {
    headers: { cookie: Object.entries(cookies).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ") },
  });

/** Runs the whole GitHub sign-in for this code and returns the maintainer session cookie value. */
async function signIn(code: string): Promise<string> {
  const start = await githubStart(get("/maintainer/github/start"));
  const state = cookieValue(start, OAUTH_COOKIE)!;
  const done = await githubCallback(get(`/maintainer/github/callback?code=${code}&state=${state}`, { [OAUTH_COOKIE]: state }));
  expect(done.status).toBe(303);
  return cookieValue(done, MAINTAINER_COOKIE)!;
}

describe("GitHub sign-in routes", () => {
  it("send people to GitHub with a state held in a cookie, then sign them in", async () => {
    const start = await githubStart(get("/maintainer/github/start"));
    expect(start.status).toBe(302);
    const state = cookieValue(start, OAUTH_COOKIE)!;
    const to = new URL(start.headers.get("location")!);
    expect(to.searchParams.get("state")).toBe(state);
    expect(to.searchParams.get("redirect_uri")).toBe("http://up.test/maintainer/github/callback");
    const done = await githubCallback(get(`/maintainer/github/callback?code=alice&state=${state}`, { [OAUTH_COOKIE]: state }));
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/maintainer");
    expect(cookieValue(done, OAUTH_COOKIE)).toBe("");
    expect(await maintainerForSession(h.deps.db, cookieValue(done, MAINTAINER_COOKIE)!)).toEqual({ login: "alice", githubId: 7 });
  });

  it("refuse a sign-in that didn't start in this browser, or that was already used", async () => {
    const start = await githubStart(get("/maintainer/github/start"));
    const state = cookieValue(start, OAUTH_COOKIE)!;
    expect((await githubCallback(get(`/maintainer/github/callback?code=alice&state=${state}`))).status).toBe(400);
    expect((await githubCallback(get(`/maintainer/github/callback?code=alice&state=${state}`, { [OAUTH_COOKIE]: "planted" }))).status).toBe(400);
    expect((await githubCallback(get(`/maintainer/github/callback?code=alice&state=${state}`, { [OAUTH_COOKIE]: state }))).status).toBe(303);
    expect((await githubCallback(get(`/maintainer/github/callback?code=alice&state=${state}`, { [OAUTH_COOKIE]: state }))).status).toBe(400);
  });

  it("say plainly when GitHub doesn't confirm who someone is, and sign in whoever holds a reused login now", async () => {
    const start = async () => cookieValue(await githubStart(get("/maintainer/github/start")), OAUTH_COOKIE)!;
    let s = await start();
    const refused = await githubCallback(get(`/maintainer/github/callback?code=nobody&state=${s}`, { [OAUTH_COOKIE]: s }));
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("GitHub didn't confirm who you are");
    await h.deps.db.insert(maintainers).values({ login: "bob", githubId: 99 });
    s = await start();
    const reused = await githubCallback(get(`/maintainer/github/callback?code=bob&state=${s}`, { [OAUTH_COOKIE]: s }));
    expect(reused.status).toBe(303);
    expect(await maintainerForSession(h.deps.db, cookieValue(reused, MAINTAINER_COOKIE)!)).toEqual({ login: "bob", githubId: 8 });
  });

  it("limit how often one visitor can start signing in", async () => {
    h.deps = { ...h.deps, signInLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }) } as unknown as Deps;
    const start = () => githubStart(new Request("http://up.test/maintainer/github/start", { headers: { "x-forwarded-for": "203.0.113.9" } }));
    expect((await start()).status).toBe(302);
    expect((await start()).status).toBe(302);
    expect((await start()).status).toBe(429);
  });

  it("are switched off until GitHub sign-in is set up", async () => {
    h.deps = { ...h.deps, githubOAuth: null } as unknown as Deps;
    expect((await githubStart(get("/maintainer/github/start"))).status).toBe(503);
  });
});

describe("Log in with PayPal routes", () => {
  it("link PayPal only for a signed-in maintainer, to the maintainer who started it", async () => {
    expect((await paypalStart(get("/maintainer/paypal/start"))).status).toBe(401);
    const alice = await signIn("alice");
    const start = await paypalStart(get("/maintainer/paypal/start", { [MAINTAINER_COOKIE]: alice }));
    expect(start.status).toBe(302);
    const state = cookieValue(start, OAUTH_COOKIE)!;
    const bob = await signIn("bob");
    const hijack = await paypalCallback(get(`/maintainer/paypal/callback?code=ok&state=${state}`, { [MAINTAINER_COOKIE]: bob, [OAUTH_COOKIE]: state }));
    expect(hijack.status).toBe(400);

    const again = cookieValue(await paypalStart(get("/maintainer/paypal/start", { [MAINTAINER_COOKIE]: alice })), OAUTH_COOKIE)!;
    const done = await paypalCallback(get(`/maintainer/paypal/callback?code=ok&state=${again}`, { [MAINTAINER_COOKIE]: alice, [OAUTH_COOKIE]: again }));
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/maintainer?paypal=linked");
    const [row] = await h.deps.db.select().from(maintainers).where(eq(maintainers.githubId, 7));
    expect(row!.paypalPayerId).toBe("PAYER-A");
  });

  it("explain a server setup problem, not the maintainer's, when PayPal leaves out an account attribute", async () => {
    paypalCodes.partial = { payerId: "PAYER-P", verified: null };
    const alice = await signIn("alice");
    const state = cookieValue(await paypalStart(get("/maintainer/paypal/start", { [MAINTAINER_COOKIE]: alice })), OAUTH_COOKIE)!;
    const res = await paypalCallback(get(`/maintainer/paypal/callback?code=partial&state=${state}`, { [MAINTAINER_COOKIE]: alice, [OAUTH_COOKIE]: state }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("isn't fully set up");
    const [row] = await h.deps.db.select().from(maintainers).where(eq(maintainers.githubId, 7));
    expect(row!.paypalPayerId).toBeNull();
  });

  it("tell the maintainer when PayPal won't link the account", async () => {
    const alice = await signIn("alice");
    const state = cookieValue(await paypalStart(get("/maintainer/paypal/start", { [MAINTAINER_COOKIE]: alice })), OAUTH_COOKIE)!;
    const res = await paypalCallback(get(`/maintainer/paypal/callback?code=unverified&state=${state}`, { [MAINTAINER_COOKIE]: alice, [OAUTH_COOKIE]: state }));
    expect(res.headers.get("location")).toBe("/maintainer?paypal=not-verified");
  });
});

describe("sign out", () => {
  it("ends the maintainer's session, but only when asked from this site", async () => {
    const alice = await signIn("alice");
    const post = (origin?: string) =>
      signOut(new Request("http://up.test/maintainer/signout", { method: "POST", headers: { cookie: `${MAINTAINER_COOKIE}=${alice}`, host: "up.test", ...(origin ? { origin } : {}) } }));
    expect((await post("https://evil.example")).status).toBe(403);
    const res = await post("http://up.test");
    expect(res.status).toBe(303);
    expect(cookieValue(res, MAINTAINER_COOKIE)).toBe("");
    expect(await maintainerForSession(h.deps.db, alice)).toBeNull();
  });
});
