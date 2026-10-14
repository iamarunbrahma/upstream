# Upstream Plan 2c: Maintainer Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A maintainer signs in with GitHub, which proves which GitHub account they are, and links a verified PayPal account with Log in with PayPal. From then on, Plan 2b's settlements pay them for real. A maintainer page shows:
- what's waiting for them, what's on its way, and what's been paid
- their payouts, and how agents use their packages

**Architecture:**
- **Two OAuth sign-ins, both protected the same way.** The `state` sent to GitHub or PayPal is random, single use and valid for 10 minutes. Its hash is stored, and the value is also kept in an HttpOnly cookie scoped to `/maintainer`. A callback is accepted only when the returned state matches that browser's cookie. So a sign-in another site starts can't finish in someone else's browser. A PayPal link must also be finished by the same maintainer who started it.
- **Identity is GitHub's numeric id**, not the login, as Plan 2b's ledger requires. A renamed login moves the maintainer's row and what they're owed. A login that another GitHub account holds here is refused.
- **Maintainer sessions are separate from funder sessions.** They use their own table and their own cookie, because one person can be both.
- **Lock:** linking PayPal and moving money to a renamed login both take Plan 2b's `SETTLE_LOCK`, so they never interleave with a settlement.

**Tech Stack:** Plans 1, 2a and 2b's stack. No new dependencies. Adds GitHub's OAuth web flow, and PayPal's Log in with PayPal (OpenID Connect: `/signin/authorize`, `/v1/oauth2/token` with `authorization_code`, `/v1/identity/oauth2/userinfo`).

**Spec:** `docs/superpowers/specs/2026-10-14-upstream-design.md`. This plan implements:
- section 2 step 6 (maintainers sign in with GitHub and link PayPal)
- section 7's `PAYPAL_ID` receivers coming from Log in with PayPal
- section 8 screen 4 (the maintainer page), and its "how agents use your package" as an anonymous role mix. Session titles are left out on purpose: a title can identify a funder's project.

It also does what Plan 2b's ledger asked of 2c: key identity on `githubId`, restart the hold when the PayPal account changes, and never let two logins share a PayPal account.

**Verified 14 Oct 2026**, every task applied in a scratch worktree of `main` (commit a4072c1):
- 288 tests pass across 45 files, with one Postgres-only test skipped.
- The web app typechecks, and `next build` lists `/maintainer`, the four sign-in routes, `/maintainer/signout` and `/api/maintainer/me`.
- The **live** check (Task 7) needs the hosted https address, because PayPal refuses `localhost` return URLs. It runs after the Render deploy.

**Builds on:** Plans 1, 2a and 2b on `main`. Ledgers: `docs/superpowers/plans/2026-10-14-plan-2b-ledger.md`. What matters from 2b:
- the `maintainers` table: `login`, `githubId`, `paypalPayerId`, `claimedAt`
- `FIRST_PAYOUT_HOLD_MS`
- `withSettleLock`
- `paypalApiBase`
- `clientKey`
- `sameOrigin`
- `createRateLimiter`

## Global Constraints

- All of Plan 1's, 2a's and 2b's Global Constraints still apply:
  - versions, ESM, strict TypeScript
  - single-line commits, no attribution
  - plain user copy, no em dashes
  - integer cents, USD only
- **No new dependencies.**
- **OAuth state:**
  - Random 32 bytes, base64url.
  - Only its hash (`hashToken`) is stored.
  - Single use, valid for `OAUTH_STATE_TTL_MS` = 10 minutes.
  - Compared to the `upstream_oauth` cookie in constant time.
  - States that expired more than a day ago are deleted when a new one is issued.
- **Cookies:**
  - The maintainer session cookie `upstream_maintainer` is `HttpOnly; SameSite=Lax; Path=/`, lasts 30 days, and adds `Secure` in production.
  - The OAuth cookie `upstream_oauth` is `HttpOnly; SameSite=Lax; Path=/maintainer`, with a 10-minute Max-Age, and is cleared on every callback.
- **No open redirects.** Every redirect goes to a fixed path (`/maintainer`, `/maintainer?paypal=<result>`) or to the provider's own authorize URL.
- **Return addresses** are `<PUBLIC_URL or the request origin>/maintainer/github/callback` and `/maintainer/paypal/callback`. Use `PUBLIC_URL?.trim() ||`, never `??`, because an empty value from an env file must fall back.
- **GitHub sign-in:**
  - Scope `""` (public identity only), with `allow_signup=false`.
  - Only `type: "User"` accounts sign in.
- **Log in with PayPal:**
  - Scope `openid https://uri.paypal.com/services/paypalattributes`.
  - Only `verified_account` true or `"true"` links.
  - The sandbox app's sign-in is `www.sandbox.paypal.com`, and live is `www.paypal.com`.
- **Linking:**
  - One PayPal account per maintainer (`UNIQUE paypal_payer_id`).
  - A *different* account restarts the 7-day hold (`claimedAt = now`); the same account changes nothing.
  - It runs under `SETTLE_LOCK`.
- **Limits:** `signInLimiter` allows 30 starts of a GitHub sign-in or PayPal link per client per hour.

## Review Focus

1. **Login CSRF and link CSRF.** These must all be refused:
   - a callback whose state wasn't started in this browser (no cookie, or a planted cookie)
   - a state used twice, or after 10 minutes
   - a PayPal link finished by a different maintainer than the one who started it

   The tests live in Tasks 1 and 4.
2. **Linking a PayPal account that shouldn't be linked.** This means:
   - an unverified account
   - one already linked to another maintainer
   - two maintainers racing to link the same account

   The check runs under the lock, with the `UNIQUE` constraint as a backstop. The tests live in Task 2.
3. **Renamed and reused GitHub logins.** Money follows the GitHub id. A reused login never inherits someone else's row or money. A sandbox-seeded claim is taken over by the first GitHub account to sign in with that login. The tests live in Task 2.
4. **Changing the linked PayPal account.** The hold restarts, so a stolen session can't redirect the next payout at once. Payout lines already queued keep the account they were queued for. The tests live in Task 2.
5. **Sessions and redirects.**
   - Every sign-in creates a new session.
   - Sign-out needs a same-site POST.
   - Redirects never point anywhere a request chose.
   - Error pages are plain words, with no details from the provider.

   The tests live in Task 4.

## File Structure

```
apps/web/
  lib/db/schema.ts                  maintainers.githubId UNIQUE; + maintainer_sessions, oauth_states
  drizzle/0004_*.sql                generated, additive only
  lib/maintainers/sessions.ts       OAuth states, maintainer sessions, their cookies
  lib/maintainers/claims.ts         signInMaintainer (by GitHub id), linkPayPal (verified, unique, hold restarts)
  lib/maintainers/github-oauth.ts   GitHub OAuth web flow client
  lib/maintainers/paypal-identity.ts Log in with PayPal client
  lib/maintainers/http.ts           publicOrigin, redirect, plainPage, signedInMaintainer
  lib/maintainers/summary.ts        maintainerSummary
  lib/receipts/service.ts           Deps + githubOAuth, paypalIdentity, signInLimiter
  lib/deps.ts                       wires them from env
  app/maintainer/github/{start,callback}/route.ts
  app/maintainer/paypal/{start,callback}/route.ts
  app/maintainer/signout/route.ts
  app/api/maintainer/me/route.ts
  app/maintainer/page.tsx, MaintainerPanel.tsx
  scripts/claim-maintainer.ts       kept, sandbox-only, for seeding the demo maintainer (Plan 3)
  .env.example                      + GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
  test/maintainer-sessions, maintainer-claims, oauth-clients, maintainer-routes, maintainer-summary
```

---

### Task 1: Maintainer sessions and single-use OAuth states

**Files:**
- Create: `apps/web/lib/maintainers/sessions.ts`, `apps/web/test/maintainer-sessions.test.ts`
- Modify: `apps/web/lib/db/schema.ts`
- Generate: `apps/web/drizzle/0004_*.sql`

**Interfaces:**
- Consumes: `hashToken` (Plan 1), `maintainers` (Plan 2b).
- Produces:
  - cookies: `MAINTAINER_COOKIE`, `OAUTH_COOKIE`, `oauthCookie(value | null, secure)` and `maintainerCookie(value | null, secure)`
  - OAuth states: `OAUTH_STATE_TTL_MS`, `issueOAuthState(db, provider, githubId | null, now?): Promise<string>`, and `consumeOAuthState(db, provider, state, cookie, now?): Promise<{ githubId: number | null } | null>`
  - sessions: `createMaintainerSession(db, githubId, now?)`, `maintainerForSession(db, value, now?): Promise<{ login; githubId } | null>` and `endMaintainerSession(db, value)`
  - tables `maintainerSessions` and `oauthStates`

