import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import type { Deps } from "../lib/receipts/service";
import {
  accountForSession, consumeLoginCode, createLoginCode, createSession, LOGIN_CODE_TTL_MS, peekLoginCode, readCookie, sameOrigin,
  SESSION_COOKIE, SESSION_TTL_MS,
} from "../lib/web-auth";
import { fakeRegistry, payload } from "./helpers";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
const { POST: postLoginLink } = await import("../app/api/login-links/route");
const { GET: connectPage, POST: connectPost } = await import("../app/connect/route");
const { GET: listReceipts, POST: postReceipt } = await import("../app/api/receipts/route");

beforeEach(async () => {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  h.deps = { db, http: fakeRegistry, model: null };
});

describe("login codes and sessions", () => {
  it("lets a login code be used once, within 10 minutes", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    const t0 = new Date("2026-10-14T10:00:00Z");
    const code = await createLoginCode(h.deps.db, accountId, t0);
    expect(await peekLoginCode(h.deps.db, code, t0)).toBe(accountId);
    expect(await consumeLoginCode(h.deps.db, code, t0)).toBe(accountId);
    expect(await peekLoginCode(h.deps.db, code, t0)).toBeNull();
    expect(await consumeLoginCode(h.deps.db, code, t0)).toBeNull();
    const late = await createLoginCode(h.deps.db, accountId, t0);
    expect(await consumeLoginCode(h.deps.db, late, new Date(t0.getTime() + LOGIN_CODE_TTL_MS + 1))).toBeNull();
    expect(await consumeLoginCode(h.deps.db, "made-up")).toBeNull();
  });

  it("finds the account for a live session and nothing after it expires", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    const t0 = new Date("2026-10-14T10:00:00Z");
    const value = await createSession(h.deps.db, accountId, t0);
    expect(await accountForSession(h.deps.db, value, t0)).toBe(accountId);
    expect(await accountForSession(h.deps.db, value, new Date(t0.getTime() + SESSION_TTL_MS + 1))).toBeNull();
  });

  it("reads cookies and checks the request origin", () => {
    const req = (headers: Record<string, string>) => new Request("http://up.test/x", { headers });
    expect(readCookie(req({ cookie: `a=1; ${SESSION_COOKIE}=abc=; b=2` }), SESSION_COOKIE)).toBe("abc=");
    expect(readCookie(req({}), SESSION_COOKIE)).toBeNull();
    expect(sameOrigin(req({ origin: "http://up.test", host: "up.test" }))).toBe(true);
    expect(sameOrigin(req({ origin: "https://evil.example", host: "up.test" }))).toBe(false);
    expect(sameOrigin(req({ host: "up.test" }))).toBe(false);
  });
});

describe("login link to dashboard session", () => {
  async function linkFor(token: string): Promise<string> {
    const res = await postLoginLink(new Request("http://up.test/api/login-links", { method: "POST", headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(201);
    return ((await res.json()) as { url: string }).url;
  }
  const confirm = (url: string, origin = "http://up.test") =>
    connectPost(
      new Request("http://up.test/connect", {
        method: "POST",
        headers: { origin, host: "up.test", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: new URL(url).searchParams.get("code")! }).toString(),
      }),
    );
  async function signIn(token: string): Promise<string> {
    const res = await confirm(await linkFor(token));
    return res.headers.get("set-cookie")!.split(";")[0]!;
  }

  it("asks before signing in, so opening someone else's link can't sign you in to their account", async () => {
    const { token } = await createDevice(h.deps.db, null);
    const url = await linkFor(token);
    expect(url).toMatch(/^http:\/\/up\.test\/connect\?code=/);
    const page = await connectPage(new Request(url));
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toBeNull();
    const html = await page.text();
    expect(html).toContain('<form method="post" action="/connect">');
    expect(html).toContain("Only continue if you just ran");
    expect((await connectPage(new Request(url))).status).toBe(200);

    const first = await confirm(url);
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/dashboard");
    const cookie = first.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[\\w-]+; HttpOnly; SameSite=Lax; Path=/`));
    expect((await confirm(url)).status).toBe(400);
    expect((await connectPage(new Request(url))).status).toBe(400);

    const sessionHeader = { cookie: cookie.split(";")[0]! };
    expect((await listReceipts(new Request("http://up.test/api/receipts", { headers: sessionHeader }))).status).toBe(200);
  });

  it("lets the browser send this site's origin when Continue is clicked", async () => {
    // Under "no-referrer" a browser posts the form with `Origin: null`, which the same-site check refuses.
    const { token } = await createDevice(h.deps.db, null);
    const page = await connectPage(new Request(await linkFor(token)));
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("refuses a sign-in posted from another site, and the link still works afterwards", async () => {
    const { token } = await createDevice(h.deps.db, null);
    const url = await linkFor(token);
    expect((await confirm(url, "https://evil.example")).status).toBe(403);
    expect((await confirm(url)).status).toBe(303);
  });

  it("refuses a login link without a device token", async () => {
    expect((await postLoginLink(new Request("http://up.test/api/login-links", { method: "POST" }))).status).toBe(401);
  });

  it("refuses cookie-authenticated writes from another site", async () => {
    const { token } = await createDevice(h.deps.db, null);
    const cookie = await signIn(token);
    const post = (origin: string) =>
      postReceipt(
        new Request("http://up.test/api/receipts", {
          method: "POST",
          headers: { cookie, origin, host: "up.test", "content-type": "application/json" },
          body: JSON.stringify(payload()),
        }),
      );
    expect((await post("https://evil.example")).status).toBe(403);
    expect((await post("http://up.test")).status).toBe(200);
  });
});