- [ ] **Step 1: Write the failing test**

`apps/web/test/maintainer-sessions.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb, type Db } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { maintainers } from "../lib/db/schema";
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `rm -rf node_modules/.vitest-cache && pnpm test apps/web/test/maintainer-sessions.test.ts`
Expected: FAIL, because `../lib/maintainers/sessions` can't be resolved.

- [ ] **Step 3: The tables**

In `apps/web/lib/db/schema.ts`, make the maintainer's GitHub id unique:

```ts
  /** GitHub's numeric account id: who the maintainer really is, even after they rename their login. */
  githubId: integer("github_id").unique(),
```

At the end of the file, add:

```ts
/** A maintainer signed in with GitHub. Separate from a funder's web session: one person can be both. */
export const maintainerSessions = pgTable("maintainer_sessions", {
  idHash: text("id_hash").primaryKey(),
  githubId: integer("github_id").notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", tz).notNull(),
});

/** The `state` of a GitHub or PayPal sign-in that is under way: single use, short-lived, bound to a cookie. */
export const oauthStates = pgTable("oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  provider: text("provider", { enum: ["github", "paypal"] }).notNull(),
  /** PayPal linking only: the maintainer who asked. */
  githubId: integer("github_id"),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", tz).notNull(),
  usedAt: timestamp("used_at", tz),
});
```

Run: `pnpm --filter web db:generate`
Expected: a new `apps/web/drizzle/0004_*.sql` that creates `maintainer_sessions` and `oauth_states` and adds `maintainers_github_id_unique`. Nothing is dropped.

- [ ] **Step 4: Sessions and states**

`apps/web/lib/maintainers/sessions.ts`:

```ts
import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashToken } from "../auth";
import type { Db } from "../db/client";
import { maintainerSessions, maintainers, oauthStates } from "../db/schema";

export const MAINTAINER_COOKIE = "upstream_maintainer";
export const OAUTH_COOKIE = "upstream_oauth";
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const MAINTAINER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const secret = () => randomBytes(32).toString("base64url");
const later = (now: Date, ms: number) => new Date(now.getTime() + ms);

/** Starts a GitHub sign-in or a PayPal link. The returned state goes to the provider and into the OAuth cookie. */
export async function issueOAuthState(db: Db, provider: "github" | "paypal", githubId: number | null, now: Date = new Date()): Promise<string> {
  const state = secret();
  await db.insert(oauthStates).values({ stateHash: hashToken(state), provider, githubId, expiresAt: later(now, OAUTH_STATE_TTL_MS) });
  return state;
}

/**
 * Accepts the state a provider sent back once, within 10 minutes, and only from the browser holding it in its
 * cookie: a sign-in another site started can't complete in yours. Returns who asked, or null.
 */
export async function consumeOAuthState(
  db: Db,
  provider: "github" | "paypal",
  state: string | null,
  cookie: string | null,
  now: Date = new Date(),
): Promise<{ githubId: number | null } | null> {
  if (!state || !cookie || state.length !== cookie.length || !timingSafeEqual(Buffer.from(state), Buffer.from(cookie))) return null;
  const [row] = await db
    .update(oauthStates)
    .set({ usedAt: now })
    .where(and(eq(oauthStates.stateHash, hashToken(state)), eq(oauthStates.provider, provider), isNull(oauthStates.usedAt), gt(oauthStates.expiresAt, now)))
    .returning({ githubId: oauthStates.githubId });
  return row ? { githubId: row.githubId } : null;
}

export function oauthCookie(value: string | null, secure: boolean): string {
  const age = value ? OAUTH_STATE_TTL_MS / 1000 : 0;
  return `${OAUTH_COOKIE}=${value ?? ""}; HttpOnly; SameSite=Lax; Path=/maintainer; Max-Age=${age}${secure ? "; Secure" : ""}`;
}

export async function createMaintainerSession(db: Db, githubId: number, now: Date = new Date()): Promise<string> {
  const value = secret();
  await db.insert(maintainerSessions).values({ idHash: hashToken(value), githubId, expiresAt: later(now, MAINTAINER_SESSION_TTL_MS) });
  return value;
}

export async function maintainerForSession(db: Db, value: string, now: Date = new Date()): Promise<{ login: string; githubId: number } | null> {
  const [row] = await db
    .select({ login: maintainers.login, githubId: maintainerSessions.githubId })
    .from(maintainerSessions)
    .innerJoin(maintainers, eq(maintainers.githubId, maintainerSessions.githubId))
    .where(and(eq(maintainerSessions.idHash, hashToken(value)), gt(maintainerSessions.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

export async function endMaintainerSession(db: Db, value: string): Promise<void> {
  await db.delete(maintainerSessions).where(eq(maintainerSessions.idHash, hashToken(value)));
}

export function maintainerCookie(value: string | null, secure: boolean): string {
  const age = value ? MAINTAINER_SESSION_TTL_MS / 1000 : 0;
  return `${MAINTAINER_COOKIE}=${value ?? ""}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure ? "; Secure" : ""}`;
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `rm -rf node_modules/.vitest-cache && pnpm test`, then `pnpm --filter web exec tsc --noEmit`
Expected: maintainer-sessions 6/6, every test passes, and the typecheck is clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/db/schema.ts apps/web/drizzle apps/web/lib/maintainers/sessions.ts apps/web/test/maintainer-sessions.test.ts
git commit -m "Add maintainer sessions and single-use OAuth states"
```

---

### Task 2: Sign in by GitHub account, link a verified PayPal account

**Files:**
- Create: `apps/web/lib/maintainers/claims.ts`, `apps/web/test/maintainer-claims.test.ts`

**Interfaces:**
- Consumes: `createMaintainerSession` (Task 1), `withSettleLock` (Plan 2b), `accruals`, `payoutItems` and `maintainers` (Plan 2b).
- Produces:
  - `signInMaintainer(db, { id, login }, now?): Promise<{ ok: true; session } | { ok: false; reason: "taken" }>`
  - `linkPayPal(db, githubId, { payerId, verified }, now?): Promise<"linked" | "unchanged" | "not verified" | "used by another maintainer">`

- [ ] **Step 1: Write the failing test**

`apps/web/test/maintainer-claims.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb, type Db } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { accruals, maintainers, payoutItems, settlements } from "../lib/db/schema";
import { linkPayPal, signInMaintainer } from "../lib/maintainers/claims";
import { maintainerForSession } from "../lib/maintainers/sessions";

const NOW = new Date("2026-10-14T10:00:00Z");
const DAY = 86_400_000;
let db: Db;
beforeEach(async () => {
  db = createPgliteDb();
  await migrateDb(db, "pglite");
});
const row = async (githubId: number) => (await db.select().from(maintainers).where(eq(maintainers.githubId, githubId)))[0];

describe("signInMaintainer", () => {
  it("signs a maintainer in by their GitHub account, creating them once", async () => {
    const first = await signInMaintainer(db, { id: 7, login: "Alice" }, NOW);
    const again = await signInMaintainer(db, { id: 7, login: "alice" }, NOW);
    if (!first.ok || !again.ok) throw new Error("expected sign-ins");
    expect(first.session).not.toBe(again.session);
    expect(await maintainerForSession(db, first.session, NOW)).toEqual({ login: "alice", githubId: 7 });
    expect(await db.select().from(maintainers)).toHaveLength(1);
  });

  it("follows a renamed GitHub login, and moves what they're owed along with it", async () => {
    await signInMaintainer(db, { id: 7, login: "alice" }, NOW);
    const { accountId } = await createDevice(db, null);
    const [s] = await db.insert(settlements).values({}).returning();
    const [line] = await db.insert(payoutItems).values({ settlementId: s!.id, login: "alice", payerId: "P-A", cents: 300 }).returning();
    await db.insert(accruals).values([
      { settlementId: s!.id, funderId: accountId, login: "alice", ecosystem: "npm", name: "a", cents: 500 },
      { settlementId: s!.id, funderId: accountId, login: "alice", ecosystem: "npm", name: "a", cents: 300, status: "paid", payoutItemId: line!.id },
    ]);
    expect((await signInMaintainer(db, { id: 7, login: "Alice-Renamed" }, NOW)).ok).toBe(true);
    expect((await row(7))!.login).toBe("alice-renamed");
    expect((await db.select().from(accruals)).map((a) => a.login)).toEqual(["alice-renamed", "alice-renamed"]);
    expect((await db.select().from(payoutItems))[0]!.login).toBe("alice-renamed");
  });

  it("takes over a sandbox claim made for their login before they signed in", async () => {
    await db.insert(maintainers).values({ login: "carol", paypalPayerId: "P-C", claimedAt: new Date(NOW.getTime() - 8 * DAY) });
    expect((await signInMaintainer(db, { id: 9, login: "carol" }, NOW)).ok).toBe(true);
    expect(await row(9)).toMatchObject({ login: "carol", paypalPayerId: "P-C" });
  });

  it("refuses a login that another GitHub account holds here", async () => {
    await db.insert(maintainers).values({ login: "bob", githubId: 5 });
    expect(await signInMaintainer(db, { id: 6, login: "bob" }, NOW)).toEqual({ ok: false, reason: "taken" });
    await signInMaintainer(db, { id: 8, login: "dan" }, NOW);
    expect(await signInMaintainer(db, { id: 8, login: "bob" }, NOW)).toEqual({ ok: false, reason: "taken" });
    expect((await row(8))!.login).toBe("dan");
  });
});

describe("linkPayPal", () => {
  beforeEach(async () => {
    await signInMaintainer(db, { id: 7, login: "alice" }, NOW);
    await signInMaintainer(db, { id: 8, login: "bob" }, NOW);
  });

  it("links only a verified PayPal account, and starts the first-payout hold", async () => {
    expect(await linkPayPal(db, 7, { payerId: "P-1", verified: false }, NOW)).toBe("not verified");
    expect((await row(7))!.paypalPayerId).toBeNull();
    expect(await linkPayPal(db, 7, { payerId: "P-1", verified: true }, NOW)).toBe("linked");
    expect(await row(7)).toMatchObject({ paypalPayerId: "P-1", claimedAt: NOW });
  });

  it("never links one PayPal account to two maintainers", async () => {
    await linkPayPal(db, 7, { payerId: "P-1", verified: true }, NOW);
    expect(await linkPayPal(db, 8, { payerId: "P-1", verified: true }, NOW)).toBe("used by another maintainer");
    expect((await row(8))!.paypalPayerId).toBeNull();
  });

  it("restarts the hold when the PayPal account changes, but not when it's the same one", async () => {
    await linkPayPal(db, 7, { payerId: "P-1", verified: true }, NOW);
    const later = new Date(NOW.getTime() + 3 * DAY);
    expect(await linkPayPal(db, 7, { payerId: "P-1", verified: true }, later)).toBe("unchanged");
    expect((await row(7))!.claimedAt).toEqual(NOW);
    expect(await linkPayPal(db, 7, { payerId: "P-2", verified: true }, later)).toBe("linked");
    expect(await row(7)).toMatchObject({ paypalPayerId: "P-2", claimedAt: later });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `rm -rf node_modules/.vitest-cache && pnpm test apps/web/test/maintainer-claims.test.ts`
Expected: FAIL, because `../lib/maintainers/claims` can't be resolved.

- [ ] **Step 3: Sign-in and linking**

`apps/web/lib/maintainers/claims.ts`:

```ts
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals, maintainers, payoutItems } from "../db/schema";
import { withSettleLock } from "../funding/lock";
import { createMaintainerSession } from "./sessions";

export type SignIn = { ok: true; session: string } | { ok: false; reason: "taken" };

/**
 * Signs a maintainer in by their GitHub account. Identity is GitHub's numeric id: when the login was renamed,
 * the row and everything they're owed move to the new login. A claim made for their login before they ever
 * signed in (sandbox seeding) becomes theirs. A login another GitHub account holds here is refused.
 */
export async function signInMaintainer(db: Db, user: { id: number; login: string }, now: Date = new Date()): Promise<SignIn> {
  const login = user.login.toLowerCase();
  // Moving money to a renamed login is an accrual change, so it waits for any settlement in progress.
  return withSettleLock(db, async (tx) => {
    const [mine] = await tx.select().from(maintainers).where(eq(maintainers.githubId, user.id)).limit(1);
    const [named] = await tx.select().from(maintainers).where(eq(maintainers.login, login)).limit(1);
    if (named && named.githubId !== null && named.githubId !== user.id) return { ok: false, reason: "taken" };
    if (mine && mine.login !== login) {
      if (named) return { ok: false, reason: "taken" };
      await tx.update(maintainers).set({ login }).where(eq(maintainers.githubId, user.id));
      await tx.update(accruals).set({ login }).where(eq(accruals.login, mine.login));
      await tx.update(payoutItems).set({ login }).where(eq(payoutItems.login, mine.login));
    } else if (!mine && named) {
      await tx.update(maintainers).set({ githubId: user.id }).where(eq(maintainers.login, login));
    } else if (!mine) {
      await tx.insert(maintainers).values({ login, githubId: user.id });
    }
    return { ok: true, session: await createMaintainerSession(tx, user.id, now) };
  });
}

export type LinkResult = "linked" | "unchanged" | "not verified" | "used by another maintainer";

/**
 * Links the PayPal account a maintainer proved with Log in with PayPal. Only verified accounts, never one
 * already linked to another maintainer. A different account restarts the 7-day hold before the next payout.
 */
export async function linkPayPal(db: Db, githubId: number, account: { payerId: string; verified: boolean }, now: Date = new Date()): Promise<LinkResult> {
  if (!account.verified) return "not verified";
  // Who can be paid is what queuePayouts reads, so this waits for any settlement in progress.
  return withSettleLock(db, async (tx) => {
    const [me] = await tx.select().from(maintainers).where(eq(maintainers.githubId, githubId)).limit(1);
    if (!me) throw new Error("linkPayPal needs a signed-in maintainer");
    if (me.paypalPayerId === account.payerId) return "unchanged";
    const [other] = await tx
      .select({ login: maintainers.login })
      .from(maintainers)
      .where(and(eq(maintainers.paypalPayerId, account.payerId), ne(maintainers.login, me.login)))
      .limit(1);
    if (other) return "used by another maintainer";
    await tx.update(maintainers).set({ paypalPayerId: account.payerId, claimedAt: now }).where(eq(maintainers.githubId, githubId));
    return "linked";
  });
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `rm -rf node_modules/.vitest-cache && pnpm test`, then `pnpm --filter web exec tsc --noEmit`
Expected: maintainer-claims 7/7, and every test passes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/maintainers/claims.ts apps/web/test/maintainer-claims.test.ts
git commit -m "Sign maintainers in by GitHub account and link verified PayPal accounts"
```

---

### Task 3: The GitHub and Log in with PayPal clients

**Files:**
- Create: `apps/web/lib/maintainers/github-oauth.ts`, `apps/web/lib/maintainers/paypal-identity.ts`, `apps/web/test/oauth-clients.test.ts`

**Interfaces:**
- Consumes: `SANDBOX_API` (Plan 2a).
- Produces:
  - `interface GithubOAuth { authorizeUrl(state, redirectUri): string; identify(code, redirectUri): Promise<{ id; login } | null> }` and `createGithubOAuth({ clientId, clientSecret, fetchImpl? })`
  - `interface PayPalIdentity { authorizeUrl(state, redirectUri): string; identify(code, redirectUri): Promise<{ payerId; verified } | null> }` and `createPayPalIdentity({ clientId, clientSecret, apiBase, fetchImpl? })`

- [ ] **Step 1: Write the failing test**

`apps/web/test/oauth-clients.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createGithubOAuth } from "../lib/maintainers/github-oauth";
import { createPayPalIdentity } from "../lib/maintainers/paypal-identity";
import { SANDBOX_API } from "../lib/paypal/client";

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}
const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);
const back = "https://up.test/maintainer/github/callback";

describe("GitHub sign-in", () => {
  it("sends people to GitHub asking for nothing but who they are", () => {
    const gh = createGithubOAuth({ clientId: "gh-id", clientSecret: "gh-secret" });
    const url = new URL(gh.authorizeUrl("st4te", back));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "gh-id", redirect_uri: back, state: "st4te", scope: "", allow_signup: "false" });
  });

  it("turns the code GitHub sends back into the person's GitHub id and login", async () => {
    const f = fakeFetch([
      { status: 200, body: { access_token: "gho_1", token_type: "bearer", scope: "" } },
      { status: 200, body: { id: 7, login: "Alice", type: "User" } },
    ]);
    const gh = createGithubOAuth({ clientId: "gh-id", clientSecret: "gh-secret", fetchImpl: f.impl });
    expect(await gh.identify("c0de", back)).toEqual({ id: 7, login: "Alice" });
    expect(f.calls[0]!.url).toBe("https://github.com/login/oauth/access_token");
    expect(header(f.calls[0]!, "accept")).toBe("application/json");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ client_id: "gh-id", client_secret: "gh-secret", code: "c0de", redirect_uri: back });
    expect(f.calls[1]!.url).toBe("https://api.github.com/user");
    expect(header(f.calls[1]!, "authorization")).toBe("Bearer gho_1");
  });

  it("answers null for a code GitHub refuses, and for an organisation", async () => {
    const refused = fakeFetch([{ status: 200, body: { error: "bad_verification_code" } }]);
    expect(await createGithubOAuth({ clientId: "i", clientSecret: "s", fetchImpl: refused.impl }).identify("old", back)).toBeNull();
    const org = fakeFetch([
      { status: 200, body: { access_token: "gho_2" } },
      { status: 200, body: { id: 9, login: "acme", type: "Organization" } },
    ]);
    expect(await createGithubOAuth({ clientId: "i", clientSecret: "s", fetchImpl: org.impl }).identify("c", back)).toBeNull();
  });
});

describe("Log in with PayPal", () => {
  const ppBack = "https://up.test/maintainer/paypal/callback";

  it("sends people to the sandbox's sign-in page, asking for their PayPal account id", () => {
    const pp = createPayPalIdentity({ clientId: "pp-id", clientSecret: "pp-secret", apiBase: SANDBOX_API });
    const url = new URL(pp.authorizeUrl("st4te", ppBack));
    expect(url.origin + url.pathname).toBe("https://www.sandbox.paypal.com/signin/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      flowEntry: "static",
      client_id: "pp-id",
      response_type: "code",
      scope: "openid https://uri.paypal.com/services/paypalattributes",
      redirect_uri: ppBack,
      state: "st4te",
    });
    const live = createPayPalIdentity({ clientId: "pp-id", clientSecret: "s", apiBase: "https://api-m.paypal.com" });
    expect(new URL(live.authorizeUrl("x", ppBack)).origin).toBe("https://www.paypal.com");
  });

  it("turns the code PayPal sends back into the account id, and whether PayPal verified the account", async () => {
    const f = fakeFetch([
      { status: 200, body: { access_token: "A21-user", token_type: "Bearer" } },
      { status: 200, body: { user_id: "https://www.paypal.com/webapps/auth/identity/user/x", payer_id: "PAYER-1", verified_account: "true" } },
    ]);
    const pp = createPayPalIdentity({ clientId: "pp-id", clientSecret: "pp-secret", apiBase: "https://api.test", fetchImpl: f.impl });
    expect(await pp.identify("c0de", ppBack)).toEqual({ payerId: "PAYER-1", verified: true });
    expect(f.calls[0]!.url).toBe("https://api.test/v1/oauth2/token");
    expect(header(f.calls[0]!, "authorization")).toBe(`Basic ${Buffer.from("pp-id:pp-secret").toString("base64")}`);
    expect(new URLSearchParams(String(f.calls[0]!.init.body)).get("grant_type")).toBe("authorization_code");
    expect(new URLSearchParams(String(f.calls[0]!.init.body)).get("code")).toBe("c0de");
    expect(f.calls[1]!.url).toBe("https://api.test/v1/identity/oauth2/userinfo?schema=paypalv1.1");
    expect(header(f.calls[1]!, "authorization")).toBe("Bearer A21-user");
  });

  it("reports an unverified account as such, and answers null for a code PayPal refuses", async () => {
    const unverified = fakeFetch([
      { status: 200, body: { access_token: "t" } },
      { status: 200, body: { payer_id: "PAYER-2", verified_account: false } },
    ]);
    expect(await createPayPalIdentity({ clientId: "i", clientSecret: "s", apiBase: "https://api.test", fetchImpl: unverified.impl }).identify("c", ppBack)).toEqual({
      payerId: "PAYER-2",
      verified: false,
    });
    const refused = fakeFetch([{ status: 400, body: { error: "invalid_grant" } }]);
    expect(await createPayPalIdentity({ clientId: "i", clientSecret: "s", apiBase: "https://api.test", fetchImpl: refused.impl }).identify("old", ppBack)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `rm -rf node_modules/.vitest-cache && pnpm test apps/web/test/oauth-clients.test.ts`
Expected: FAIL, because `../lib/maintainers/github-oauth` can't be resolved.

- [ ] **Step 3: The clients**

`apps/web/lib/maintainers/github-oauth.ts`:

```ts
/** GitHub's web sign-in (OAuth app). It asks for no scopes: only the public "who are you". */
export interface GithubOAuth {
  authorizeUrl(state: string, redirectUri: string): string;
  /** The GitHub account behind a sign-in code; null when GitHub refuses the code, or for an organisation. */
  identify(code: string, redirectUri: string): Promise<{ id: number; login: string } | null>;
}

export function createGithubOAuth(cfg: { clientId: string; clientSecret: string; fetchImpl?: typeof fetch }): GithubOAuth {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeout = () => AbortSignal.timeout(15_000);
  return {
    authorizeUrl(state, redirectUri) {
      const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, state, scope: "", allow_signup: "false" });
      return `https://github.com/login/oauth/authorize?${q}`;
    },
    async identify(code, redirectUri) {
      const tokenRes = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirectUri }),
        signal: timeout(),
      });
      const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: unknown };
      if (!tokenRes.ok || typeof token.access_token !== "string") return null;
      const userRes = await fetchImpl("https://api.github.com/user", {
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token.access_token}`, "user-agent": "upstream-pay" },
        signal: timeout(),
      });
      const user = (await userRes.json().catch(() => ({}))) as { id?: unknown; login?: unknown; type?: unknown };
      if (!userRes.ok || typeof user.id !== "number" || typeof user.login !== "string" || user.type !== "User") return null;
      return { id: user.id, login: user.login };
    },
  };
}
```

`apps/web/lib/maintainers/paypal-identity.ts`:

```ts
import { SANDBOX_API } from "../paypal/client";

/** Log in with PayPal, used only to learn which PayPal account a maintainer owns. */
export interface PayPalIdentity {
  authorizeUrl(state: string, redirectUri: string): string;
  /** The PayPal account behind a sign-in code, and whether PayPal verified it; null when PayPal refuses the code. */
  identify(code: string, redirectUri: string): Promise<{ payerId: string; verified: boolean } | null>;
}

/** openid plus "PayPal account attributes", which carries payer_id and verified_account. */
const SCOPE = "openid https://uri.paypal.com/services/paypalattributes";

export function createPayPalIdentity(cfg: { clientId: string; clientSecret: string; apiBase: string; fetchImpl?: typeof fetch }): PayPalIdentity {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeout = () => AbortSignal.timeout(15_000);
  const signIn = cfg.apiBase === SANDBOX_API ? "https://www.sandbox.paypal.com" : "https://www.paypal.com";
  return {
    authorizeUrl(state, redirectUri) {
      const q = new URLSearchParams({ flowEntry: "static", client_id: cfg.clientId, response_type: "code", scope: SCOPE, redirect_uri: redirectUri, state });
      return `${signIn}/signin/authorize?${q}`;
    },
    async identify(code, redirectUri) {
      const tokenRes = await fetchImpl(`${cfg.apiBase}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString(),
        signal: timeout(),
      });
      const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: unknown };
      if (!tokenRes.ok || typeof token.access_token !== "string") return null;
      const infoRes = await fetchImpl(`${cfg.apiBase}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, {
        headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
        signal: timeout(),
      });
      const info = (await infoRes.json().catch(() => ({}))) as { payer_id?: unknown; verified_account?: unknown };
      if (!infoRes.ok || typeof info.payer_id !== "string" || !info.payer_id) return null;
      return { payerId: info.payer_id, verified: info.verified_account === true || info.verified_account === "true" };
    },
  };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `rm -rf node_modules/.vitest-cache && pnpm test`, then `pnpm --filter web exec tsc --noEmit`
Expected: oauth-clients 6/6, and every test passes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/maintainers/github-oauth.ts apps/web/lib/maintainers/paypal-identity.ts apps/web/test/oauth-clients.test.ts
git commit -m "Add the GitHub and Log in with PayPal identity clients"
```

---

### Task 4: The sign-in and linking routes

**Files:**
- Create:
  - `apps/web/lib/maintainers/http.ts`
  - `apps/web/app/maintainer/github/start/route.ts` and `apps/web/app/maintainer/github/callback/route.ts`
  - `apps/web/app/maintainer/paypal/start/route.ts` and `apps/web/app/maintainer/paypal/callback/route.ts`
  - `apps/web/app/maintainer/signout/route.ts`
  - `apps/web/test/maintainer-routes.test.ts`
- Modify: `apps/web/lib/receipts/service.ts` (Deps), `apps/web/lib/deps.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3, `readCookie` and `sameOrigin` (Plan 2a), `paypalApiBase` (Plan 2b).
- Produces:
  - `Deps.githubOAuth?: GithubOAuth | null` and `Deps.paypalIdentity?: PayPalIdentity | null`
  - `publicOrigin(req)`, `redirect(location, cookies?, status?)`, `plainPage(message, status, cookies?)`, `signedInMaintainer(req, db)` and `secureCookies()`
  - `GET /maintainer/github/start` and `/callback`, `GET /maintainer/paypal/start` and `/callback`, and `POST /maintainer/signout`

- [ ] **Step 1: Write the failing test**

`apps/web/test/maintainer-routes.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { maintainers } from "../lib/db/schema";
import type { GithubOAuth } from "../lib/maintainers/github-oauth";
import type { PayPalIdentity } from "../lib/maintainers/paypal-identity";
import { MAINTAINER_COOKIE, OAUTH_COOKIE, maintainerForSession } from "../lib/maintainers/sessions";
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
let paypalCodes: Record<string, { payerId: string; verified: boolean } | null>;
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

  it("say plainly when GitHub doesn't confirm who someone is, or their login belongs to someone else here", async () => {
    const start = async () => cookieValue(await githubStart(get("/maintainer/github/start")), OAUTH_COOKIE)!;
    let s = await start();
    const refused = await githubCallback(get(`/maintainer/github/callback?code=nobody&state=${s}`, { [OAUTH_COOKIE]: s }));
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("GitHub didn't confirm who you are");
    await h.deps.db.insert(maintainers).values({ login: "bob", githubId: 99 });
    s = await start();
    const taken = await githubCallback(get(`/maintainer/github/callback?code=bob&state=${s}`, { [OAUTH_COOKIE]: s }));
    expect(taken.status).toBe(409);
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `rm -rf node_modules/.vitest-cache && pnpm test apps/web/test/maintainer-routes.test.ts`
Expected: FAIL, because the `../app/maintainer/...` routes can't be resolved.

- [ ] **Step 3: Wire the clients**

In `apps/web/lib/receipts/service.ts`:
1. Import the types:

```ts
import type { GithubOAuth } from "../maintainers/github-oauth";
import type { PayPalIdentity } from "../maintainers/paypal-identity";
```

2. After `webhookId` in `Deps`, add:

```ts
  /** GitHub sign-in for maintainers; null when the server has no GitHub OAuth app. */
  githubOAuth?: GithubOAuth | null;
  /** Log in with PayPal, for maintainers linking where they're paid; null without PayPal credentials. */
  paypalIdentity?: PayPalIdentity | null;
```

In `apps/web/lib/deps.ts`:
1. Import `createGithubOAuth` and `createPayPalIdentity`.
2. After `webhookId: ...`, add:

```ts
      githubOAuth:
        process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
          ? createGithubOAuth({ clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET })
          : null,
      paypalIdentity:
        process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET
          ? createPayPalIdentity({
              clientId: process.env.PAYPAL_CLIENT_ID,
              clientSecret: process.env.PAYPAL_CLIENT_SECRET,
              apiBase: paypalApiBase(process.env.PAYPAL_API_BASE),
            })
          : null,
```

- [ ] **Step 4: The routes**

`apps/web/lib/maintainers/http.ts`:

```ts
import type { Db } from "../db/client";
import { readCookie } from "../web-auth";
import { MAINTAINER_COOKIE, maintainerForSession } from "./sessions";

export const secureCookies = () => process.env.NODE_ENV === "production";

/** This server's public address, for the return addresses GitHub and PayPal send people back to. */
export function publicOrigin(req: Request): string {
  return (process.env.PUBLIC_URL?.trim() || new URL(req.url).origin).replace(/\/+$/, "");
}

export function redirect(location: string, cookies: string[] = [], status = 303): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status, headers });
}

/** The message sits in element text, so &, < and > (and " for good measure) are all that need escaping. */
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A short page in plain words, with a way back. */
export function plainPage(message: string, status: number, cookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin" });
  for (const c of cookies) headers.append("set-cookie", c);
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Upstream for maintainers</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.5">
<p>${escapeHtml(message)}</p>
<p><a href="/maintainer">Back to the maintainer page</a></p>
</body>
</html>`;
  return new Response(html, { status, headers });
}

export async function signedInMaintainer(req: Request, db: Db): Promise<{ login: string; githubId: number } | null> {
  const value = readCookie(req, MAINTAINER_COOKIE);
  return value ? maintainerForSession(db, value) : null;
}
```

`apps/web/app/maintainer/github/start/route.ts`:

```ts
import { getDeps } from "../../../../lib/deps";
import { plainPage, publicOrigin, redirect, secureCookies } from "../../../../lib/maintainers/http";
import { issueOAuthState, oauthCookie } from "../../../../lib/maintainers/sessions";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const deps = await getDeps();
  if (!deps.githubOAuth) return plainPage("GitHub sign-in isn't set up on this server yet.", 503);
  const state = await issueOAuthState(deps.db, "github", null);
  const to = deps.githubOAuth.authorizeUrl(state, `${publicOrigin(req)}/maintainer/github/callback`);
  return redirect(to, [oauthCookie(state, secureCookies())], 302);
}
```

`apps/web/app/maintainer/github/callback/route.ts`:

```ts
import { getDeps } from "../../../../lib/deps";
import { signInMaintainer } from "../../../../lib/maintainers/claims";
import { plainPage, publicOrigin, redirect, secureCookies } from "../../../../lib/maintainers/http";
import { OAUTH_COOKIE, consumeOAuthState, maintainerCookie, oauthCookie } from "../../../../lib/maintainers/sessions";
import { readCookie } from "../../../../lib/web-auth";

export const runtime = "nodejs";

const EXPIRED = "This sign-in has expired, was already used, or didn't start in this browser. Please start again.";
const NOT_CONFIRMED = "GitHub didn't confirm who you are. Please try again.";

export async function GET(req: Request): Promise<Response> {
  const deps = await getDeps();
  if (!deps.githubOAuth) return plainPage("GitHub sign-in isn't set up on this server yet.", 503);
  const url = new URL(req.url);
  const clear = oauthCookie(null, secureCookies());
  if (!(await consumeOAuthState(deps.db, "github", url.searchParams.get("state"), readCookie(req, OAUTH_COOKIE)))) return plainPage(EXPIRED, 400, [clear]);
  const code = url.searchParams.get("code");
  if (!code) return plainPage("You didn't finish signing in with GitHub.", 400, [clear]);
  let user;
  try {
    user = await deps.githubOAuth.identify(code, `${publicOrigin(req)}/maintainer/github/callback`);
  } catch {
    return plainPage("Couldn't reach GitHub. Please try again.", 502, [clear]);
  }
  if (!user) return plainPage(NOT_CONFIRMED, 400, [clear]);
  const signedIn = await signInMaintainer(deps.db, user);
  if (!signedIn.ok) return plainPage("A different GitHub account already uses this name here, so we can't sign you in with it.", 409, [clear]);
  return redirect("/maintainer", [clear, maintainerCookie(signedIn.session, secureCookies())]);
}
```

`apps/web/app/maintainer/paypal/start/route.ts`:

```ts
import { getDeps } from "../../../../lib/deps";
import { plainPage, publicOrigin, redirect, secureCookies, signedInMaintainer } from "../../../../lib/maintainers/http";
import { issueOAuthState, oauthCookie } from "../../../../lib/maintainers/sessions";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const deps = await getDeps();
  if (!deps.paypalIdentity) return plainPage("Linking PayPal isn't set up on this server yet.", 503);
  const me = await signedInMaintainer(req, deps.db);
  if (!me) return plainPage("Sign in with GitHub first, then link PayPal.", 401);
  const state = await issueOAuthState(deps.db, "paypal", me.githubId);
  const to = deps.paypalIdentity.authorizeUrl(state, `${publicOrigin(req)}/maintainer/paypal/callback`);
  return redirect(to, [oauthCookie(state, secureCookies())], 302);
}
```

`apps/web/app/maintainer/paypal/callback/route.ts`:

```ts
import { getDeps } from "../../../../lib/deps";
import { linkPayPal } from "../../../../lib/maintainers/claims";
import { plainPage, publicOrigin, redirect, secureCookies, signedInMaintainer } from "../../../../lib/maintainers/http";
import { OAUTH_COOKIE, consumeOAuthState, oauthCookie } from "../../../../lib/maintainers/sessions";
import { readCookie } from "../../../../lib/web-auth";

export const runtime = "nodejs";

const RESULT = { linked: "linked", unchanged: "unchanged", "not verified": "not-verified", "used by another maintainer": "in-use" } as const;

export async function GET(req: Request): Promise<Response> {
  const deps = await getDeps();
  if (!deps.paypalIdentity) return plainPage("Linking PayPal isn't set up on this server yet.", 503);
  const clear = oauthCookie(null, secureCookies());
  const me = await signedInMaintainer(req, deps.db);
  if (!me) return plainPage("Sign in with GitHub first, then link PayPal.", 401, [clear]);
  const url = new URL(req.url);
  const started = await consumeOAuthState(deps.db, "paypal", url.searchParams.get("state"), readCookie(req, OAUTH_COOKIE));
  // The state must be one this maintainer started: nobody can finish linking their PayPal to someone else.
  if (!started || started.githubId !== me.githubId) {
    return plainPage("This PayPal link has expired, was already used, or didn't start in this browser. Please start again.", 400, [clear]);
  }
  const code = url.searchParams.get("code");
  if (!code) return redirect("/maintainer?paypal=cancelled", [clear]);
  let account;
  try {
    account = await deps.paypalIdentity.identify(code, `${publicOrigin(req)}/maintainer/paypal/callback`);
  } catch {
    return plainPage("Couldn't reach PayPal. Please try again.", 502, [clear]);
  }
  if (!account) return plainPage("PayPal didn't confirm your account. Please try again.", 400, [clear]);
  const result = await linkPayPal(deps.db, me.githubId, account);
  return redirect(`/maintainer?paypal=${RESULT[result]}`, [clear]);
}
```

`apps/web/app/maintainer/signout/route.ts`:

```ts
import { getDeps } from "../../../lib/deps";
import { plainPage, redirect, secureCookies } from "../../../lib/maintainers/http";
import { MAINTAINER_COOKIE, endMaintainerSession, maintainerCookie } from "../../../lib/maintainers/sessions";
import { readCookie, sameOrigin } from "../../../lib/web-auth";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return plainPage("This sign-out didn't come from this site, so it was refused.", 403);
  const deps = await getDeps();
  const value = readCookie(req, MAINTAINER_COOKIE);
  if (value) await endMaintainerSession(deps.db, value);
  return redirect("/maintainer", [maintainerCookie(null, secureCookies())]);
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `rm -rf node_modules/.vitest-cache && pnpm test`, then `pnpm --filter web exec tsc --noEmit`
Expected: maintainer-routes 7/7, and every test passes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/maintainers/http.ts apps/web/app/maintainer apps/web/lib/receipts/service.ts apps/web/lib/deps.ts apps/web/test/maintainer-routes.test.ts
git commit -m "Add the maintainer GitHub sign-in and PayPal linking routes"
```

---

### Task 5: The maintainer page

**Files:**
- Create: `apps/web/lib/maintainers/summary.ts`, `apps/web/app/api/maintainer/me/route.ts`, `apps/web/app/maintainer/page.tsx`, `apps/web/app/maintainer/MaintainerPanel.tsx`, `apps/web/test/maintainer-summary.test.ts`

**Interfaces:**
- Consumes: `signedInMaintainer` (Task 4), `FIRST_PAYOUT_HOLD_MS` (Plan 2b), `formatUsd` (Plan 2a), `linkPayPal` and `signInMaintainer` (Task 2).
- Produces:
  - `maintainerSummary(db, login): Promise<MaintainerSummary>`, where `MaintainerSummary = { login, paypal: { linked, firstPayoutFrom }, cents: { waiting, onItsWay, paid }, months, payouts, packages }`
  - `GET /api/maintainer/me` (401 when signed out)
  - the `/maintainer` page

- [ ] **Step 1: Write the failing test**

`apps/web/test/maintainer-summary.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb, type Db } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { accruals, payoutItems, receiptItems, receipts, settlements } from "../lib/db/schema";
import { linkPayPal, signInMaintainer } from "../lib/maintainers/claims";
import { MAINTAINER_COOKIE } from "../lib/maintainers/sessions";
import { maintainerSummary } from "../lib/maintainers/summary";
import type { Deps } from "../lib/receipts/service";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
const { GET: getMine } = await import("../app/api/maintainer/me/route");

const OCT = new Date("2026-10-14T10:00:00Z");
const SEP = new Date("2026-09-20T10:00:00Z");
let db: Db;
let session: string;
beforeEach(async () => {
  db = createPgliteDb();
  await migrateDb(db, "pglite");
  h.deps = { db, http: async () => ({ status: 404, body: null }), model: null } as unknown as Deps;
  const signed = await signInMaintainer(db, { id: 7, login: "alice" }, OCT);
  if (!signed.ok) throw new Error("sign-in failed");
  session = signed.session;
});

async function money() {
  const { accountId } = await createDevice(db, null);
  const [s] = await db.insert(settlements).values({}).returning();
  const [line] = await db.insert(payoutItems).values({ settlementId: s!.id, login: "alice", payerId: "P-A", cents: 700, status: "SUCCESS", updatedAt: OCT }).returning();
  const owed = { settlementId: s!.id, funderId: accountId, login: "alice", ecosystem: "npm" as const };
  await db.insert(accruals).values([
    { ...owed, name: "left-pad", cents: 700, status: "paid", payoutItemId: line!.id, createdAt: SEP },
    { ...owed, name: "left-pad", cents: 250, status: "queued", createdAt: OCT },
    { ...owed, name: "right-pad", cents: 120, status: "held", createdAt: OCT },
    { ...owed, name: "right-pad", cents: 999, status: "returned", returnReason: "unclaimed", createdAt: OCT },
    { ...owed, login: "bob", name: "left-pad", cents: 50, createdAt: OCT },
  ]);
  const [r] = await db
    .insert(receipts)
    .values({ accountId, sessionId: "s1", agent: "claude-code", endedAt: OCT, status: "approved", source: "ai", promptVersion: "judge-v2" })
    .returning();
  const ev = (name: string) => ({ ecosystem: "npm" as const, name, installed: true, manifestAdded: false, importFiles: 1, usageLines: 1, docsReads: 0, kind: "dependency" as const, description: null });
  await db.insert(receiptItems).values([
    { receiptId: r!.id, ecosystem: "npm", name: "left-pad", weightBp: 6000, role: "foundation", reason: "x", evidence: ev("left-pad") },
    { receiptId: r!.id, ecosystem: "npm", name: "right-pad", weightBp: 4000, role: "helper", reason: "x", evidence: ev("right-pad") },
  ]);
}

describe("maintainerSummary", () => {
  it("shows what's waiting, on its way and paid, by month and by package, never counting money given back", async () => {
    await money();
    expect(await maintainerSummary(db, "alice")).toEqual({
      login: "alice",
      paypal: { linked: false, firstPayoutFrom: null },
      cents: { waiting: 120, onItsWay: 250, paid: 700 },
      months: [
        { month: "2026-10", setAsideCents: 370 },
        { month: "2026-09", setAsideCents: 700 },
      ],
      payouts: [{ date: "2026-10-14", cents: 700, status: "SUCCESS" }],
      packages: [
        { ecosystem: "npm", name: "left-pad", cents: 950, roles: { foundation: 1 } },
        { ecosystem: "npm", name: "right-pad", cents: 120, roles: { helper: 1 } },
      ],
    });
  });

  it("says when the first payout can go out once PayPal is linked", async () => {
    await linkPayPal(db, 7, { payerId: "P-A", verified: true }, OCT);
    expect((await maintainerSummary(db, "alice")).paypal).toEqual({ linked: true, firstPayoutFrom: "2026-10-21" });
  });
});

describe("GET /api/maintainer/me", () => {
  it("answers only a signed-in maintainer", async () => {
    expect((await getMine(new Request("http://up.test/api/maintainer/me"))).status).toBe(401);
    const res = await getMine(new Request("http://up.test/api/maintainer/me", { headers: { cookie: `${MAINTAINER_COOKIE}=${session}` } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { login: string }).login).toBe("alice");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `rm -rf node_modules/.vitest-cache && pnpm test apps/web/test/maintainer-summary.test.ts`
Expected: FAIL, because `../lib/maintainers/summary` can't be resolved.

- [ ] **Step 3: The summary and its API**

`apps/web/lib/maintainers/summary.ts`:

```ts
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals, maintainers, payoutItems, receiptItems } from "../db/schema";
import { FIRST_PAYOUT_HOLD_MS } from "../funding/payouts";

export interface MaintainerSummary {
  login: string;
  /** firstPayoutFrom: the day the 7-day hold after linking PayPal ends (YYYY-MM-DD, UTC). */
  paypal: { linked: boolean; firstPayoutFrom: string | null };
  /** waiting: set aside, not on a payout yet. onItsWay: on a payout PayPal hasn't confirmed. paid: confirmed. */
  cents: { waiting: number; onItsWay: number; paid: number };
  months: Array<{ month: string; setAsideCents: number }>;
  payouts: Array<{ date: string; cents: number; status: string }>;
  /** How agents used each package, counted over every receipt that names it (no funder is identified). */
  packages: Array<{ ecosystem: "npm" | "pypi"; name: string; cents: number; roles: Record<string, number> }>;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** What a maintainer is owed and has been paid. Money given back to funders is left out. */
export async function maintainerSummary(db: Db, login: string): Promise<MaintainerSummary> {
  const [me] = await db.select({ payerId: maintainers.paypalPayerId, claimedAt: maintainers.claimedAt }).from(maintainers).where(eq(maintainers.login, login)).limit(1);
  const mine = and(eq(accruals.login, login), ne(accruals.status, "returned"));

  const byStatus = await db
    .select({ status: accruals.status, cents: sql<string>`sum(${accruals.cents})` })
    .from(accruals)
    .where(mine)
    .groupBy(accruals.status);
  const total = (s: string) => Number(byStatus.find((r) => r.status === s)?.cents ?? 0);

  const month = sql<string>`to_char(${accruals.createdAt} at time zone 'UTC', 'YYYY-MM')`;
  const months = await db
    .select({ month, cents: sql<string>`sum(${accruals.cents})` })
    .from(accruals)
    .where(mine)
    .groupBy(month)
    .orderBy(desc(month));

  const payouts = await db
    .select({ at: payoutItems.updatedAt, cents: payoutItems.cents, status: payoutItems.status })
    .from(payoutItems)
    .where(eq(payoutItems.login, login))
    .orderBy(desc(payoutItems.updatedAt))
    .limit(12);

  const pkgCents = sql<string>`sum(${accruals.cents})`;
  const pkgs = await db
    .select({ ecosystem: accruals.ecosystem, name: accruals.name, cents: pkgCents })
    .from(accruals)
    .where(mine)
    .groupBy(accruals.ecosystem, accruals.name)
    .orderBy(desc(pkgCents), accruals.name);
  const roles =
    pkgs.length === 0
      ? []
      : await db
          .select({ ecosystem: receiptItems.ecosystem, name: receiptItems.name, role: receiptItems.role, n: sql<string>`count(*)` })
          .from(receiptItems)
          .where(inArray(receiptItems.name, pkgs.map((p) => p.name)))
          .groupBy(receiptItems.ecosystem, receiptItems.name, receiptItems.role);

  return {
    login,
    paypal: {
      linked: Boolean(me?.payerId),
      firstPayoutFrom: me?.payerId && me.claimedAt ? day(new Date(me.claimedAt.getTime() + FIRST_PAYOUT_HOLD_MS)) : null,
    },
    cents: { waiting: total("held"), onItsWay: total("queued"), paid: total("paid") },
    months: months.map((m) => ({ month: m.month, setAsideCents: Number(m.cents) })),
    payouts: payouts.map((p) => ({ date: day(p.at), cents: p.cents, status: p.status })),
    packages: pkgs.map((p) => ({
      ecosystem: p.ecosystem,
      name: p.name,
      cents: Number(p.cents),
      roles: Object.fromEntries(roles.filter((r) => r.ecosystem === p.ecosystem && r.name === p.name).map((r) => [r.role, Number(r.n)])),
    })),
  };
}
```

`apps/web/app/api/maintainer/me/route.ts`:

```ts
import { getDeps } from "../../../../lib/deps";
import { json } from "../../../../lib/http";
import { signedInMaintainer } from "../../../../lib/maintainers/http";
import { maintainerSummary } from "../../../../lib/maintainers/summary";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const deps = await getDeps();
  const me = await signedInMaintainer(req, deps.db);
  if (!me) return json({ error: "not signed in" }, 401);
  return json(await maintainerSummary(deps.db, me.login));
}
```

- [ ] **Step 4: The page**

`apps/web/app/maintainer/page.tsx`:

```tsx
import type { Metadata } from "next";
import { MaintainerPanel } from "./MaintainerPanel";

export const metadata: Metadata = { title: "Upstream for maintainers" };

export default function MaintainerPage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "48px auto", padding: "0 16px", lineHeight: 1.5 }}>
      <h1>Get paid for the open source AI agents use</h1>
      <MaintainerPanel />
    </main>
  );
}
```

`apps/web/app/maintainer/MaintainerPanel.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { formatUsd } from "../../lib/format";
import type { MaintainerSummary } from "../../lib/maintainers/summary";

const PAYPAL_NOTICE: Record<string, string> = {
  linked: "PayPal is linked.",
  unchanged: "That PayPal account was already linked.",
  "not-verified": "PayPal says that account isn't verified yet. Verify it with PayPal, then link it again.",
  "in-use": "That PayPal account is already linked to another maintainer.",
  cancelled: "You didn't finish linking PayPal.",
};

const ROLE: Record<string, string> = {
  foundation: "built on it",
  feature: "used it for a feature",
  helper: "used it as a helper",
  tooling: "used it as a tool",
};

const times = (n: number) => (n === 1 ? "once" : `${n} times`);

export function MaintainerPanel() {
  const [me, setMe] = useState<MaintainerSummary | null | "signed-out">(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const paypal = new URLSearchParams(window.location.search).get("paypal");
    if (paypal && PAYPAL_NOTICE[paypal]) setNotice(PAYPAL_NOTICE[paypal]);
    fetch("/api/maintainer/me")
      .then(async (res) => setMe(res.status === 401 ? "signed-out" : ((await res.json()) as MaintainerSummary)))
      .catch(() => setMe("signed-out"));
  }, []);

  if (me === null) return <p>Loading...</p>;
  if (me === "signed-out") {
    return (
      <>
        <p>
          When a developer&apos;s AI coding agent builds with your package, they can choose to pay you for it through Upstream. Sign in with
          GitHub to see what&apos;s waiting for you, then link PayPal to be paid.
        </p>
        <p>
          <a href="/maintainer/github/start">Sign in with GitHub</a>
        </p>
      </>
    );
  }

  return (
    <>
      <div>
        Signed in as <strong>{me.login}</strong>.{" "}
        <form method="post" action="/maintainer/signout" style={{ display: "inline" }}>
          <button type="submit">Sign out</button>
        </form>
      </div>
      {notice && <p role="status">{notice}</p>}

      <h2>Where we pay you</h2>
      {me.paypal.linked ? (
        <p>
          PayPal is linked.
          {me.paypal.firstPayoutFrom ? ` Your first payout can go out from ${me.paypal.firstPayoutFrom}.` : ""}{" "}
          <a href="/maintainer/paypal/start">Link a different PayPal account</a>
        </p>
      ) : (
        <p>
          <a href="/maintainer/paypal/start">Link PayPal</a> so we can pay you. Payouts start a week after you link it.
        </p>
      )}

      <h2>Your money</h2>
      <ul>
        <li>Waiting for you: {formatUsd(me.cents.waiting)}</li>
        <li>On its way: {formatUsd(me.cents.onItsWay)}</li>
        <li>Paid: {formatUsd(me.cents.paid)}</li>
      </ul>

      {me.months.length > 0 && (
        <>
          <h2>By month</h2>
          <ul>
            {me.months.map((m) => (
              <li key={m.month}>
                {m.month}: {formatUsd(m.setAsideCents)}
              </li>
            ))}
          </ul>
        </>
      )}

      {me.payouts.length > 0 && (
        <>
          <h2>Payouts</h2>
          <ul>
            {me.payouts.map((p, i) => (
              <li key={i}>
                {p.date}: {formatUsd(p.cents)}, {p.status === "SUCCESS" ? "paid" : p.status === "PENDING" ? "on its way" : p.status.toLowerCase()}
              </li>
            ))}
          </ul>
        </>
      )}

      {me.packages.length > 0 && (
        <>
          <h2>How agents use your packages</h2>
          <ul>
            {me.packages.map((p) => (
              <li key={`${p.ecosystem}:${p.name}`}>
                {p.name} ({formatUsd(p.cents)}):{" "}
                {Object.entries(p.roles)
                  .map(([role, n]) => `${ROLE[role] ?? role} ${times(n)}`)
                  .join(", ") || "no details yet"}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `rm -rf node_modules/.vitest-cache && pnpm test`, then `pnpm --filter web exec tsc --noEmit` and `pnpm --filter web build`
Expected:
- maintainer-summary 3/3, and every test passes
- the build lists `/maintainer` and `/api/maintainer/me`

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/maintainers/summary.ts apps/web/app/api/maintainer apps/web/app/maintainer/page.tsx apps/web/app/maintainer/MaintainerPanel.tsx apps/web/test/maintainer-summary.test.ts
git commit -m "Show maintainers what they are owed and how agents use their packages"
```

---

### Task 6: Limits, cleanup and settings

**Files:**
- Modify:
  - `apps/web/lib/maintainers/sessions.ts`
  - `apps/web/lib/receipts/service.ts` and `apps/web/lib/deps.ts`
  - `apps/web/app/maintainer/github/start/route.ts` and `apps/web/app/maintainer/paypal/start/route.ts`
  - `apps/web/.env.example`
  - `apps/web/scripts/claim-maintainer.ts`
  - `apps/web/test/maintainer-sessions.test.ts` and `apps/web/test/maintainer-routes.test.ts`

**Interfaces:**
- Consumes: `createRateLimiter`, `clientKey` (Plan 1).
- Produces: `Deps.signInLimiter?: RateLimiter`. `issueOAuthState` now deletes states that expired more than a day ago.

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/maintainer-sessions.test.ts`:
1. Import `oauthStates` from the schema.
2. Before "travels in a short-lived cookie...", add:

```ts
  it("clears out sign-ins nobody finished, so they can't pile up", async () => {
    await issueOAuthState(db, "github", null, NOW);
    await issueOAuthState(db, "github", null, new Date(NOW.getTime() + 2 * 86_400_000));
    expect(await db.select().from(oauthStates)).toHaveLength(1);
  });
```

In `apps/web/test/maintainer-routes.test.ts`:
1. Import `createRateLimiter` from `../lib/limits`.
2. Before "are switched off until GitHub sign-in is set up", add:

```ts
  it("limit how often one visitor can start signing in", async () => {
    h.deps = { ...h.deps, signInLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }) } as unknown as Deps;
    const start = () => githubStart(new Request("http://up.test/maintainer/github/start", { headers: { "x-forwarded-for": "203.0.113.9" } }));
    expect((await start()).status).toBe(302);
    expect((await start()).status).toBe(302);
    expect((await start()).status).toBe(429);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `rm -rf node_modules/.vitest-cache && pnpm test apps/web/test/maintainer-sessions.test.ts apps/web/test/maintainer-routes.test.ts`
Expected: FAIL (2 tests): two states remain, and the third start isn't limited.

- [ ] **Step 3: Implement**

In `apps/web/lib/maintainers/sessions.ts`:
1. Import `lt` from drizzle-orm.
2. Start `issueOAuthState` with:

```ts
  // Sign-ins nobody finished are cleared out a day after they expire, so they can't pile up.
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)));
```

In `Deps` (`apps/web/lib/receipts/service.ts`), after `deviceLimiter`, add:

```ts
  /** Per-client cap on starting a maintainer sign-in or PayPal link. */
  signInLimiter?: RateLimiter;
```

In `apps/web/lib/deps.ts`, after `deviceLimiter: ...`, add `signInLimiter: createRateLimiter({ limit: 30, windowMs: hour }),`.

In both start routes:
1. Import `clientKey` from `../../../../lib/http`.
2. Right after `const deps = await getDeps();`, add:

```ts
  if (deps.signInLimiter && !deps.signInLimiter.take(clientKey(req))) return plainPage("Too many sign-in attempts from here. Please wait a while and try again.", 429);
```

In `apps/web/.env.example`, replace the `# PayPal sandbox app` comment line with:

```bash
# GitHub OAuth app for maintainer sign-in (github.com/settings/developers). Its callback is
# <PUBLIC_URL>/maintainer/github/callback. Separate from GITHUB_TOKEN above.
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
# PayPal sandbox app. Log in with PayPal's return URL in the PayPal dashboard is <PUBLIC_URL>/maintainer/paypal/callback.
```

In `apps/web/scripts/claim-maintainer.ts`, replace the first two comment lines with:

```ts
// Sandbox only, for seeding a demo maintainer: records that a GitHub login can be paid at a PayPal account id,
// as if they had linked it `daysAgo` days ago (default 8, past the first-payout hold). Real maintainers sign in
// with GitHub and link PayPal themselves at /maintainer; if that login signs in later, the seeded claim is theirs.
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `rm -rf node_modules/.vitest-cache && pnpm test`, then `pnpm --filter web exec tsc --noEmit`
Expected: every test passes (288, plus 1 skipped), and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/maintainers/sessions.ts apps/web/lib/receipts/service.ts apps/web/lib/deps.ts apps/web/app/maintainer/github/start/route.ts apps/web/app/maintainer/paypal/start/route.ts apps/web/.env.example apps/web/scripts/claim-maintainer.ts apps/web/test/maintainer-sessions.test.ts apps/web/test/maintainer-routes.test.ts
git commit -m "Limit sign-in starts, clear unfinished ones, and document the OAuth settings"
```

---

### Task 7: Live run on the hosted app (after the Render deploy)

No new code. This runs once the app is on Render with an https address (Plan 3's deploy). Until then, Tasks 1 to 6 can merge.

**Files:**
- Create: `docs/e2e-plan-2c.md`. It contains no secrets, and names no real maintainer.

**Needs:**
- The Render URL. `PUBLIC_URL` is set to it on Render.
- **A GitHub OAuth app.** Claude creates it at github.com/settings/developers while Arun is logged in to GitHub:
  - Homepage: the Render URL.
  - Callback: `<URL>/maintainer/github/callback`.
  - Its client id and secret go into Render's environment as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, never into the repo.
- **Log in with PayPal's settings.** In the PayPal developer dashboard (app "Upstream", Log in with PayPal), which needs Arun's PayPal login, Claude:
  - sets the return URL to `<URL>/maintainer/paypal/callback`
  - turns on the "PayPal account ID" and "Account verification status" attributes, without which a link shows "isn't fully set up"
  - records whether PayPal echoes `state` on success and on cancel
- **The sandbox maintainer test account's password.** Claude creates a new one with a self-set password, as in Plan 2a, so nothing is read off the screen.

- [ ] **Step 1: Sign in with GitHub on the hosted page**

Open `<URL>/maintainer`, click "Sign in with GitHub" and approve.
Expected: back on `/maintainer`, showing "Signed in as <login>".

- [ ] **Step 2: Link PayPal**

Click "Link PayPal" and log in as the sandbox personal account.
Expected:
- Back on `/maintainer?paypal=linked`.
- The page says "PayPal is linked. Your first payout can go out from <a date 7 days on>."
- The `maintainers` row has the account's PayPal id. Check it against the "Account ID" in the developer dashboard.

- [ ] **Step 3: Refusals**

1. Start a link and finish it in a different browser profile. Expected: "This PayPal link has expired, was already used, or didn't start in this browser."
2. Link a second maintainer to the same sandbox account. Expected: `?paypal=in-use`.

- [ ] **Step 4: Record and commit**

Write `docs/e2e-plan-2c.md` covering:
- what each step showed
- the real userinfo fields PayPal returned, recorded as field names and types only
- anything surprising

```bash
git add docs/e2e-plan-2c.md
git commit -m "Record Plan 2c live sign-in run"
```

---

## After Plan 2c

**Plan 3 (product and deploy):**
- the Render deploy (web service, Postgres, and the two crons from Plan 2b)
- Plan 2c Task 7
- the styled dashboard and maintainer page
- the Agent Usage vs Funding index
- demo mode, seeding its maintainer with `claim-maintainer`
- re-running `settle-pg.test.ts` against Render's Postgres
- the README, the video and the Devpost submission
