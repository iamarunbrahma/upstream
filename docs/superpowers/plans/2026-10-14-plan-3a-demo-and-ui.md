# Upstream Plan 3a: Demo Mode and the New UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A judge with no Claude Code, no Gemini key and no PayPal account of their own can press **Try the demo** and run the whole flow on the PayPal sandbox:
- add money with PayPal
- run a recorded Claude Code session through the real receipt pipeline and the real Gemini judge
- approve the receipt
- press **Settle now** and see where every cent went

The site gets a polished look built on Tailwind and shadcn/ui, and the landing page opens with the "Agent usage vs funding" chart.

**Architecture:**
- **Demo accounts are ordinary funder accounts with a flag** (`accounts.demo`, migration 0007). Only they get the sample session and Settle now, and only while the server runs with `DEMO_MODE=1`. Each visitor gets a fresh one, so judges never see each other's clicks.
- **Settle now settles one funder.** `settle()` and `runSettlement()` take an optional `funderId`. Package lookups, the funders settled and the receipts spent are all limited to that funder. Payout queueing stays global, because it only moves money that is already set aside.
- **The payout floor is a server setting.** `MIN_PAYOUT_CENTS` (default $1) reaches `queuePayouts` through the settlement deps. The hosted sandbox demo uses 1 cent, so a judge's small budget really pays out.
- **The sample session is a real recorded transcript** (`lib/demo/sample-session.json`, cut down and anonymised as `docs/demo-sample-session.md` describes). The server rebuilds its evidence with the same `@upstream/core` functions the CLI uses, then calls the normal `submitReceipt`. Gemini runs within a shared daily budget, and past it the receipt is estimated without AI.
- **The index chart's usage side is a data file** made by `pnpm --filter web usage-index` from Arun's own sessions (package names and counts only). The money side is read live from `accruals`.
- **UI:** Tailwind CSS v4 and shadcn/ui (Radix base, "Nova" preset), restyled to one green accent. The dashboard becomes stat cards, the demo stepper and tabs. The receipts tab has tables and progress bars, the money tab has a package accordion with GitHub avatars, and the PayPal buttons sit in their own tab. Toasts report actions.

**Tech Stack:** Plans 1-2c's stack. New: `tailwindcss` and `@tailwindcss/postcss` 4.3.3, `shadcn` 4.21.4 (its CSS), `radix-ui` 1.8.1, `class-variance-authority` 0.7.1, `cn` 0.4.0, `lucide-react` 1.56.0, `recharts` 3.8.0, `sonner` 2.0.8, `tw-animate-css` 1.4.0, and the Geist font.

**Spec:** `docs/superpowers/specs/2026-10-14-upstream-design.md`. It covers:
- section 8 (screens 1-4: landing with the index, dashboard with the projection, receipt detail and the maintainer page)
- section 9 (the judge and demo path)
- section 16 (the Plan 3 decisions of 14 Oct)

Two of section 8's details are left for later on purpose:
- The receipt's "adjust sliders": approve and skip only, as in Plan 1's API.
- The projection inside the agent's MCP tool: the dashboard shows it, the agent doesn't yet.

**Verified 14 Oct 2026**, every task applied in a scratch worktree of `main` (commit 04d4d98):
- 321 tests pass across 49 files, with one Postgres-only test skipped.
- The web app typechecks, and `next build` lists `/demo/start`, `/api/demo/settle` and `/api/demo/sample-session`.
- A full local run with real sandbox money and real Gemini is recorded in `docs/e2e-plan-3a.md`.
- Every page was checked in Chrome at 1512 px and at 390 px, with no sideways scrolling.

**Builds on:** Plans 1, 2a, 2b and 2c on `main`. What matters here:
- `submitReceipt` and its limiter
- `settle`, `runSettlement`, `settlementDeps`, `describeRun`, `queuePayouts` and `MIN_PAYOUT_CENTS`
- `withAccount`, `sameOrigin`, `createSession`, `sessionCookie` and `clientKey`
- `createRateLimiter`
- the `FakePayPal` and `settlementWorld` test fixtures

**Plan 3b** comes next:
- the Render deploy, with Workflows for settlement, payout checks and the judge
- `upstream-pay` on npm, `.github/FUNDING.yml`, Arun's sandbox maintainer linked a week ahead, the webhook, Plan 2c Task 7
- the sample session recorded again with `upstream-pay` in it
- the video and the Devpost submission

## Global Constraints

- All of Plans 1, 2a, 2b and 2c's Global Constraints still apply:
  - integer cents
  - plain everyday copy, with " - " never an em dash
  - one short imperative commit line, with no attribution
  - pinned exact dependency versions
  - nothing secret committed
- Demo features exist only when `DEMO_MODE=1`, and only for accounts `POST /demo/start` made. A real account never sees them, and an unknown or real account gets a 403.
- Every cookie-authenticated write stays same-origin only (`withAccount` already refuses cross-site writes).
- Settle now spends only the caller's own budget.
- The sample session never re-runs the judge for an account that already has its receipt.
- Gemini calls from the demo share one daily budget (300 a day). Past it, receipts are estimated without AI and say so.
- `MIN_PAYOUT_CENTS` accepts a whole number of cents, at least 1. Anything else keeps $1.
- Nothing from Arun's local sessions leaves his machine except package names, session counts and average shares. Only packages on the public npm or PyPI registry are kept, and only those used in at least 3 sessions. **Arun sees the list before the branch is pushed.**
- The UI stays light, with one green accent (`--primary: oklch(0.53 0.13 155)`). Nothing scrolls sideways at 390 px. Status is never shown by colour alone: a badge always has words.

## Review Focus

1. **A judge double-clicks "Run a sample session".** Two requests race past the "already has one" check. Expect one receipt, with the judge called at most twice. `submitReceipt`'s upsert keeps one row per session.
2. **Settle now pressed twice at once.** `withSettleLock` serialises the runs. The second finds nothing approved and unsettled, so it answers 409 "Approve a receipt first." It never spends twice.
3. **The PayPal popup offers the visitor's own remembered PayPal email.** The demo copy and testing notes say to use the sandbox login. The 7-day hold and the same-person check still guard the payout.
4. **A GitHub avatar fails to load, or a login has no avatar.** The Radix avatar falls back to the login's first two letters.
5. **A phone-width visitor.** The header drops two links below 640 px, tables hide the "Why" column and show the reason under the package name, and the PayPal buttons stack.

---

### Task 1: A fresh demo account for each visitor

**Files:**
- Create: `apps/web/lib/demo/accounts.ts`, `apps/web/app/demo/start/route.ts`, `apps/web/test/demo.test.ts`
- Generate: `apps/web/drizzle/0007_young_lady_bullseye.sql` and its snapshot (`pnpm --filter web db:generate`)
- Modify: `apps/web/lib/db/schema.ts`, `apps/web/lib/receipts/service.ts` (the `Deps` type), `apps/web/lib/deps.ts`, `apps/web/app/api/me/route.ts`, `apps/web/test/settings.test.ts`, `apps/web/.env.example`

**Interfaces:**
- Produces:
  - `demoEnabled(): boolean`
  - `createDemoAccount(db): Promise<string>`
  - `isDemoAccount(db, accountId): Promise<boolean>`, which is false whenever `DEMO_MODE` is off
  - `Deps.demoStartLimiter?: RateLimiter`
  - `GET /api/me` gains `demo: boolean`
  - `POST /demo/start`: 303 to `/dashboard` with the session cookie, or 404 / 403 / 429

- [ ] **Step 1: Write the failing test** `apps/web/test/demo.test.ts` (the "Try the demo" block; Task 3 adds "Settle now" to this file)

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { isDemoAccount } from "../lib/demo/accounts";
import { createRateLimiter } from "../lib/limits";
import type { Deps } from "../lib/receipts/service";
import { SESSION_COOKIE } from "../lib/web-auth";
import { fakeRegistry } from "./helpers";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
const { POST: startDemo } = await import("../app/demo/start/route");
const { GET: getMe } = await import("../app/api/me/route");

const start = (origin = "http://up.test", ip = "203.0.113.7") =>
  startDemo(new Request("http://up.test/demo/start", { method: "POST", headers: { origin, host: "up.test", "x-forwarded-for": ip } }));
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;
const me = async (cookie: string) => (await getMe(new Request("http://up.test/api/me", { headers: { cookie } }))).json() as Promise<{ demo: boolean }>;

beforeEach(async () => {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  h.deps = { db, http: fakeRegistry, model: null, demoStartLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }) };
  process.env.DEMO_MODE = "1";
});
afterEach(() => {
  delete process.env.DEMO_MODE;
});

describe("Try the demo", () => {
  it("gives each visitor a fresh demo account, signed in, and sends them to the dashboard", async () => {
    const first = await start();
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/dashboard");
    expect(cookieOf(first).startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(await me(cookieOf(first))).toMatchObject({ demo: true });

    const second = await start();
    expect(cookieOf(second)).not.toBe(cookieOf(first));
  });

  it("is off unless the server runs the demo", async () => {
    delete process.env.DEMO_MODE;
    expect((await start()).status).toBe(404);
  });

  it("refuses a request another site started", async () => {
    expect((await start("https://evil.example")).status).toBe(403);
  });

  it("limits how many demo accounts one address can make", async () => {
    expect((await start()).status).toBe(303);
    expect((await start()).status).toBe(303);
    expect((await start()).status).toBe(429);
    expect((await start("http://up.test", "198.51.100.9")).status).toBe(303);
  });

  it("never treats a real account as a demo account", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    expect(await isDemoAccount(h.deps.db, accountId)).toBe(false);
    const res = await start();
    const cookie = cookieOf(res);
    expect(await me(cookie)).toMatchObject({ demo: true });
    delete process.env.DEMO_MODE;
    // A demo account stops being one when the server stops running the demo.
    expect(await me(cookie)).toMatchObject({ demo: false });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run apps/web/test/demo.test.ts`
Expected: FAIL, "Cannot find module '../lib/demo/accounts'".

- [ ] **Step 3: Add the column and generate the migration**

```diff
--- a/apps/web/lib/db/schema.ts
+++ b/apps/web/lib/db/schema.ts
@@ -8,4 +8,6 @@ const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull(
 export const accounts = pgTable("accounts", {
   id: uuid("id").primaryKey().defaultRandom(),
+  /** Made by "Try the demo" on the hosted sandbox demo; only these get the sample session and "Settle now". */
+  demo: boolean("demo").notNull().default(false),
   createdAt: createdAt(),
 });
```

Run: `pnpm --filter web db:generate`
Expected: a new `drizzle/0007_*.sql` containing exactly `ALTER TABLE "accounts" ADD COLUMN "demo" boolean DEFAULT false NOT NULL;`

- [ ] **Step 4: Write the demo account helpers and the route**

`apps/web/lib/demo/accounts.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts } from "../db/schema";

/** The hosted sandbox demo: "Try the demo" accounts, the sample session and "Settle now". Off unless DEMO_MODE=1. */
export function demoEnabled(): boolean {
  return process.env.DEMO_MODE === "1";
}

/** A new, empty funder account for one visitor of the demo. */
export async function createDemoAccount(db: Db): Promise<string> {
  const [account] = await db.insert(accounts).values({ demo: true }).returning({ id: accounts.id });
  return account!.id;
}

/** True only for an account "Try the demo" made, and only while this server runs the demo. */
export async function isDemoAccount(db: Db, accountId: string): Promise<boolean> {
  if (!demoEnabled()) return false;
  const [account] = await db.select({ demo: accounts.demo }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
  return account?.demo === true;
}
```

`apps/web/app/demo/start/route.ts`:

```ts
import { getDeps } from "../../../lib/deps";
import { createDemoAccount, demoEnabled } from "../../../lib/demo/accounts";
import { clientKey } from "../../../lib/http";
import { createSession, sameOrigin, sessionCookie } from "../../../lib/web-auth";

export const runtime = "nodejs";

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** "Try the demo": a fresh, empty funder account for this browser, so visitors never see each other's clicks. */
export async function POST(req: Request): Promise<Response> {
  if (!demoEnabled()) return text("Not found", 404);
  if (!sameOrigin(req)) return text("This didn't come from this site, so it was refused.", 403);
  const deps = await getDeps();
  if (deps.demoStartLimiter && !deps.demoStartLimiter.take(clientKey(req))) {
    return text("That's a lot of demo accounts from here this hour. Please try again later.", 429);
  }
  const accountId = await createDemoAccount(deps.db);
  const session = await createSession(deps.db, accountId);
  return new Response(null, {
    status: 303,
    headers: { location: "/dashboard", "set-cookie": sessionCookie(session, process.env.NODE_ENV === "production") },
  });
}
```

- [ ] **Step 5: Wire the limiter and the `demo` flag**

```diff
--- a/apps/web/lib/receipts/service.ts
+++ b/apps/web/lib/receipts/service.ts
@@ -25,4 +25,6 @@ export interface Deps {
   /** Per-client cap on starting a maintainer sign-in or PayPal link. */
   signInLimiter?: RateLimiter;
+  /** Per-client cap on "Try the demo" accounts. */
+  demoStartLimiter?: RateLimiter;
   /** PayPal REST client; null when the server has no PayPal credentials. */
   paypal?: PayPalApi | null;
```

```diff
--- a/apps/web/lib/deps.ts
+++ b/apps/web/lib/deps.ts
@@ -37,4 +37,5 @@ export function getDeps(): Promise<Deps> {
       deviceLimiter: createRateLimiter({ limit: 10, windowMs: hour }),
       signInLimiter: createRateLimiter({ limit: 30, windowMs: hour }),
+      demoStartLimiter: createRateLimiter({ limit: 10, windowMs: hour }),
       paypal:
         process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET
```

```diff
--- a/apps/web/app/api/me/route.ts
+++ b/apps/web/app/api/me/route.ts
@@ -1,4 +1,5 @@
 import { desc, eq, sql } from "drizzle-orm";
 import { receipts, subscriptions } from "../../../lib/db/schema";
+import { isDemoAccount } from "../../../lib/demo/accounts";
 import { balanceCents, givenCents } from "../../../lib/funding/ledger";
 import { getSettings } from "../../../lib/funding/settings";
@@ -28,4 +29,5 @@ export async function GET(req: Request): Promise<Response> {
       receipts: { proposed: 0, approved: 0, skipped: 0, ...Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) },
       paymentsReady: Boolean(deps.paypal),
+      demo: await isDemoAccount(deps.db, accountId),
     });
   });
```

The dashboard API's existing expectation gains the new field:

```diff
--- a/apps/web/test/settings.test.ts
+++ b/apps/web/test/settings.test.ts
@@ -73,4 +73,5 @@ describe("dashboard API", () => {
       receipts: { proposed: 1, approved: 0, skipped: 0 },
       paymentsReady: false,
+      demo: false,
     });
   });
```

```diff
--- a/apps/web/.env.example
+++ b/apps/web/.env.example
@@ -30,2 +30,4 @@ PUBLIC_URL=
 # Lets POST /api/settle run a settlement ("Settle now"). Leave empty to switch that endpoint off.
 SETTLE_TOKEN=
+# 1 turns on the hosted sandbox demo: "Try the demo" accounts, "Run a sample session" and "Settle now" for them.
+DEMO_MODE=
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run apps/web/test/demo.test.ts apps/web/test/settings.test.ts`
Expected: PASS (5 + 8).

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "Give each demo visitor a fresh funder account"
```

### Task 2: A lower payout floor for the sandbox demo

**Files:**
- Modify: `apps/web/lib/funding/payouts.ts`, `apps/web/lib/funding/settle.ts`, `apps/web/lib/funding/run.ts`, `apps/web/test/payouts.test.ts`, `apps/web/test/run.test.ts`, `apps/web/test/settle-fixtures.ts`, `apps/web/.env.example`

**Interfaces:**
- Produces:
  - `payoutFloorCents(value: string | undefined): number`
  - `queuePayouts(tx, settlementId, now, floorCents = MIN_PAYOUT_CENTS)`
  - `SettleDeps.minPayoutCents?: number`
  - `settlementDeps()` sets `minPayoutCents` from `MIN_PAYOUT_CENTS`

- [ ] **Step 1: Write the failing tests**

```diff
--- a/apps/web/test/payouts.test.ts
+++ b/apps/web/test/payouts.test.ts
@@ -4,5 +4,5 @@ import { beforeEach, describe, expect, it } from "vitest";
 import { accruals, maintainers, payoutItems, settlements } from "../lib/db/schema";
 import { balanceCents } from "../lib/funding/ledger";
-import { FIRST_PAYOUT_HOLD_MS, payOut, queuePayouts, resolvePayoutCheck } from "../lib/funding/payouts";
+import { FIRST_PAYOUT_HOLD_MS, MIN_PAYOUT_CENTS, payOut, payoutFloorCents, queuePayouts, resolvePayoutCheck } from "../lib/funding/payouts";
 import { settle } from "../lib/funding/settle";
 import { PayPalError } from "../lib/paypal/client";
@@ -220,4 +220,19 @@ describe("payOut", () => {
   });
 
+  it("pays any amount on a server whose payout floor is lower, like the sandbox demo", async () => {
+    const f = await w.funder(40);
+    await w.receipt(f, { b: 10_000 });
+    await w.claim("carol", "PAYER-CAROL", 8);
+    w.deps.minPayoutCents = 1;
+    expect(await run()).toMatchObject({ payoutLines: 1, queuedCents: 40 });
+  });
+
+  it("reads the payout floor from a whole number of cents, and keeps $1 for anything else", () => {
+    expect(MIN_PAYOUT_CENTS).toBe(100);
+    expect(payoutFloorCents("1")).toBe(1);
+    expect(payoutFloorCents("250")).toBe(250);
+    for (const bad of [undefined, "", "0", "-5", "0.5", "abc"]) expect(payoutFloorCents(bad)).toBe(100);
+  });
+
   it("waits 7 days after a maintainer links PayPal before their first payout", async () => {
     expect(FIRST_PAYOUT_HOLD_MS).toBe(7 * DAY);
```

```diff
--- a/apps/web/test/run.test.ts
+++ b/apps/web/test/run.test.ts
@@ -98,4 +98,16 @@ describe("settlementDeps", () => {
     expect(await down.repoFor("pypi", "never-seen")).toBe("later");
   });
+
+  it("takes the server's payout floor from MIN_PAYOUT_CENTS", async () => {
+    const db = createPgliteDb();
+    const make = () => settlementDeps({ db, http: async () => ({ status: 404, body: null }), model: null, paypal: new FakePayPal() } as unknown as Deps & { paypal: FakePayPal }, async () => ({ status: 404, body: null }));
+    expect(make().minPayoutCents).toBe(100);
+    process.env.MIN_PAYOUT_CENTS = "1";
+    try {
+      expect(make().minPayoutCents).toBe(1);
+    } finally {
+      delete process.env.MIN_PAYOUT_CENTS;
+    }
+  });
 });
 
```

```diff
--- a/apps/web/test/settle-fixtures.ts
+++ b/apps/web/test/settle-fixtures.ts
@@ -35,4 +35,5 @@ export async function settlementWorld() {
     recipients: async (repo: { owner: string; name: string }) => lookups[`${repo.owner}:${repo.name}`] ?? { source: "none" as const, recipients: [] },
     now: () => clock,
+    minPayoutCents: undefined as number | undefined,
   };
 
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm vitest run apps/web/test/payouts.test.ts apps/web/test/run.test.ts`
Expected: FAIL, 3 tests: `payoutFloorCents` is not a function, the 40-cent line isn't queued, and `minPayoutCents` is undefined.

- [ ] **Step 3: Implement**

```diff
--- a/apps/web/lib/funding/payouts.ts
+++ b/apps/web/lib/funding/payouts.ts
@@ -10,4 +10,10 @@ const DAY = 24 * 60 * 60 * 1000;
 /** A maintainer is paid once they're owed at least this much; below it, money carries over (spec section 7). */
 export const MIN_PAYOUT_CENTS = 100;
+
+/** This server's payout floor from MIN_PAYOUT_CENTS: a whole number of cents, at least 1. Anything else keeps $1. */
+export function payoutFloorCents(value: string | undefined): number {
+  const n = Number(value);
+  return value && Number.isInteger(n) && n >= 1 ? n : MIN_PAYOUT_CENTS;
+}
 /** Self-dealing control: a new maintainer's first payout waits this long after they link PayPal. */
 export const FIRST_PAYOUT_HOLD_MS = 7 * DAY;
@@ -37,7 +43,7 @@ const total = (rows: Array<{ cents: number }>) => rows.reduce((sum, r) => sum +
  * Runs inside the settlement's locked transaction. Gives money back to funders when it sat unclaimed for
  * 90 days, or when it would go to the funder's own PayPal account. Then puts everything held for each
- * maintainer who linked PayPal at least 7 days ago, and is owed $1 or more, on one payout line.
+ * maintainer who linked PayPal at least 7 days ago, and is owed at least the payout floor ($1 unless set lower), on one payout line.
  */
-export async function queuePayouts(tx: Db, settlementId: string, now: Date): Promise<QueueSummary> {
+export async function queuePayouts(tx: Db, settlementId: string, now: Date, floorCents = MIN_PAYOUT_CENTS): Promise<QueueSummary> {
   const refunded = await takeBackRefunded(tx);
   const unclaimed = await tx
@@ -76,5 +82,5 @@ export async function queuePayouts(tx: Db, settlementId: string, now: Date): Pro
     .where(and(eq(accruals.status, "held"), isNotNull(maintainers.paypalPayerId), lte(maintainers.claimedAt, new Date(now.getTime() - FIRST_PAYOUT_HOLD_MS))))
     .groupBy(maintainers.login, maintainers.githubId, maintainers.paypalPayerId)
-    .having(sql`sum(${accruals.cents}) >= ${MIN_PAYOUT_CENTS}`)
+    .having(sql`sum(${accruals.cents}) >= ${floorCents}`)
     .orderBy(maintainers.login);
   let queuedCents = 0;
```

```diff
--- a/apps/web/lib/funding/settle.ts
+++ b/apps/web/lib/funding/settle.ts
@@ -22,4 +22,6 @@ export interface SettleDeps {
   recipients: (repo: RepoRef) => Promise<RepoRecipients | "later">;
   now?: () => Date;
+  /** Pay a maintainer once they're owed this much; $1 unless the server sets it lower (the sandbox demo). */
+  minPayoutCents?: number;
 }
 
@@ -137,5 +139,5 @@ export async function settle(deps: SettleDeps): Promise<SettleSummary> {
       }
     }
-    return { ...summary, ...(await queuePayouts(tx, run!.id, now)) };
+    return { ...summary, ...(await queuePayouts(tx, run!.id, now, deps.minPayoutCents)) };
   });
 }
```

```diff
--- a/apps/web/lib/funding/run.ts
+++ b/apps/web/lib/funding/run.ts
@@ -5,5 +5,5 @@ import { lookupPackage } from "../resolver/cache";
 import { recipientsFor, type GithubGet } from "../resolver/recipients";
 import { reconcilePayouts } from "./payout-status";
-import { payOut, type PayoutDeps, type SendResult } from "./payouts";
+import { payOut, payoutFloorCents, type PayoutDeps, type SendResult } from "./payouts";
 import { settle, type SettleDeps, type SettleSummary } from "./settle";
 
@@ -31,4 +31,5 @@ export function settlementDeps(deps: Deps & { paypal: PayPalApi }, gh: GithubGet
     },
     recipients: (repo) => recipientsFor(deps.db, gh, repo, clock()),
+    minPayoutCents: payoutFloorCents(process.env.MIN_PAYOUT_CENTS),
   };
 }
```

```diff
--- a/apps/web/.env.example
+++ b/apps/web/.env.example
@@ -32,2 +32,4 @@ SETTLE_TOKEN=
 # 1 turns on the hosted sandbox demo: "Try the demo" accounts, "Run a sample session" and "Settle now" for them.
 DEMO_MODE=
+# Pay a maintainer once they are owed this many cents. Leave empty for $1; the hosted sandbox demo uses 1.
+MIN_PAYOUT_CENTS=
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/web/test/payouts.test.ts apps/web/test/run.test.ts`
Expected: PASS (16 + 8).

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Let a server set a lower payout floor for the sandbox demo"
```

### Task 3: Settle now, for a demo account's own budget

**Files:**
- Create: `apps/web/lib/demo/settle-now.ts`, `apps/web/app/api/demo/settle/route.ts`
- Modify: `apps/web/lib/funding/settle.ts`, `apps/web/lib/funding/run.ts`, `apps/web/lib/receipts/service.ts`, `apps/web/lib/deps.ts`, `apps/web/test/settle.test.ts`, `apps/web/test/demo.test.ts`

**Interfaces:**
- Consumes: Task 1's `demoEnabled` and `isDemoAccount`; Task 2's `settlementDeps`.
- Produces:
  - `SettleOptions { funderId?: string }`
  - `settle(deps, opts?)` and `runSettlement(deps, opts?)`
  - `settleNowBlocker(db, accountId): Promise<string | null>`
  - `Deps.demoSettleLimiter?`
  - `POST /api/demo/settle`, which answers `{ summary: string[] }`, or 404 / 403 / 409 / 429 / 503

- [ ] **Step 1: Write the failing tests**

```diff
--- a/apps/web/test/settle.test.ts
+++ b/apps/web/test/settle.test.ts
@@ -104,4 +104,19 @@ describe("settle", () => {
   });
 
+  it("can settle just one funder's budget, leaving everyone else's for the scheduled run", async () => {
+    const mine = await w.funder(1000);
+    const theirs = await w.funder(1000);
+    await w.receipt(mine, { a: 10_000 });
+    const other = await w.receipt(theirs, { b: 10_000 });
+    const looked: string[] = [];
+    const repoFor = w.deps.repoFor;
+    const run = await settle({ ...w.deps, repoFor: (e, n) => (looked.push(n), repoFor(e, n)) }, { funderId: mine });
+    expect(run).toMatchObject({ settledFunders: 1, setAsideCents: 1000 });
+    expect(looked).toEqual(["a"]);
+    expect(await settledBy(other)).toBeNull();
+    expect(await balanceCents(w.db, theirs)).toBe(1000);
+    expect(await settle(w.deps)).toMatchObject({ settledFunders: 1, setAsideCents: 1000 });
+  });
+
   it("only spends each funder's own budget", async () => {
     const rich = await w.funder(1000);
```

```diff
--- a/apps/web/test/demo.test.ts
+++ b/apps/web/test/demo.test.ts
@@ -3,8 +3,11 @@ import { createDevice } from "../lib/auth";
 import { createPgliteDb } from "../lib/db/client";
 import { migrateDb } from "../lib/db/migrate";
+import { receiptItems, receipts, recipientCache } from "../lib/db/schema";
 import { isDemoAccount } from "../lib/demo/accounts";
+import { recordFunding } from "../lib/funding/ledger";
+import { FakePayPal } from "../lib/paypal/fake";
 import { createRateLimiter } from "../lib/limits";
 import type { Deps } from "../lib/receipts/service";
-import { SESSION_COOKIE } from "../lib/web-auth";
+import { accountForSession, createSession, SESSION_COOKIE } from "../lib/web-auth";
 import { fakeRegistry } from "./helpers";
 
@@ -13,4 +16,5 @@ vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
 const { POST: startDemo } = await import("../app/demo/start/route");
 const { GET: getMe } = await import("../app/api/me/route");
+const { POST: settleNow } = await import("../app/api/demo/settle/route");
 
 const start = (origin = "http://up.test", ip = "203.0.113.7") =>
@@ -68,2 +72,78 @@ describe("Try the demo", () => {
   });
 });
+
+describe("Settle now", () => {
+  /** A registry where pypi "widget" lives at github.com/acme/widget, whose one maintainer is already known. */
+  const widgetRegistry = async (url: string) =>
+    url.includes("pypi.org/pypi/widget/json")
+      ? { status: 200, body: { info: { summary: "Widgets", project_urls: { Source: "https://github.com/acme/widget" } } } }
+      : { status: 404, body: null };
+
+  beforeEach(async () => {
+    h.deps = { ...h.deps, http: widgetRegistry, paypal: new FakePayPal(), demoSettleLimiter: createRateLimiter({ limit: 3, windowMs: 60_000 }) };
+    await h.deps.db.insert(recipientCache).values({
+      repo: "acme/widget",
+      data: { source: "funding", recipients: [{ login: "alice", githubId: 42, shareBp: 10_000 }] },
+      fetchedAt: new Date(),
+    });
+  });
+
+  const press = (cookie: string, origin = "http://up.test") =>
+    settleNow(new Request("http://up.test/api/demo/settle", { method: "POST", headers: { cookie, origin, host: "up.test" } }));
+  /** A signed-in demo account: its cookie and its id. */
+  const demoFunder = async () => {
+    const cookie = cookieOf(await start());
+    return { cookie, accountId: (await accountForSession(h.deps.db, cookie.split("=")[1]!))! };
+  };
+  const approvedReceipt = async (accountId: string) => {
+    const [r] = await h.deps.db
+      .insert(receipts)
+      .values({ accountId, sessionId: "s-1", agent: "claude-code", endedAt: new Date(), status: "approved", source: "ai", promptVersion: "judge-v2" })
+      .returning({ id: receipts.id });
+    await h.deps.db.insert(receiptItems).values({
+      receiptId: r!.id, ecosystem: "pypi", name: "widget", weightBp: 10_000, role: "foundation", reason: "test",
+      evidence: { ecosystem: "pypi", name: "widget", installed: true, manifestAdded: false, importFiles: 1, usageLines: 1, docsReads: 0, kind: "dependency", description: null },
+    });
+  };
+  const fund = (accountId: string, cents: number) =>
+    recordFunding(h.deps.db, { accountId, source: "topup", paypalId: `CAP-${accountId}`, amountCents: cents, payerId: "BUYER", occurredAt: new Date(), raw: null });
+
+  it("settles the demo account's own budget and says what happened", async () => {
+    const { cookie, accountId } = await demoFunder();
+    await fund(accountId, 1000);
+    await approvedReceipt(accountId);
+    const res = await press(cookie);
+    expect(res.status).toBe(200);
+    expect(((await res.json()) as { summary: string[] }).summary).toEqual([
+      "Settled 1 developer's budget: $10.00 set aside for open-source maintainers.",
+    ]);
+  });
+
+  it("says what to do first when there's no money or nothing approved yet", async () => {
+    const { cookie, accountId } = await demoFunder();
+    const first = await press(cookie);
+    expect(first.status).toBe(409);
+    expect(((await first.json()) as { error: string }).error).toBe("Add money to your budget first.");
+    await fund(accountId, 500);
+    const second = await press(cookie);
+    expect(second.status).toBe(409);
+    expect(((await second.json()) as { error: string }).error).toBe("Approve a receipt first. Settling splits your budget across the receipts you approved.");
+  });
+
+  it("is only for demo accounts, only on the demo server, and only from this site", async () => {
+    const { cookie } = await demoFunder();
+    expect((await press(cookie, "https://evil.example")).status).toBe(403);
+    delete process.env.DEMO_MODE;
+    expect((await press(cookie)).status).toBe(404);
+    process.env.DEMO_MODE = "1";
+    const { accountId } = await createDevice(h.deps.db, null);
+    const real = `${SESSION_COOKIE}=${await createSession(h.deps.db, accountId)}`;
+    expect((await press(real)).status).toBe(403);
+  });
+
+  it("limits how often one account can press it", async () => {
+    const { cookie } = await demoFunder();
+    for (let i = 0; i < 3; i++) expect((await press(cookie)).status).toBe(409);
+    expect((await press(cookie)).status).toBe(429);
+  });
+});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm vitest run apps/web/test/settle.test.ts apps/web/test/demo.test.ts`
Expected: FAIL. `demo.test.ts` can't import `../app/api/demo/settle/route`, and the one-funder test settles both funders.

- [ ] **Step 3: Settle one funder**

```diff
--- a/apps/web/lib/funding/settle.ts
+++ b/apps/web/lib/funding/settle.ts
@@ -36,14 +36,20 @@ export interface SettleSummary extends QueueSummary {
 }
 
+export interface SettleOptions {
+  /** Settle only this funder's budget ("Settle now" in the demo); everyone else waits for the scheduled run. */
+  funderId?: string;
+}
+
 type Lookup = RepoRecipients | "later" | null;
 const keyOf = (ecosystem: string, name: string) => `${ecosystem}:${name}`;
+const forFunder = (opts: SettleOptions) => (opts.funderId ? eq(receipts.accountId, opts.funderId) : undefined);
 
 /** Looks up every package that unsettled approved receipts mention. Network calls happen here, outside the lock. */
-async function lookUpPackages(deps: SettleDeps): Promise<Map<string, Lookup>> {
+async function lookUpPackages(deps: SettleDeps, opts: SettleOptions): Promise<Map<string, Lookup>> {
   const pkgs = await deps.db
     .selectDistinct({ ecosystem: receiptItems.ecosystem, name: receiptItems.name })
     .from(receiptItems)
     .innerJoin(receipts, eq(receipts.id, receiptItems.receiptId))
-    .where(and(eq(receipts.status, "approved"), isNull(receipts.settlementId)));
+    .where(and(eq(receipts.status, "approved"), isNull(receipts.settlementId), forFunder(opts)));
   const found = new Map<string, Lookup>();
   for (const p of pkgs) {
@@ -115,7 +121,7 @@ async function settleFunder(tx: Db, settlementId: string, funderId: string, foun
  * owed on payout lines (sent by payOut). Safe to run twice: each receipt and each accrual is spent once.
  */
-export async function settle(deps: SettleDeps): Promise<SettleSummary> {
+export async function settle(deps: SettleDeps, opts: SettleOptions = {}): Promise<SettleSummary> {
   const now = deps.now?.() ?? new Date();
-  const found = await lookUpPackages(deps);
+  const found = await lookUpPackages(deps, opts);
   // The lock keeps two settlement runs from spending the same budget.
   return withSettleLock(deps.db, async (tx) => {
@@ -129,5 +135,5 @@ export async function settle(deps: SettleDeps): Promise<SettleSummary> {
       .selectDistinct({ id: receipts.accountId })
       .from(receipts)
-      .where(and(eq(receipts.status, "approved"), isNull(receipts.settlementId)));
+      .where(and(eq(receipts.status, "approved"), isNull(receipts.settlementId), forFunder(opts)));
     const summary = { settlementId: run!.id, expiredReceipts: expired.length, settledFunders: 0, waitingFunders: 0, setAsideCents: 0 };
     for (const f of funders) {
```

```diff
--- a/apps/web/lib/funding/run.ts
+++ b/apps/web/lib/funding/run.ts
@@ -6,5 +6,5 @@ import { recipientsFor, type GithubGet } from "../resolver/recipients";
 import { reconcilePayouts } from "./payout-status";
 import { payOut, payoutFloorCents, type PayoutDeps, type SendResult } from "./payouts";
-import { settle, type SettleDeps, type SettleSummary } from "./settle";
+import { settle, type SettleDeps, type SettleOptions, type SettleSummary } from "./settle";
 
 export type RunDeps = SettleDeps & PayoutDeps;
@@ -41,8 +41,8 @@ export async function runPayouts(deps: RunDeps): Promise<PayoutRunReport> {
 }
 
-/** The whole job: catch up on payout statuses with PayPal, settle, then send payouts. */
-export async function runSettlement(deps: RunDeps): Promise<RunReport> {
+/** The whole job: catch up on payout statuses with PayPal, settle (everyone, or one funder), then send payouts. */
+export async function runSettlement(deps: RunDeps, opts: SettleOptions = {}): Promise<RunReport> {
   const checked = await reconcilePayouts(deps);
-  const summary = await settle(deps);
+  const summary = await settle(deps, opts);
   return { ...summary, reconciledLines: checked.updated, uncheckedBatches: checked.unreachable, sent: await payOut(deps) };
 }
```

- [ ] **Step 4: The plain-words blocker and the route**

`apps/web/lib/demo/settle-now.ts`:

```ts
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { receipts } from "../db/schema";
import { balanceCents } from "../funding/ledger";

/** Why "Settle now" has nothing to do for this funder yet, in plain words; null when it can run. */
export async function settleNowBlocker(db: Db, accountId: string): Promise<string | null> {
  if ((await balanceCents(db, accountId)) <= 0) return "Add money to your budget first.";
  const [open] = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.accountId, accountId), eq(receipts.status, "approved"), isNull(receipts.settlementId)))
    .limit(1);
  return open ? null : "Approve a receipt first. Settling splits your budget across the receipts you approved.";
}
```

`apps/web/app/api/demo/settle/route.ts`:

```ts
import { demoEnabled, isDemoAccount } from "../../../../lib/demo/accounts";
import { settleNowBlocker } from "../../../../lib/demo/settle-now";
import { describeRun, runSettlement, settlementDeps } from "../../../../lib/funding/run";
import { json, withAccount } from "../../../../lib/http";
import { createGithubGet } from "../../../../lib/resolver/recipients";

export const runtime = "nodejs";

/** "Settle now" on the sandbox demo: settles this demo account's budget only, then sends what's ready to PayPal. */
export async function POST(req: Request): Promise<Response> {
  if (!demoEnabled()) return json({ error: "not found" }, 404);
  return withAccount(req, async (deps, accountId) => {
    if (!(await isDemoAccount(deps.db, accountId))) return json({ error: "Settle now is only for demo accounts." }, 403);
    if (!deps.paypal) return json({ error: "Payments aren't set up on this server yet." }, 503);
    if (deps.demoSettleLimiter && !deps.demoSettleLimiter.take(accountId)) {
      return json({ error: "That's a lot of settling. Please wait a few minutes." }, 429);
    }
    const blocker = await settleNowBlocker(deps.db, accountId);
    if (blocker) return json({ error: blocker }, 409);
    const run = settlementDeps({ ...deps, paypal: deps.paypal }, createGithubGet(process.env.GITHUB_TOKEN));
    const report = await runSettlement(run, { funderId: accountId });
    return json({ summary: describeRun(report) });
  });
}
```

```diff
--- a/apps/web/lib/receipts/service.ts
+++ b/apps/web/lib/receipts/service.ts
@@ -27,4 +27,6 @@ export interface Deps {
   /** Per-client cap on "Try the demo" accounts. */
   demoStartLimiter?: RateLimiter;
+  /** Per-account cap on the demo's "Settle now". */
+  demoSettleLimiter?: RateLimiter;
   /** PayPal REST client; null when the server has no PayPal credentials. */
   paypal?: PayPalApi | null;
```

```diff
--- a/apps/web/lib/deps.ts
+++ b/apps/web/lib/deps.ts
@@ -38,4 +38,5 @@ export function getDeps(): Promise<Deps> {
       signInLimiter: createRateLimiter({ limit: 30, windowMs: hour }),
       demoStartLimiter: createRateLimiter({ limit: 10, windowMs: hour }),
+      demoSettleLimiter: createRateLimiter({ limit: 30, windowMs: hour }),
       paypal:
         process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run apps/web/test/settle.test.ts apps/web/test/demo.test.ts`
Expected: PASS (11 + 9).

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "Add Settle now for a demo account's own budget"
```

### Task 4: What settling today would give, and where the money went

**Files:**
- Create: `apps/web/lib/funding/view.ts`, `apps/web/test/funder-view.test.ts`
- Modify: `apps/web/app/api/me/route.ts`, `apps/web/test/settings.test.ts`

**Interfaces:**
- Produces:
  - `projectSplit(db, accountId): Promise<ProjectedShare[]>`, where `ProjectedShare = { ecosystem, name, cents }`
  - `givenLines(db, accountId): Promise<GivenLine[]>`, where `GivenLine = { login, ecosystem, name, cents, state }`
  - `GivenState = "waiting" | "held" | "on-its-way" | "paid" | "returned"`
  - `GET /api/me` gains `projection` and `given`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { givenLines, projectSplit } from "../lib/funding/view";
import { runSettlement } from "../lib/funding/run";
import { settlementWorld } from "./settle-fixtures";

let w: Awaited<ReturnType<typeof settlementWorld>>;
beforeEach(async () => {
  w = await settlementWorld();
});

describe("projectSplit", () => {
  it("shows what settling today would set aside per package, to the cent, matching the settlement", async () => {
    const f = await w.funder(1350);
    await w.receipt(f, { a: 6000, b: 4000 });
    await w.receipt(f, { a: 10_000 });
    await w.receipt(f, { b: 10_000 }, "proposed");
    expect(await projectSplit(w.db, f)).toEqual([
      { ecosystem: "npm", name: "a", cents: 1080 },
      { ecosystem: "npm", name: "b", cents: 270 },
    ]);
    const run = await runSettlement(w.deps);
    expect(run.setAsideCents).toBe(1350);
    expect(await projectSplit(w.db, f)).toEqual([]);
  });

  it("is empty with an empty budget or nothing approved", async () => {
    const broke = await w.funder(0);
    await w.receipt(broke, { a: 10_000 });
    expect(await projectSplit(w.db, broke)).toEqual([]);
    expect(await projectSplit(w.db, await w.funder(500))).toEqual([]);
  });
});

describe("givenLines", () => {
  it("shows where the money went: waiting for a maintainer to join, on its way, then paid", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { a: 6000, b: 4000 });
    await w.claim("alice", "PAYER-ALICE", 8);
    await runSettlement(w.deps);
    expect(await givenLines(w.db, f)).toEqual([
      { login: "carol", ecosystem: "npm", name: "b", cents: 400, state: "waiting" },
      { login: "alice", ecosystem: "npm", name: "a", cents: 300, state: "on-its-way" },
      { login: "bob", ecosystem: "npm", name: "a", cents: 300, state: "waiting" },
    ]);
    const line = [...w.paypal.payoutBatches.values()][0]!.items[0]!;
    w.paypal.setPayoutItemStatus(line.payout_item!.sender_item_id!, "SUCCESS");
    await runSettlement(w.deps);
    expect((await givenLines(w.db, f)).find((l) => l.login === "alice")).toMatchObject({ state: "paid", cents: 300 });
  });

  it("says when a maintainer has joined but their payout hasn't gone out yet", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await w.claim("carol", "PAYER-CAROL", 2);
    await runSettlement(w.deps);
    expect(await givenLines(w.db, f)).toEqual([{ login: "carol", ecosystem: "npm", name: "b", cents: 1000, state: "held" }]);
  });

  it("shows money given back to the budget", async () => {
    const f = await w.funder(1000, "PAYER-CAROL");
    await w.receipt(f, { b: 10_000 });
    await w.claim("carol", "PAYER-CAROL", 8);
    await runSettlement(w.deps);
    expect(await givenLines(w.db, f)).toEqual([{ login: "carol", ecosystem: "npm", name: "b", cents: 1000, state: "returned" }]);
  });
});
```

```diff
--- a/apps/web/test/settings.test.ts
+++ b/apps/web/test/settings.test.ts
@@ -74,4 +74,6 @@ describe("dashboard API", () => {
       paymentsReady: false,
       demo: false,
+      projection: [],
+      given: [],
     });
   });
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run apps/web/test/funder-view.test.ts apps/web/test/settings.test.ts`
Expected: FAIL, "Cannot find module '../lib/funding/view'", and the dashboard API test is missing `projection` and `given`.

- [ ] **Step 3: Implement**

```ts
import type { Ecosystem } from "@upstream/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals, maintainers, receiptItems, receipts } from "../db/schema";
import { balanceCents } from "./ledger";
import { splitCents } from "./split";

export interface ProjectedShare {
  ecosystem: Ecosystem;
  name: string;
  cents: number;
}

/**
 * What settling today would set aside per package: the whole budget, split by the summed weights of the approved
 * receipts not settled yet, in the same order and rounding as the settlement. Largest first.
 */
export async function projectSplit(db: Db, accountId: string): Promise<ProjectedShare[]> {
  const budget = await balanceCents(db, accountId);
  if (budget <= 0) return [];
  const rows = await db
    .select({ ecosystem: receiptItems.ecosystem, name: receiptItems.name, bp: sql<string>`sum(${receiptItems.weightBp})` })
    .from(receiptItems)
    .innerJoin(receipts, eq(receipts.id, receiptItems.receiptId))
    .where(and(eq(receipts.accountId, accountId), eq(receipts.status, "approved"), isNull(receipts.settlementId)))
    .groupBy(receiptItems.ecosystem, receiptItems.name);
  const pkgs = rows.map((r) => ({ ecosystem: r.ecosystem, name: r.name, bp: Number(r.bp) }));
  pkgs.sort((a, b) => `${a.ecosystem}:${a.name}`.localeCompare(`${b.ecosystem}:${b.name}`));
  const cents = splitCents(budget, pkgs.map((p) => p.bp));
  return pkgs
    .map((p, i) => ({ ecosystem: p.ecosystem, name: p.name, cents: cents[i]! }))
    .filter((p) => p.cents > 0)
    .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
}

/**
 * waiting: the maintainer hasn't linked PayPal yet. held: they have, and it goes out on a coming payout.
 * on-its-way: on a payout PayPal hasn't confirmed. paid: PayPal confirmed it. returned: back in the budget.
 */
export type GivenState = "waiting" | "held" | "on-its-way" | "paid" | "returned";

export interface GivenLine {
  login: string;
  ecosystem: Ecosystem;
  name: string;
  cents: number;
  state: GivenState;
}

/** Where this funder's money went, per maintainer and package. Largest first. */
export async function givenLines(db: Db, accountId: string): Promise<GivenLine[]> {
  const rows = await db
    .select({
      login: accruals.login,
      ecosystem: accruals.ecosystem,
      name: accruals.name,
      status: accruals.status,
      // Matched by GitHub account only, like every payout: a login can change hands.
      linked: sql<boolean>`bool_or(${maintainers.paypalPayerId} is not null)`,
      cents: sql<string>`sum(${accruals.cents})`,
    })
    .from(accruals)
    .leftJoin(maintainers, sql`${accruals.githubId} is not null and ${maintainers.githubId} = ${accruals.githubId}`)
    .where(eq(accruals.funderId, accountId))
    .groupBy(accruals.login, accruals.ecosystem, accruals.name, accruals.status);
  const stateOf = (status: string, linked: boolean): GivenState =>
    status === "held" ? (linked ? "held" : "waiting") : status === "queued" ? "on-its-way" : (status as GivenState);
  const merged = new Map<string, GivenLine>();
  for (const r of rows) {
    const state = stateOf(r.status, Boolean(r.linked));
    const key = `${r.login}|${r.ecosystem}|${r.name}|${state}`;
    const line = merged.get(key) ?? { login: r.login, ecosystem: r.ecosystem, name: r.name, cents: 0, state };
    line.cents += Number(r.cents);
    merged.set(key, line);
  }
  return [...merged.values()].sort((a, b) => b.cents - a.cents || a.login.localeCompare(b.login) || a.name.localeCompare(b.name));
}
```

```diff
--- a/apps/web/app/api/me/route.ts
+++ b/apps/web/app/api/me/route.ts
@@ -4,4 +4,5 @@ import { isDemoAccount } from "../../../lib/demo/accounts";
 import { balanceCents, givenCents } from "../../../lib/funding/ledger";
 import { getSettings } from "../../../lib/funding/settings";
+import { givenLines, projectSplit } from "../../../lib/funding/view";
 import { json, withAccount } from "../../../lib/http";
 
@@ -30,4 +31,6 @@ export async function GET(req: Request): Promise<Response> {
       paymentsReady: Boolean(deps.paypal),
       demo: await isDemoAccount(deps.db, accountId),
+      projection: await projectSplit(deps.db, accountId),
+      given: await givenLines(deps.db, accountId),
     });
   });
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/web/test/funder-view.test.ts apps/web/test/settings.test.ts`
Expected: PASS (5 + 8).

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Show a funder what settling today would give and where their money went"
```

### Task 5: The sample session, through the real pipeline

**Files:**
- Create: `apps/web/lib/demo/sample.ts`, `apps/web/app/api/demo/sample-session/route.ts`, `apps/web/test/demo-sample.test.ts`, `docs/demo-sample-session.md`
- Copy: `apps/web/lib/demo/sample-session.json`, the recorded transcript, from the scratch branch `scratch-3a` (`git checkout scratch-3a -- apps/web/lib/demo/sample-session.json`). It holds 43 entries, about 40 KB, and was checked to contain no paths outside `/home/dev`, no user names, no email addresses and no Claude Code attachments.
- Modify: `apps/web/lib/receipts/service.ts`, `apps/web/lib/deps.ts`

**Interfaces:**
- Consumes: Task 1's `isDemoAccount` and `createDemoAccount`.
- Produces:
  - `samplePayload(now?): ReceiptPayload`, with a session id that starts `sample:`
  - `receiptForSession(deps, accountId, sessionId): Promise<ReceiptView | null>`
  - `Deps.demoJudgeLimiter?`
  - `POST /api/demo/sample-session`, which answers `{ receipt, changed }`

- [ ] **Step 1: Write the failing test**

```ts
import { ReceiptPayload } from "@upstream/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { receipts } from "../lib/db/schema";
import { createDemoAccount } from "../lib/demo/accounts";
import { samplePayload } from "../lib/demo/sample";
import type { JudgeModel } from "../lib/judge/types";
import { createRateLimiter } from "../lib/limits";
import type { Deps } from "../lib/receipts/service";
import { createSession, SESSION_COOKIE } from "../lib/web-auth";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
const { POST: runSample } = await import("../app/api/demo/sample-session/route");

/** Answers like a registry that knows every package, without a network. */
const anyRegistry = async () => ({ status: 200, body: { info: { summary: "A package" }, description: "A package" } });
let calls = 0;
const model: JudgeModel = { id: "fake-model", generate: async () => (calls++, JSON.stringify({ packages: [] })) };

beforeEach(async () => {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  calls = 0;
  h.deps = { db, http: anyRegistry, model, demoJudgeLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) };
  process.env.DEMO_MODE = "1";
});
afterEach(() => {
  delete process.env.DEMO_MODE;
});

const cookieFor = async (accountId: string) => `${SESSION_COOKIE}=${await createSession(h.deps.db, accountId)}`;
const press = (cookie: string) =>
  runSample(new Request("http://up.test/api/demo/sample-session", { method: "POST", headers: { cookie, origin: "http://up.test", host: "up.test" } }));
type Answer = { receipt: { id: string; items: Array<{ name: string }> }; changed: boolean };

describe("the sample session", () => {
  it("is the receipt the upstream CLI would build from the recorded Claude Code session", () => {
    const p = samplePayload(new Date("2026-10-14T10:00:00Z"));
    expect(ReceiptPayload.safeParse(p).success).toBe(true);
    expect(p.sessionId.startsWith("sample:")).toBe(true);
    expect(p.agent).toBe("claude-code");
    expect(p.endedAt).toBe("2026-10-14T10:00:00.000Z");
    expect(p.packages.map((x) => x.name)).toEqual(expect.arrayContaining(["hono", "zod", "nanoid", "vitest"]));
  });

  it("runs once per demo account through the real receipt pipeline, and a second press shows the same receipt", async () => {
    const cookie = await cookieFor(await createDemoAccount(h.deps.db));
    const first = await press(cookie);
    expect(first.status).toBe(200);
    const a = (await first.json()) as Answer;
    expect(a.changed).toBe(true);
    expect(a.receipt.items.map((i) => i.name)).toContain("hono");
    const again = (await (await press(cookie)).json()) as Answer;
    expect(again).toMatchObject({ changed: false, receipt: { id: a.receipt.id } });
    const [row] = await h.deps.db.select({ judgeCount: receipts.judgeCount }).from(receipts).where(eq(receipts.id, a.receipt.id));
    expect(row!.judgeCount).toBe(1);
    expect(calls).toBe(1);
  });

  it("asks the AI judge within a daily budget for the whole demo, and estimates without AI past it", async () => {
    await press(await cookieFor(await createDemoAccount(h.deps.db)));
    const second = (await (await press(await cookieFor(await createDemoAccount(h.deps.db)))).json()) as Answer & { receipt: { source: string } };
    expect(calls).toBe(1);
    expect(second.receipt.source).toBe("fallback");
  });

  it("is only for demo accounts, on the demo server", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    expect((await press(await cookieFor(accountId))).status).toBe(403);
    delete process.env.DEMO_MODE;
    expect((await press(await cookieFor(await createDemoAccount(h.deps.db)))).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run apps/web/test/demo-sample.test.ts`
Expected: FAIL, "Cannot find module '../lib/demo/sample'".

- [ ] **Step 3: Implement**

`apps/web/lib/demo/sample.ts`:

```ts
import { buildEvidence, changesFromEvents, emptyDisk, parseTranscript, type ReceiptPayload } from "@upstream/core";
import sample from "./sample-session.json" with { type: "json" };

/**
 * A real Claude Code session, recorded for the demo: its transcript entries as Claude Code wrote them, with the
 * project folder's path anonymised. docs/demo-sample-session.md says how it was recorded.
 */
interface SampleFile {
  recordedAt: string;
  entries: unknown[];
}

/**
 * The receipt the upstream CLI would send for the recorded session, built the same way on the server. The project
 * folder isn't here, so its manifests are only what the transcript shows the agent installing and writing.
 */
export function samplePayload(now: Date = new Date()): ReceiptPayload {
  const transcript = parseTranscript((sample as SampleFile).entries.map((e) => JSON.stringify(e)).join("\n"));
  const { changes, installs, docsUrls } = changesFromEvents(transcript.events);
  const built = buildEvidence({ changes, installs, docsUrls, disk: emptyDisk() });
  return {
    sessionId: `sample:${transcript.sessionId}`,
    agent: "claude-code",
    title: transcript.title,
    endedAt: now.toISOString(),
    packages: built.packages,
  };
}
```

`apps/web/app/api/demo/sample-session/route.ts`:

```ts
import { demoEnabled, isDemoAccount } from "../../../../lib/demo/accounts";
import { samplePayload } from "../../../../lib/demo/sample";
import { json, withAccount } from "../../../../lib/http";
import { RateLimitError } from "../../../../lib/limits";
import { receiptForSession, submitReceipt } from "../../../../lib/receipts/service";

export const runtime = "nodejs";

/** "Run a sample session": sends the recorded Claude Code session through the real receipt pipeline, once per demo account. */
export async function POST(req: Request): Promise<Response> {
  if (!demoEnabled()) return json({ error: "not found" }, 404);
  return withAccount(req, async (deps, accountId) => {
    if (!(await isDemoAccount(deps.db, accountId))) return json({ error: "The sample session is only for demo accounts." }, 403);
    const payload = samplePayload();
    const existing = await receiptForSession(deps, accountId, payload.sessionId);
    if (existing) return json({ receipt: existing, changed: false });
    // The AI judge runs for real, within a daily budget for the whole demo. Past it, the receipt is estimated without AI.
    const model = deps.demoJudgeLimiter && !deps.demoJudgeLimiter.take("demo") ? null : deps.model;
    try {
      const { view, changed } = await submitReceipt({ ...deps, model }, accountId, payload);
      return json({ receipt: view, changed });
    } catch (e) {
      if (e instanceof RateLimitError) return json({ error: e.message }, 429);
      throw e;
    }
  });
}
```

```diff
--- a/apps/web/lib/receipts/service.ts
+++ b/apps/web/lib/receipts/service.ts
@@ -29,4 +29,6 @@ export interface Deps {
   /** Per-account cap on the demo's "Settle now". */
   demoSettleLimiter?: RateLimiter;
+  /** Cap on AI judging for the demo's sample session, shared by every demo account. */
+  demoJudgeLimiter?: RateLimiter;
   /** PayPal REST client; null when the server has no PayPal credentials. */
   paypal?: PayPalApi | null;
@@ -149,4 +151,10 @@ export function getReceipt(deps: Deps, accountId: string, id: string): Promise<R
 }
 
+/** This account's receipt for a session, if it has one. */
+export async function receiptForSession(deps: Deps, accountId: string, sessionId: string): Promise<ReceiptView | null> {
+  const found = await findBySession(deps.db, accountId, sessionId);
+  return found ? loadView(deps.db, accountId, found.id) : null;
+}
+
 export async function listReceipts(deps: Deps, accountId: string, status?: ReceiptStatus, limit = 20): Promise<ReceiptView[]> {
   const where = status ? and(eq(receipts.accountId, accountId), eq(receipts.status, status)) : eq(receipts.accountId, accountId);
```

```diff
--- a/apps/web/lib/deps.ts
+++ b/apps/web/lib/deps.ts
@@ -39,4 +39,5 @@ export function getDeps(): Promise<Deps> {
       demoStartLimiter: createRateLimiter({ limit: 10, windowMs: hour }),
       demoSettleLimiter: createRateLimiter({ limit: 30, windowMs: hour }),
+      demoJudgeLimiter: createRateLimiter({ limit: 300, windowMs: 24 * hour }),
       paypal:
         process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET
```

`docs/demo-sample-session.md`:

```markdown
# The demo's sample session

"Run a sample session" on the hosted demo replays `apps/web/lib/demo/sample-session.json` through the same
evidence builder the upstream CLI uses, then through the real receipt pipeline: the package registries, the AI
judge and the spending rule. Nothing about the receipt is written by hand.

## How it was recorded (14 Oct 2026)

- A Claude Code agent was asked to build a small link-shortener API in TypeScript in an empty folder: Hono with
  `@hono/node-server`, zod through `@hono/zod-validator`, nanoid for the codes, and vitest tests. It installed the
  packages with npm, wrote the code and tests, and ran them (10 passing).
- The transcript Claude Code saved for that agent was then cut down to what a receipt can use and what is safe to publish:
  - Kept: the task as typed, the agent's text and tool calls, and the tool results.
  - Dropped: everything Claude Code attaches to a session for its own use (instructions, memory, settings,
    request metadata, thinking), and one directory listing of an unrelated folder.
  - Anonymised: the project folder is shown as `/home/dev/linkshort`, the user name as `dev`, and the session id
    is a new random one.
- The session has no title. Claude Code adds one only to interactive sessions, and the CLI never sends prompts.

Plan 3b records it again as an interactive session once `upstream-pay` is on npm. Then the agent can add it as a dev
dependency, and the session gets a title.
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/web/test/demo-sample.test.ts`
Expected: PASS (4). The bundled session yields hono, @hono/node-server, @hono/zod-validator, zod, nanoid, vitest, typescript, tsx and @types/node.

- [ ] **Step 5: Commit**

```bash
git add apps/web docs/demo-sample-session.md
git commit -m "Replay a recorded Claude Code session as the demo's sample receipt"
```

### Task 6: The usage side of the index, from Arun's own sessions

**Files:**
- Create: `apps/web/lib/index/usage.ts`, `apps/web/scripts/usage-index.ts`, `apps/web/test/usage-index.test.ts`
- Generate: `apps/web/lib/index/usage.json`
- Modify: `apps/web/package.json` (the `usage-index` script)

**Interfaces:**
- Produces:
  - `aggregateUsage(sessions, { minSessions, top })`
  - `indexRows(db, usage, top = 15): Promise<{ sessions, generatedAt, fundedCents, rows: IndexRow[] }>`
  - the types `UsageEntry`, `UsageIndex` and `IndexRow`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { aggregateUsage, indexRows, type UsageIndex } from "../lib/index/usage";
import { settlementWorld } from "./settle-fixtures";
import { runSettlement } from "../lib/funding/run";

const share = (name: string, weightBp: number) => ({ ecosystem: "npm" as const, name, weightBp });

describe("aggregateUsage", () => {
  it("averages each package's share over every session, keeping packages seen in enough sessions", () => {
    const sessions = [[share("a", 6000), share("b", 4000)], [share("a", 10_000)], [share("c", 10_000)], [share("b", 10_000)], []];
    expect(aggregateUsage(sessions, { minSessions: 2, top: 10 })).toEqual({
      sessions: 4,
      packages: [
        { ecosystem: "npm", name: "a", sessions: 2, shareBp: 4000 },
        { ecosystem: "npm", name: "b", sessions: 2, shareBp: 3500 },
      ],
    });
  });

  it("keeps the top packages only", () => {
    const sessions = [[share("a", 5000), share("b", 3000), share("c", 2000)], [share("a", 5000), share("b", 3000), share("c", 2000)]];
    expect(aggregateUsage(sessions, { minSessions: 1, top: 2 }).packages.map((p) => p.name)).toEqual(["a", "b"]);
  });
});

describe("indexRows", () => {
  it("sets each package's share of agent work against its share of what Upstream has set aside", async () => {
    const w = await settlementWorld();
    const f = await w.funder(1000);
    await w.receipt(f, { a: 3000, z: 7000 });
    w.lookups["npm:z"] = { source: "funding", recipients: [{ login: "carol", githubId: 103, shareBp: 10_000 }] };
    await runSettlement(w.deps);
    const usage: UsageIndex = {
      generatedAt: "2026-10-14",
      sessions: 120,
      packages: [
        { ecosystem: "npm", name: "a", sessions: 80, shareBp: 2500 },
        { ecosystem: "npm", name: "b", sessions: 50, shareBp: 1500 },
      ],
    };
    expect(await indexRows(w.db, usage)).toEqual({
      sessions: 120,
      generatedAt: "2026-10-14",
      fundedCents: 1000,
      rows: [
        { ecosystem: "npm", name: "a", sessions: 80, usageBp: 2500, fundedCents: 300, fundingBp: 3000 },
        { ecosystem: "npm", name: "b", sessions: 50, usageBp: 1500, fundedCents: 0, fundingBp: 0 },
      ],
    });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run apps/web/test/usage-index.test.ts`
Expected: FAIL, "Cannot find module '../lib/index/usage'".

- [ ] **Step 3: Implement**

```ts
import type { Ecosystem } from "@upstream/core";
import { ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals } from "../db/schema";

/** How much of the agents' work one package did, over real Claude Code sessions. */
export interface UsageEntry {
  ecosystem: Ecosystem;
  name: string;
  /** Sessions that used the package. */
  sessions: number;
  /** Its average share of a session's work, in basis points, over every session counted. */
  shareBp: number;
}

/** `lib/index/usage.json`, written by `pnpm --filter web usage-index --write`. */
export interface UsageIndex {
  generatedAt: string;
  /** Sessions that used at least one package. */
  sessions: number;
  packages: UsageEntry[];
}

/**
 * Each package's average share of the work over every session that used any package, from each session's
 * evidence-based shares. Packages seen in fewer than `minSessions` sessions are left out. Largest first.
 */
export function aggregateUsage(
  sessions: Array<Array<{ ecosystem: Ecosystem; name: string; weightBp: number }>>,
  opts: { minSessions: number; top: number },
): Omit<UsageIndex, "generatedAt"> {
  const counted = sessions.filter((s) => s.length > 0);
  const totals = new Map<string, { ecosystem: Ecosystem; name: string; sessions: number; bp: number }>();
  for (const s of counted) {
    for (const p of s) {
      const key = `${p.ecosystem}:${p.name}`;
      const t = totals.get(key) ?? { ecosystem: p.ecosystem, name: p.name, sessions: 0, bp: 0 };
      t.sessions += 1;
      t.bp += p.weightBp;
      totals.set(key, t);
    }
  }
  const packages = [...totals.values()]
    .filter((t) => t.sessions >= opts.minSessions)
    .map((t) => ({ ecosystem: t.ecosystem, name: t.name, sessions: t.sessions, shareBp: Math.round(t.bp / counted.length) }))
    .sort((a, b) => b.shareBp - a.shareBp || a.name.localeCompare(b.name))
    .slice(0, opts.top);
  return { sessions: counted.length, packages };
}

export interface IndexRow extends Omit<UsageEntry, "shareBp"> {
  usageBp: number;
  /** What Upstream has set aside for the package's maintainers so far, and its share of everything set aside. */
  fundedCents: number;
  fundingBp: number;
}

/** The "Agent Usage vs Funding" chart: the top packages by agent work, each with what Upstream has set aside for it. */
export async function indexRows(db: Db, usage: UsageIndex, top = 15): Promise<{ sessions: number; generatedAt: string; fundedCents: number; rows: IndexRow[] }> {
  const funded = await db
    .select({ ecosystem: accruals.ecosystem, name: accruals.name, cents: sql<string>`sum(${accruals.cents})` })
    .from(accruals)
    .where(ne(accruals.status, "returned"))
    .groupBy(accruals.ecosystem, accruals.name);
  const byKey = new Map(funded.map((f) => [`${f.ecosystem}:${f.name}`, Number(f.cents)]));
  const total = [...byKey.values()].reduce((a, b) => a + b, 0);
  const rows = usage.packages.slice(0, top).map((p) => {
    const cents = byKey.get(`${p.ecosystem}:${p.name}`) ?? 0;
    return { ecosystem: p.ecosystem, name: p.name, sessions: p.sessions, usageBp: p.shareBp, fundedCents: cents, fundingBp: total > 0 ? Math.round((cents * 10_000) / total) : 0 };
  });
  return { sessions: usage.sessions, generatedAt: usage.generatedAt, fundedCents: total, rows };
}
```

The scanner, `apps/web/scripts/usage-index.ts`:

```ts
// Builds lib/index/usage.json, the usage side of the landing page's "Agent Usage vs Funding" chart, from this
// machine's past Claude Code sessions. Each session goes through the real upstream CLI (`receipt --dry-run`), so
// only what a receipt would carry is kept: package names and counts, never code, prompts or paths. Shares use the
// judge's evidence-only scores (no AI). Kept: packages on the public npm or PyPI registry, used in 3+ sessions.
//   pnpm --filter web usage-index            prints the list, for review before it's published
//   pnpm --filter web usage-index --write    writes lib/index/usage.json
// Needs the CLI built first: pnpm --filter upstream-pay build
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReceiptPayload } from "@upstream/core";
import { aggregateUsage, type UsageIndex } from "../lib/index/usage";
import { fallbackAllocations } from "../lib/judge/fallback";
import { fetchJson, resolvePackage } from "../lib/resolver/registry";

const MIN_SESSIONS = 3;
const KEEP = 30;
/** Bigger transcripts are skipped: the CLI reads a transcript whole, and Node can't hold one past 512 MB as text. */
const MAX_BYTES = 200 * 1024 * 1024;
const root = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
const cli = new URL("../../../packages/cli/plugin/dist/upstream.mjs", import.meta.url).pathname;
if (!existsSync(cli)) throw new Error("Build the CLI first: pnpm --filter upstream-pay build");

/** The folder the session ran in, from the first entries of the transcript. */
function sessionCwd(path: string): string | null {
  const head = Buffer.alloc(256 * 1024);
  const fd = openSync(path, "r");
  const n = readSync(fd, head, 0, head.length, 0);
  closeSync(fd);
  for (const line of head.subarray(0, n).toString("utf8").split("\n")) {
    try {
      const entry = JSON.parse(line) as { cwd?: unknown };
      if (typeof entry.cwd === "string") return entry.cwd;
    } catch {
      // Not a JSON line; keep looking.
    }
  }
  return null;
}

const transcripts = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(join(root, d.name)).filter((f) => f.endsWith(".jsonl")).map((f) => join(root, d.name, f)));

const sessions: Array<ReturnType<typeof fallbackAllocations>> = [];
let skipped = 0;
for (const path of transcripts) {
  const cwd = statSync(path).size <= MAX_BYTES ? sessionCwd(path) : null;
  const run = cwd ? spawnSync("node", [cli, "receipt", "--transcript", path, "--cwd", cwd, "--dry-run"], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }) : null;
  if (!run || run.status !== 0) {
    skipped += 1;
    continue;
  }
  const payload = JSON.parse(run.stdout) as ReceiptPayload;
  sessions.push(fallbackAllocations(payload.packages.map((p) => ({ ...p, description: null }))));
}

const all = aggregateUsage(sessions, { minSessions: MIN_SESSIONS, top: KEEP * 2 });
const packages = [];
for (const p of all.packages) {
  if (packages.length === KEEP) break;
  if ((await resolvePackage(p.ecosystem, p.name, fetchJson)).found) packages.push(p);
}
const index: UsageIndex = { generatedAt: new Date().toISOString().slice(0, 10), sessions: all.sessions, packages };

console.log(`${transcripts.length} transcripts, ${skipped} skipped, ${index.sessions} used at least one package.`);
packages.forEach((p, i) => console.log(`${String(i + 1).padStart(2)}. ${p.ecosystem.padEnd(4)} ${p.name.padEnd(32)} ${String(p.sessions).padStart(4)} sessions  ${(p.shareBp / 100).toFixed(1)}%`));
if (process.argv.includes("--write")) {
  writeFileSync(new URL("../lib/index/usage.json", import.meta.url), JSON.stringify(index, null, 2) + "\n");
  console.log("Wrote lib/index/usage.json");
}
```

```diff
--- a/apps/web/package.json
+++ b/apps/web/package.json
@@ -14,5 +14,6 @@
     "settle": "node --env-file-if-exists=.env.local --import tsx jobs/settle.ts",
     "claim-maintainer": "node --env-file-if-exists=.env.local --import tsx scripts/claim-maintainer.ts",
-    "resolve-payout-check": "node --env-file-if-exists=.env.local --import tsx scripts/resolve-payout-check.ts"
+    "resolve-payout-check": "node --env-file-if-exists=.env.local --import tsx scripts/resolve-payout-check.ts",
+    "usage-index": "node --import tsx scripts/usage-index.ts"
   },
   "dependencies": {
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/web/test/usage-index.test.ts`
Expected: PASS (3).

- [ ] **Step 5: Generate the data, for Arun's review**

Run: `pnpm --filter upstream-pay build && pnpm --filter web usage-index --write`
Expected:
- The 14 Oct scan found 558 transcripts, skipped 13 (too big, or no folder), and 15 sessions used at least one package.
- At the agreed threshold of 3 sessions, 5 packages pass: react, next, vitest, drizzle-orm and zod.
- The list goes into Arun's review before anything is pushed.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "Build the usage side of the Agent Usage vs Funding index from local sessions"
```

### Task 7: Tailwind, shadcn/ui and the site's frame

**Files:**
- Create: `apps/web/postcss.config.mjs`, `apps/web/components.json`, `apps/web/lib/utils.ts`, and `apps/web/components/ui/*` (generated)
- Rewrite: `apps/web/app/globals.css`, `apps/web/app/layout.tsx`, `apps/web/app/ui/chrome.tsx` (new)
- Modify: `apps/web/tsconfig.json` (the `@/*` alias), `apps/web/package.json`, `pnpm-lock.yaml`

The UI has no unit tests, as in Plans 1-2c. A task is verified by `typecheck`, `next build` and a look in Chrome, recorded as screenshots.

- [ ] **Step 1: Install Tailwind and add the alias**

```bash
pnpm --filter web add -D -E tailwindcss@4.3.3 @tailwindcss/postcss@4.3.3
```

```js
export default {
  plugins: { "@tailwindcss/postcss": {} },
};
```

```diff
--- a/apps/web/tsconfig.json
+++ b/apps/web/tsconfig.json
@@ -4,5 +4,6 @@
     "lib": ["ES2023", "DOM", "DOM.Iterable"],
     "jsx": "preserve",
-    "plugins": [{ "name": "next" }]
+    "plugins": [{ "name": "next" }],
+    "paths": { "@/*": ["./*"] }
   },
   "include": ["next-env.d.ts", "app", "lib", "scripts", "test", "drizzle.config.ts", "next.config.ts"],
```

Put `@import "tailwindcss";` in `apps/web/app/globals.css` so shadcn's check passes.

- [ ] **Step 2: Initialise shadcn/ui and add the components**

```bash
pnpm dlx shadcn@4.21.4 init -b radix -p nova --no-monorepo -y -c apps/web < /dev/null
pnpm dlx shadcn@4.21.4 add button card badge table tabs progress tooltip accordion skeleton sonner switch select alert chart avatar -y -c apps/web < /dev/null
```

Expected: `components.json` (style `radix-nova`), `lib/utils.ts` and 15 files in `components/ui/`. Then:
- Pin every caret version shadcn added to the installed one.
- Remove `next-themes` (`pnpm --filter web remove next-themes`). The toaster is light only.
- Run `pnpm install` so the lockfile matches.

```diff
--- a/apps/web/package.json
+++ b/apps/web/package.json
@@ -22,15 +22,25 @@
     "@paypal/react-paypal-js": "10.6.0",
     "@upstream/core": "workspace:*",
+    "class-variance-authority": "0.7.1",
+    "cn": "0.4.0",
     "drizzle-orm": "0.45.4",
+    "lucide-react": "1.56.0",
     "next": "16.4.0",
     "pg": "8.23.1",
+    "radix-ui": "1.8.1",
     "react": "19.3.0",
     "react-dom": "19.3.0",
+    "recharts": "3.8.0",
+    "shadcn": "4.21.4",
+    "sonner": "2.0.8",
+    "tw-animate-css": "1.4.0",
     "zod": "4.6.7"
   },
   "devDependencies": {
+    "@tailwindcss/postcss": "4.3.3",
     "@types/pg": "8.23.1",
     "@types/react": "19.3.0",
-    "drizzle-kit": "0.31.11"
+    "drizzle-kit": "0.31.11",
+    "tailwindcss": "4.3.3"
   }
 }
```

```diff
new file mode 100644
--- /dev/null
+++ b/apps/web/components/ui/sonner.tsx
@@ -0,0 +1,47 @@
+"use client"
+
+import { Toaster as Sonner, type ToasterProps } from "sonner"
+import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"
+
+const Toaster = ({ ...props }: ToasterProps) => {
+  // The site is light only, so the toasts are too.
+  return (
+    <Sonner
+      theme="light"
+      className="toaster group"
+      icons={{
+        success: (
+          <CircleCheckIcon className="size-4" />
+        ),
+        info: (
+          <InfoIcon className="size-4" />
+        ),
+        warning: (
+          <TriangleAlertIcon className="size-4" />
+        ),
+        error: (
+          <OctagonXIcon className="size-4" />
+        ),
+        loading: (
+          <Loader2Icon className="size-4 animate-spin" />
+        ),
+      }}
+      style={
+        {
+          "--normal-bg": "var(--popover)",
+          "--normal-text": "var(--popover-foreground)",
+          "--normal-border": "var(--border)",
+          "--border-radius": "var(--radius)",
+        } as React.CSSProperties
+      }
+      toastOptions={{
+        classNames: {
+          toast: "cn-toast",
+        },
+      }}
+      {...props}
+    />
+  )
+}
+
+export { Toaster }
```

- [ ] **Step 3: The theme, the layout and the site's header and footer**

`apps/web/app/globals.css` keeps shadcn's generated `@theme` and `.dark` blocks as they are. Replace its `:root` block, and add the dotted-grid utility at the end:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@custom-variant dark (&:is(.dark *));

@theme inline {
    --font-heading: var(--font-sans);
    --font-sans: var(--font-sans);
    --color-sidebar-ring: var(--sidebar-ring);
    --color-sidebar-border: var(--sidebar-border);
    --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
    --color-sidebar-accent: var(--sidebar-accent);
    --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
    --color-sidebar-primary: var(--sidebar-primary);
    --color-sidebar-foreground: var(--sidebar-foreground);
    --color-sidebar: var(--sidebar);
    --color-chart-5: var(--chart-5);
    --color-chart-4: var(--chart-4);
    --color-chart-3: var(--chart-3);
    --color-chart-2: var(--chart-2);
    --color-chart-1: var(--chart-1);
    --color-ring: var(--ring);
    --color-input: var(--input);
    --color-border: var(--border);
    --color-destructive: var(--destructive);
    --color-accent-foreground: var(--accent-foreground);
    --color-accent: var(--accent);
    --color-muted-foreground: var(--muted-foreground);
    --color-muted: var(--muted);
    --color-secondary-foreground: var(--secondary-foreground);
    --color-secondary: var(--secondary);
    --color-primary-foreground: var(--primary-foreground);
    --color-primary: var(--primary);
    --color-popover-foreground: var(--popover-foreground);
    --color-popover: var(--popover);
    --color-card-foreground: var(--card-foreground);
    --color-card: var(--card);
    --color-foreground: var(--foreground);
    --color-background: var(--background);
    --radius-sm: calc(var(--radius) * 0.6);
    --radius-md: calc(var(--radius) * 0.8);
    --radius-lg: var(--radius);
    --radius-xl: calc(var(--radius) * 1.4);
    --radius-2xl: calc(var(--radius) * 1.8);
    --radius-3xl: calc(var(--radius) * 2.2);
    --radius-4xl: calc(var(--radius) * 2.6);
}

:root {
    /* Calm and trustworthy: white, soft green-grey neutrals, one green accent. */
    --background: oklch(1 0 0);
    --foreground: oklch(0.2 0.012 160);
    --card: oklch(1 0 0);
    --card-foreground: oklch(0.2 0.012 160);
    --popover: oklch(1 0 0);
    --popover-foreground: oklch(0.2 0.012 160);
    --primary: oklch(0.53 0.13 155);
    --primary-foreground: oklch(0.99 0 0);
    --secondary: oklch(0.97 0.006 155);
    --secondary-foreground: oklch(0.26 0.02 160);
    --muted: oklch(0.975 0.004 155);
    --muted-foreground: oklch(0.52 0.014 160);
    --accent: oklch(0.965 0.02 155);
    --accent-foreground: oklch(0.38 0.09 155);
    --destructive: oklch(0.577 0.245 27.325);
    --border: oklch(0.925 0.006 155);
    --input: oklch(0.925 0.006 155);
    --ring: oklch(0.72 0.1 155);
    --chart-1: oklch(0.6 0.14 155);
    --chart-2: oklch(0.42 0.015 160);
    --chart-3: oklch(0.75 0.1 155);
    --chart-4: oklch(0.6 0.01 160);
    --chart-5: oklch(0.85 0.05 155);
    --radius: 0.75rem;
    --sidebar: oklch(0.985 0.003 155);
    --sidebar-foreground: oklch(0.2 0.012 160);
    --sidebar-primary: oklch(0.53 0.13 155);
    --sidebar-primary-foreground: oklch(0.99 0 0);
    --sidebar-accent: oklch(0.965 0.02 155);
    --sidebar-accent-foreground: oklch(0.38 0.09 155);
    --sidebar-border: oklch(0.925 0.006 155);
    --sidebar-ring: oklch(0.72 0.1 155);
}

.dark {
    --background: oklch(0.145 0 0);
    --foreground: oklch(0.985 0 0);
    --card: oklch(0.205 0 0);
    --card-foreground: oklch(0.985 0 0);
    --popover: oklch(0.205 0 0);
    --popover-foreground: oklch(0.985 0 0);
    --primary: oklch(0.922 0 0);
    --primary-foreground: oklch(0.205 0 0);
    --secondary: oklch(0.269 0 0);
    --secondary-foreground: oklch(0.985 0 0);
    --muted: oklch(0.269 0 0);
    --muted-foreground: oklch(0.708 0 0);
    --accent: oklch(0.269 0 0);
    --accent-foreground: oklch(0.985 0 0);
    --destructive: oklch(0.704 0.191 22.216);
    --border: oklch(1 0 0 / 10%);
    --input: oklch(1 0 0 / 15%);
    --ring: oklch(0.556 0 0);
    --chart-1: oklch(0.87 0 0);
    --chart-2: oklch(0.556 0 0);
    --chart-3: oklch(0.439 0 0);
    --chart-4: oklch(0.371 0 0);
    --chart-5: oklch(0.269 0 0);
    --sidebar: oklch(0.205 0 0);
    --sidebar-foreground: oklch(0.985 0 0);
    --sidebar-primary: oklch(0.488 0.243 264.376);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --sidebar-accent: oklch(0.269 0 0);
    --sidebar-accent-foreground: oklch(0.985 0 0);
    --sidebar-border: oklch(1 0 0 / 10%);
    --sidebar-ring: oklch(0.556 0 0);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
    }
  body {
    @apply bg-background text-foreground;
    }
  html {
    @apply font-sans;
    }
}
@layer utilities {
  /* A faint dotted grid that fades out, behind the landing page's hero. */
  .bg-dots {
    background-image: radial-gradient(color-mix(in oklch, var(--foreground) 9%, transparent) 1px, transparent 1px);
    background-size: 22px 22px;
    mask-image: radial-gradient(ellipse 70% 60% at 50% 0%, black 30%, transparent 75%);
  }
}
```

```tsx
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SiteFooter, SiteHeader } from "./ui/chrome";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Upstream",
  description: "Your AI coding agent pays back the open source it builds with.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#ffffff" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans antialiased", sans.variable, mono.variable)}>
      <body className="min-h-dvh">
        <TooltipProvider>
          <SiteHeader />
          {children}
          <SiteFooter />
        </TooltipProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
```

```tsx
import { ArrowUpRight, Sprout } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { demoEnabled } from "@/lib/demo/accounts";

export const REPO_URL = "https://github.com/iamarunbrahma/upstream";

/** The site's mark: a small green tile with a sprout. */
export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
      <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm shadow-primary/30">
        <Sprout className="size-4" />
      </span>
      Upstream
    </Link>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
        <Logo />
        <nav aria-label="Main" className="flex items-center gap-1 text-sm">
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/#how">How it works</Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/maintainer">Maintainers</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard">Dashboard</Link>
          </Button>
          {demoEnabled() && (
            <form method="post" action="/demo/start" className="ml-1">
              <Button type="submit" size="sm">
                Try the demo
              </Button>
            </form>
          )}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-10 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>An entry in the PayPal AI Hackathon. It all runs on the PayPal sandbox, so no real money moves.</p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Link href="/maintainer" className="font-medium text-foreground hover:text-primary">
            For maintainers
          </Link>
          <a href={REPO_URL} className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary">
            Source on GitHub, MIT license <ArrowUpRight className="size-3.5" />
          </a>
        </div>
      </div>
    </footer>
  );
}
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm --filter web build`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "Add Tailwind and shadcn/ui, with a calm green theme and the site frame"
```

### Task 8: The landing page and the index chart

**Files:**
- Rewrite: `apps/web/app/page.tsx`
- Create: `apps/web/app/ui/UsageChart.tsx`

**Interfaces:**
- Consumes: Task 6's `indexRows` and `usage.json`; Task 1's `demoEnabled`.

- [ ] **Step 1: The chart**

```tsx
"use client";

import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import type { IndexRow } from "@/lib/index/usage";

const config = {
  work: { label: "Share of agent work", color: "var(--chart-2)" },
  money: { label: "Share of money set aside", color: "var(--chart-1)" },
} satisfies ChartConfig;

/** The "Agent Usage vs Funding" chart: per package, its share of agent work against its share of the money. */
export function UsageChart(props: { rows: IndexRow[] }) {
  const data = props.rows.map((r) => ({ name: r.name, work: r.usageBp / 100, money: r.fundingBp / 100 }));
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height: Math.max(220, data.length * 52 + 60) }}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 44 }} barGap={4} barCategoryGap={16}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
        <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} />
        <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={104} tick={{ fontSize: 13 }} />
        <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent formatter={(value, name) => `${config[name as keyof typeof config].label}: ${Number(value).toFixed(1)}%`} />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="work" fill="var(--color-work)" radius={[0, 6, 6, 0]} barSize={12}>
          <LabelList dataKey="work" position="right" className="fill-muted-foreground" fontSize={11} formatter={(v: unknown) => `${Number(v).toFixed(1)}%`} />
        </Bar>
        <Bar dataKey="money" fill="var(--color-money)" radius={[0, 6, 6, 0]} barSize={12}>
          <LabelList dataKey="money" position="right" className="fill-muted-foreground" fontSize={11} formatter={(v: unknown) => `${Number(v).toFixed(1)}%`} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
```

- [ ] **Step 2: The page**

```tsx
import { ArrowRight, BadgeCheck, CircleCheck, Code, HandCoins, Plug, ReceiptText, Scale, ShieldCheck, Sparkles, Terminal, Wallet } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { demoEnabled } from "@/lib/demo/accounts";
import { getDeps } from "@/lib/deps";
import { formatUsd } from "@/lib/format";
import { indexRows, type UsageIndex } from "@/lib/index/usage";
import usage from "@/lib/index/usage.json" with { type: "json" };
import { UsageChart } from "./ui/UsageChart";

export const dynamic = "force-dynamic";

const FLOW = [
  { icon: Terminal, title: "Your agent codes", body: "A Claude Code session installs and imports packages." },
  { icon: Sparkles, title: "AI weighs the work", body: "Gemini judges how much each package mattered." },
  { icon: HandCoins, title: "Maintainers get paid", body: "Your budget goes out through PayPal Payouts." },
];

const STEPS = [
  { icon: Plug, title: "Install once", body: "A Claude Code plugin links your machine to your Upstream account." },
  { icon: Wallet, title: "Set a budget", body: "Give $5, $15 or $50 a month with PayPal, or add money once." },
  { icon: Code, title: "Code as usual", body: "When a session ends, the plugin writes a receipt on your machine. Only package names and counts leave it, never your code." },
  { icon: Scale, title: "AI weighs the work", body: "Gemini judges how much the session depended on each package, inside fixed limits it can't break." },
  { icon: ReceiptText, title: "You approve", body: "Approve the receipt in your agent or here, or let a rule approve it while you have money in your budget." },
  { icon: HandCoins, title: "Maintainers get paid", body: "Your budget is split across your receipts and each package's maintainers, to the cent, and paid through PayPal." },
];

const SAFEGUARDS = [
  "No payout ever goes to a developer's own PayPal account.",
  "At most $100 a month from one developer to one maintainer.",
  "A new maintainer's first payout waits a week.",
  "Money nobody claims in 90 days goes back to the developer's budget.",
  "Money follows the GitHub account, so a renamed or reused username can't redirect it.",
];

export default async function Home() {
  const deps = await getDeps();
  const index = await indexRows(deps.db, usage as UsageIndex);
  const demo = demoEnabled();
  return (
    <main>
      <section className="relative overflow-hidden">
        <div aria-hidden className="bg-dots absolute inset-0 -z-10" />
        <div aria-hidden className="absolute inset-x-0 -top-40 -z-10 mx-auto h-80 max-w-3xl rounded-full bg-primary/15 blur-3xl" />
        <div className="mx-auto max-w-6xl px-4 pt-20 pb-6 text-center sm:pt-28">
          <Badge variant="outline" className="mb-6 gap-1.5 rounded-full bg-background/80 px-3 py-1 text-xs font-medium backdrop-blur">
            <span className="size-1.5 rounded-full bg-primary" /> PayPal AI Hackathon · runs on the PayPal sandbox
          </Badge>
          <h1 className="mx-auto max-w-4xl text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
            Your AI coding agent <span className="bg-gradient-to-r from-primary to-emerald-500 bg-clip-text text-transparent">pays back</span> the open
            source it builds with.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-pretty text-muted-foreground">
            Agents install, import and read open-source packages all day, but they never sponsor anyone. In January 2026, Tailwind Labs laid off 75% of
            its engineers after AI tools sent people around the docs that used to sell its paid product.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            {demo && (
              <form method="post" action="/demo/start">
                <Button type="submit" size="lg" className="h-11 px-6 text-base shadow-md shadow-primary/25">
                  Try the demo <ArrowRight />
                </Button>
              </form>
            )}
            <Button asChild variant="outline" size="lg" className="h-11 px-6 text-base">
              <Link href="#how">How it works</Link>
            </Button>
          </div>
          <p className="mt-5 flex flex-wrap items-center justify-center gap-1.5 text-sm text-muted-foreground">
            Or install it in Claude Code: <code className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground">npx upstream-pay init</code>
          </p>

          <div className="mx-auto mt-16 grid max-w-4xl gap-3 sm:grid-cols-3">
            {FLOW.map((f, i) => (
              <div key={f.title} className="relative rounded-2xl border bg-card/80 p-5 text-left shadow-sm backdrop-blur">
                <div className="mb-3 flex items-center justify-between">
                  <span className="grid size-9 place-items-center rounded-xl bg-accent text-accent-foreground">
                    <f.icon className="size-4.5" />
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">0{i + 1}</span>
                </div>
                <div className="font-medium">{f.title}</div>
                <div className="mt-1 text-sm text-muted-foreground">{f.body}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="index" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-12">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl font-semibold">Agent usage vs funding</CardTitle>
            <CardDescription className="max-w-2xl text-sm">
              The packages that did the most work in real Claude Code sessions, set against their share of the money Upstream has set aside so far.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <UsageChart rows={index.rows} />
          </CardContent>
          <CardFooter className="border-t text-xs text-muted-foreground">
            Agent work: each package&apos;s average share of the work across {index.sessions} real Claude Code sessions, scored from what the agent installed,
            imported and wrote. Money: {formatUsd(index.fundedCents)} set aside on this sandbox so far.
          </CardFooter>
        </Card>
      </section>

      <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-24">
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight">How it works</h2>
          <p className="mt-3 text-muted-foreground">You stay in charge of every dollar. The agent can only propose a payment.</p>
        </div>
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <Card className="h-full shadow-sm transition-shadow hover:shadow-md">
                <CardHeader>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground">
                      <s.icon className="size-5" />
                    </span>
                    <Badge variant="secondary" className="font-mono">
                      Step {i + 1}
                    </Badge>
                  </div>
                  <CardTitle className="text-base font-semibold">{s.title}</CardTitle>
                  <CardDescription className="leading-relaxed">{s.body}</CardDescription>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-4 pt-16 lg:grid-cols-5">
        <Card className="shadow-sm lg:col-span-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl font-semibold">
              <ShieldCheck className="size-5 text-primary" /> Safeguards built in
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3 text-sm">
              {SAFEGUARDS.map((s) => (
                <li key={s} className="flex gap-3">
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                  {s}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card className="relative overflow-hidden border-primary/20 bg-gradient-to-br from-accent to-background shadow-sm lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl font-semibold">
              <BadgeCheck className="size-5 text-primary" /> Maintain open source?
            </CardTitle>
            <CardDescription className="leading-relaxed">
              Sign in with GitHub to see what developers&apos; agents have set aside for you, then link PayPal to be paid. There&apos;s nothing else to do.
            </CardDescription>
          </CardHeader>
          <CardFooter className="mt-auto bg-transparent">
            <Button asChild>
              <Link href="/maintainer">
                Get paid for your packages <ArrowRight />
              </Link>
            </Button>
          </CardFooter>
        </Card>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm --filter web build`, then `DEMO_MODE=1 pnpm --filter web dev` and open `/` at 1512 px and at 390 px.
Expected:
- the hero, with "Try the demo" and the three-step flow
- the chart, with two labelled bars per package and its caption
- six step cards, the safeguards, and the maintainers card
- `document.documentElement.scrollWidth` equals the window width at 390 px

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "Build the landing page around the Agent Usage vs Funding chart"
```

### Task 9: The dashboard

**Files:**
- Rewrite: `apps/web/app/dashboard/page.tsx`, `apps/web/app/dashboard/FundingPanel.tsx`
- Create: `apps/web/app/dashboard/api.ts`, `Dashboard.tsx`, `DemoGuide.tsx`, `Receipts.tsx`, `Money.tsx`

**Interfaces:**
- Consumes:
  - Task 1's `demo` on `/api/me`
  - Task 3's `POST /api/demo/settle`
  - Task 4's `projection` and `given`
  - Task 5's `POST /api/demo/sample-session`
  - Plan 1's `GET /api/receipts` and `POST /api/receipts/:id/decision`
  - Plan 2a's PayPal routes
- Produces: `DashboardTab = "receipts" | "money" | "fund"`, which `DemoGuide` uses to switch tabs.

- [ ] **Step 1: The API helper and the shell**

```ts
import type { ReceiptView } from "@upstream/core";
import type { GivenLine, ProjectedShare } from "../../lib/funding/view";

/** What GET /api/me answers. */
export interface Me {
  balanceCents: number;
  givenCents: number;
  subscription: { id: string; tier: string; status: string } | null;
  autoApprove: boolean;
  receipts: { proposed: number; approved: number; skipped: number };
  paymentsReady: boolean;
  demo: boolean;
  projection: ProjectedShare[];
  given: GivenLine[];
}

export type { ReceiptView };

/** A same-site JSON call to this server. Throws with the server's own words when it says no. */
export async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Something went wrong (${res.status})`);
  return data;
}
```

```tsx
import type { Metadata } from "next";
import { TIERS } from "@/lib/paypal/plans";
import { Dashboard } from "./Dashboard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your Upstream dashboard" };

export default function DashboardPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 pt-10 sm:pt-14">
      <Dashboard
        clientId={process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? ""}
        environment={process.env.NEXT_PUBLIC_PAYPAL_ENV === "production" ? "production" : "sandbox"}
        tiers={TIERS.map((t) => ({ key: t.key, label: t.label }))}
      />
    </main>
  );
}
```

```tsx
"use client";

import { HandCoins, ReceiptText, Wallet } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatUsd } from "@/lib/format";
import { call, type Me, type ReceiptView } from "./api";
import { DemoGuide } from "./DemoGuide";
import { FundingPanel } from "./FundingPanel";
import { Given, Projection } from "./Money";
import { Receipts } from "./Receipts";

/** While a payout is on its way, check every 5 seconds for 3 minutes; PayPal's webhook updates it on the server. */
const POLL_MS = 5_000;
const POLL_TRIES = 36;

export type DashboardTab = "receipts" | "money" | "fund";

function Stat(props: { icon: typeof Wallet; label: string; value: string; note: string; accent?: boolean }) {
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardDescription className="font-medium">{props.label}</CardDescription>
        <CardAction>
          <span className="grid size-8 place-items-center rounded-lg bg-accent text-accent-foreground">
            <props.icon className="size-4" />
          </span>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className={`text-3xl font-semibold tracking-tight tabular-nums ${props.accent ? "text-primary" : ""}`}>{props.value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{props.note}</p>
      </CardContent>
    </Card>
  );
}

export function Dashboard(props: { clientId: string; environment: "sandbox" | "production"; tiers: { key: string; label: string }[] }) {
  const [me, setMe] = useState<Me | null>(null);
  const [receipts, setReceipts] = useState<ReceiptView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [polls, setPolls] = useState(0);
  const [tab, setTab] = useState<DashboardTab>("receipts");

  const refresh = useCallback(async () => {
    try {
      const [next, list] = await Promise.all([call<Me>("GET", "/api/me"), call<{ receipts: ReceiptView[] }>("GET", "/api/receipts?limit=20")]);
      setMe(next);
      setReceipts(list.receipts);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onItsWay = me?.given.some((g) => g.state === "on-its-way") ?? false;
  useEffect(() => {
    if (!onItsWay || polls >= POLL_TRIES) return;
    const t = setTimeout(() => {
      setPolls((n) => n + 1);
      void refresh();
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [onItsWay, polls, refresh]);
  const changed = useCallback(async () => {
    setPolls(0);
    await refresh();
  }, [refresh]);

  if (!me && error) {
    return (
      <Card className="mx-auto max-w-lg text-center shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">{error}</CardTitle>
          <CardDescription>
            Open your dashboard from the terminal with <code className="font-mono">upstream dashboard</code>, or{" "}
            <Link href="/" className="font-medium text-primary underline-offset-4 hover:underline">
              try the demo
            </Link>
            .
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!me) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-10 w-72" />
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const waiting = receipts.filter((r) => r.status === "proposed").length;
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Your budget</h1>
          <p className="mt-1 text-muted-foreground">What your agents used, what you approved, and where the money went.</p>
        </div>
        {me.demo && (
          <Badge variant="outline" className="gap-1.5 rounded-full px-3 py-1">
            <span className="size-1.5 rounded-full bg-primary" /> Sandbox demo account
          </Badge>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat icon={Wallet} label="In your budget" value={formatUsd(me.balanceCents)} note="Spent at the next settlement" />
        <Stat icon={HandCoins} label="Set aside for maintainers" value={formatUsd(me.givenCents)} note="Paid out, on its way, or waiting for them" accent />
        <Stat icon={ReceiptText} label="Receipts waiting for you" value={String(waiting)} note={`${me.receipts.approved} approved so far`} />
      </div>

      {me.demo && <DemoGuide me={me} receipts={receipts} onChange={changed} onShow={setTab} />}

      <Tabs value={tab} onValueChange={(v) => setTab(v as DashboardTab)}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="receipts">
              Receipts
              {waiting > 0 && (
                <Badge className="ml-1 h-5 min-w-5 rounded-full px-1.5 text-[11px]" aria-label={`${waiting} waiting`}>
                  {waiting}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="money">Where the money goes</TabsTrigger>
            <TabsTrigger value="fund">Add money</TabsTrigger>
          </TabsList>
          <label className="flex items-center gap-2.5 text-sm text-muted-foreground">
            <Switch
              checked={me.autoApprove}
              onCheckedChange={async (checked) => {
                await call("PATCH", "/api/settings", { autoApprove: checked });
                await refresh();
              }}
            />
            Approve automatically while I have money
          </label>
        </div>
        <TabsContent value="receipts" className="mt-4">
          <Receipts receipts={receipts} onChange={changed} />
        </TabsContent>
        <TabsContent value="money" className="mt-4 grid gap-4">
          <Projection shares={me.projection} />
          <Given lines={me.given} />
          {me.projection.length === 0 && me.given.length === 0 && (
            <Card className="shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Nothing here yet</CardTitle>
                <CardDescription>Approve a receipt and add money, and you&apos;ll see how your budget would be split, then where it went.</CardDescription>
              </CardHeader>
            </Card>
          )}
        </TabsContent>
        {/* Kept mounted, so a PayPal payment in progress survives switching tabs. */}
        <TabsContent value="fund" forceMount className="mt-4 data-[state=inactive]:hidden">
          <FundingPanel me={me} refresh={refresh} clientId={props.clientId} environment={props.environment} tiers={props.tiers} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

- [ ] **Step 2: The demo stepper**

```tsx
"use client";

import { Check, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { call, type Me, type ReceiptView } from "./api";
import type { DashboardTab } from "./Dashboard";

interface Step {
  done: boolean;
  title: string;
  body: string;
  action: React.ReactNode;
  /** Shown even once done: settling again after adding more money is part of the demo. */
  always?: boolean;
}

/** The sandbox demo in four steps, each with its own button, ticked off as the account moves along. */
export function DemoGuide(props: { me: Me; receipts: ReceiptView[]; onChange: () => Promise<void>; onShow: (tab: DashboardTab) => void }) {
  const { me } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const sample = props.receipts.find((r) => r.sessionId.startsWith("sample:"));

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try {
      await fn();
      await props.onChange();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const spinner = (name: string) => busy === name && <Loader2 className="animate-spin" />;

  const steps: Step[] = [
    {
      done: me.balanceCents > 0 || me.givenCents > 0,
      title: "Add money with PayPal",
      body: "Pick a monthly budget or add money once. Sign in with the sandbox PayPal login from the testing notes.",
      action: (
        <Button variant="outline" size="sm" onClick={() => props.onShow("fund")}>
          Open PayPal
        </Button>
      ),
    },
    {
      done: Boolean(sample),
      title: "Run a sample session",
      body: "A recorded Claude Code session goes through the real pipeline: package lookups, then the Gemini judge.",
      action: (
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() =>
            void run("sample", async () => {
              await call("POST", "/api/demo/sample-session");
              props.onShow("receipts");
              toast.success("The receipt is ready. Read why each package got its share.");
            })
          }
        >
          {spinner("sample")}
          {busy === "sample" ? "The AI is weighing it" : "Run a sample session"}
        </Button>
      ),
    },
    {
      done: sample?.status === "approved",
      title: "Approve its receipt",
      body: "Check the AI's reasons for each package below, then approve the receipt.",
      action: sample?.status === "proposed" && (
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => void run("approve", () => call("POST", `/api/receipts/${sample.id}/decision`, { action: "approve" }).then(() => undefined))}
        >
          {spinner("approve")}
          Approve it
        </Button>
      ),
    },
    {
      done: me.givenCents > 0,
      always: true,
      title: "Settle now",
      body: "Splits your budget across each package's maintainers and sends PayPal Payouts to the ones who have joined. In this demo, payouts go out at any amount; the real service waits until someone is owed $1.",
      action: (
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() =>
            void run("settle", async () => {
              const { summary } = await call<{ summary: string[] }>("POST", "/api/demo/settle");
              props.onShow("money");
              toast.success("Settled", { description: summary.join(" ") });
            })
          }
        >
          {spinner("settle")}
          Settle now
        </Button>
      ),
    },
  ];
  const done = steps.filter((s) => s.done).length;

  return (
    <Card className="border-primary/20 bg-gradient-to-b from-accent/60 to-background shadow-sm">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-lg font-semibold">Try the whole flow in four steps</CardTitle>
            <CardDescription>Your own demo account. Nothing here is real money: it all runs on the PayPal sandbox.</CardDescription>
          </div>
          <div className="flex min-w-40 items-center gap-3 text-sm text-muted-foreground">
            <Progress value={(done / steps.length) * 100} className="h-2" aria-label={`${done} of ${steps.length} steps done`} />
            <span className="tabular-nums">
              {done}/{steps.length}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-3 md:grid-cols-2">
          {steps.map((s, i) => (
            <li key={s.title} className={cn("flex gap-3 rounded-xl border bg-background/80 p-4", s.done && "border-primary/25")}>
              <span
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold",
                  s.done ? "border-primary bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                )}
                aria-hidden
              >
                {s.done ? <Check className="size-3.5" /> : i + 1}
              </span>
              <div className="grid flex-1 content-start gap-1.5">
                <div className="font-medium">
                  {s.title}
                  {s.done && <span className="sr-only"> (done)</span>}
                </div>
                <p className="text-sm text-muted-foreground">{s.body}</p>
                {(!s.done || s.always) && s.action && <div className="pt-1">{s.action}</div>}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Receipts**

```tsx
"use client";

import { Bot, Check, Loader2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { call, type ReceiptView } from "./api";

const ROLE: Record<string, string> = {
  foundation: "Built on it",
  feature: "One feature",
  helper: "A helper",
  tooling: "A tool",
};

const STATUS: Record<string, { label: string; variant: "default" | "secondary" | "outline" }> = {
  proposed: { label: "Waiting for you", variant: "default" },
  approved: { label: "Approved", variant: "secondary" },
  skipped: { label: "Skipped", variant: "outline" },
  expired: { label: "Dropped after 14 days", variant: "outline" },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What the agent did with a package, from the evidence counted on the developer's machine. */
function evidenceText(e: ReceiptView["items"][number]["evidence"]): string {
  const parts: string[] = [];
  if (e.installed) parts.push("installed");
  if (e.manifestAdded) parts.push("added to the project");
  if (e.importFiles) parts.push(`imported in ${plural(e.importFiles, "file")}`);
  if (e.usageLines) parts.push(`${plural(e.usageLines, "line")} of new code ${e.usageLines === 1 ? "uses" : "use"} it`);
  if (e.docsReads) parts.push(`docs read ${plural(e.docsReads, "time")}`);
  if (e.kind === "devDependency") parts.push("a dev tool");
  const text = parts.join(", ") || "used this session";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function ReceiptCard(props: { receipt: ReceiptView; onChange: () => Promise<void> }) {
  const r = props.receipt;
  const [busy, setBusy] = useState<"approve" | "skip" | null>(null);
  const status = STATUS[r.status] ?? { label: r.status, variant: "outline" as const };

  async function decide(action: "approve" | "skip") {
    setBusy(action);
    try {
      await call("POST", `/api/receipts/${r.id}/decision`, { action });
      await props.onChange();
      toast.success(action === "approve" ? "Approved. The next settlement spends your budget on these packages." : "Skipped. Nothing from this session will be paid.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-base font-semibold">{r.title ?? "A Claude Code session"}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{new Date(r.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <Bot className="size-3.5" />
            {r.source === "ai" ? `Weighed by ${r.modelId ?? "the AI judge"}` : "Estimated without AI (the judge was unavailable)"}
          </span>
          <span aria-hidden>·</span>
          <span className="font-mono text-xs">{r.promptVersion}</span>
        </CardDescription>
        <CardAction>
          <Badge variant={status.variant}>{status.label}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Package</TableHead>
              <TableHead className="w-40">Share</TableHead>
              <TableHead className="hidden md:table-cell">Why</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.items.map((i) => (
              <TableRow key={`${i.ecosystem}:${i.name}`} className="align-top">
                <TableCell className="py-3">
                  <div className="font-medium">{i.name}</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <Badge variant="outline" className="font-normal">
                      {ROLE[i.role] ?? i.role}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{i.ecosystem}</span>
                  </div>
                  <p className="mt-2 max-w-xs text-xs whitespace-normal text-muted-foreground md:hidden">{i.reason}</p>
                </TableCell>
                <TableCell className="py-3">
                  <div className="flex items-center gap-2">
                    <span className="w-12 text-right font-semibold tabular-nums">{i.percent}</span>
                    <Progress value={i.weightBp / 100} className="h-1.5" />
                  </div>
                </TableCell>
                <TableCell className="hidden py-3 whitespace-normal md:table-cell">
                  <div>{i.reason}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{evidenceText(i.evidence)}.</div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      {r.status === "proposed" && (
        <CardFooter className="flex-wrap gap-3 border-t">
          <Button disabled={busy !== null} onClick={() => void decide("approve")}>
            {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />} Approve
          </Button>
          <Button variant="outline" disabled={busy !== null} onClick={() => void decide("skip")}>
            {busy === "skip" ? <Loader2 className="animate-spin" /> : <X />} Skip
          </Button>
          <span className="text-xs text-muted-foreground">Approving lets the next settlement spend your budget on these packages.</span>
        </CardFooter>
      )}
    </Card>
  );
}

export function Receipts(props: { receipts: ReceiptView[]; onChange: () => Promise<void> }) {
  if (props.receipts.length === 0) {
    return (
      <Card className="border-dashed shadow-none">
        <CardHeader className="text-center">
          <CardTitle className="text-base">No receipts yet</CardTitle>
          <CardDescription>
            They arrive when a Claude Code session with the Upstream plugin ends, or from <code className="font-mono">upstream scan</code>.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <div className="grid gap-4">
      {props.receipts.map((r) => (
        <ReceiptCard key={r.id} receipt={r} onChange={props.onChange} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Where the money goes**

```tsx
"use client";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatUsd } from "@/lib/format";
import type { GivenLine, GivenState, ProjectedShare } from "@/lib/funding/view";

/** Where one maintainer's share is now, in a few words. */
const STATE: Record<GivenState, { label: string; variant: "default" | "secondary" | "outline" }> = {
  waiting: { label: "Not joined yet", variant: "outline" },
  held: { label: "Joined, paid next payout", variant: "secondary" },
  "on-its-way": { label: "On its way via PayPal", variant: "default" },
  paid: { label: "Paid via PayPal", variant: "default" },
  returned: { label: "Back in your budget", variant: "outline" },
};

function GithubAvatar(props: { login: string; size: string }) {
  return (
    <Avatar className={props.size}>
      <AvatarImage src={`https://github.com/${props.login}.png?size=64`} alt="" />
      <AvatarFallback className="text-[10px]">{props.login.slice(0, 2).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

/** "If we settled today": the whole budget split by the approved receipts, per package. */
export function Projection(props: { shares: ProjectedShare[] }) {
  if (props.shares.length === 0) return null;
  const max = Math.max(...props.shares.map((s) => s.cents));
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-base font-semibold">If we settled today</CardTitle>
        <CardDescription>Your whole budget, split by the receipts you approved. Each package&apos;s share then goes to its maintainers.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {props.shares.map((s) => (
          <div key={`${s.ecosystem}:${s.name}`} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm">
            <span className="truncate font-medium">{s.name}</span>
            <Progress value={(s.cents / max) * 100} className="h-2" />
            <span className="w-16 text-right tabular-nums">{formatUsd(s.cents)}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** "Where your money went": what settlements set aside, per package and maintainer, and where each share is now. */
export function Given(props: { lines: GivenLine[] }) {
  if (props.lines.length === 0) return null;
  const packages = new Map<string, { name: string; cents: number; lines: GivenLine[] }>();
  for (const l of props.lines) {
    const key = `${l.ecosystem}:${l.name}`;
    const p = packages.get(key) ?? { name: l.name, cents: 0, lines: [] };
    p.cents += l.cents;
    p.lines.push(l);
    packages.set(key, p);
  }
  const people = new Set(props.lines.map((l) => l.login)).size;
  const waiting = props.lines.filter((l) => l.state === "waiting").reduce((sum, l) => sum + l.cents, 0);
  const sorted = [...packages.values()].sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-base font-semibold">Where your money went</CardTitle>
        <CardDescription>
          Split across {people} maintainers of {packages.size} packages.
          {waiting > 0 && ` ${formatUsd(waiting)} waits for maintainers who haven't joined Upstream yet. If nobody claims it in 90 days, it comes back to your budget.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Accordion type="multiple">
          {sorted.map((p) => {
            const paid = p.lines.filter((l) => l.state === "paid" || l.state === "on-its-way").length;
            return (
              <AccordionItem key={p.name} value={p.name}>
                <AccordionTrigger className="items-center hover:no-underline">
                  <span className="flex flex-1 items-center gap-3 pr-2">
                    <span className="font-medium">{p.name}</span>
                    <span className="flex -space-x-2">
                      {p.lines.slice(0, 4).map((l) => (
                        <span key={l.login} className="rounded-full ring-2 ring-background">
                          <GithubAvatar login={l.login} size="size-6" />
                        </span>
                      ))}
                    </span>
                    <span className="hidden text-xs font-normal text-muted-foreground sm:inline">
                      {p.lines.length === 1 ? "1 maintainer" : `${p.lines.length} maintainers`}
                    </span>
                    {paid > 0 && <Badge className="text-[11px]">{paid} paid</Badge>}
                    <span className="ml-auto font-semibold tabular-nums">{formatUsd(p.cents)}</span>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <ul className="grid gap-2.5">
                    {p.lines.map((l) => (
                      <li key={`${l.login}:${l.state}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <GithubAvatar login={l.login} size="size-7" />
                        <a href={`https://github.com/${l.login}`} className="font-medium hover:text-primary hover:underline">
                          @{l.login}
                        </a>
                        <Badge variant={STATE[l.state].variant} className="font-normal">
                          {STATE[l.state].label}
                        </Badge>
                        <span className="ml-auto tabular-nums">{formatUsd(l.cents)}</span>
                      </li>
                    ))}
                  </ul>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Adding money**

```tsx
"use client";

import { PayPalOneTimePaymentButton, PayPalProvider, PayPalSubscriptionButton } from "@paypal/react-paypal-js/sdk-v6";
import { CircleAlert, CircleCheck, Clock, Repeat, Wallet } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatUsd } from "@/lib/format";
import { call, type Me } from "./api";
import { recordPayment } from "./record-payment";

export function FundingPanel(props: {
  me: Me;
  refresh: () => Promise<void>;
  clientId: string;
  environment: "sandbox" | "production";
  tiers: { key: string; label: string }[];
}) {
  const { me, refresh } = props;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [topupCents, setTopupCents] = useState(1000);
  const [pending, setPending] = useState<{ message: string; retry: () => void } | null>(null);

  /** Records a payment PayPal has approved. If that can't finish yet, offers "Check again", which repeats it safely. */
  async function settle(record: () => Promise<{ credited: number }>, tries: number, notYet: string): Promise<void> {
    setError(null);
    setPending(null);
    setNotice("Recording your payment...");
    const r = await recordPayment(
      async () => {
        const answer = await record();
        await refresh();
        return answer;
      },
      { tries, waitMs: 10_000 },
    );
    if (r && r.credited > 0) {
      setNotice(`Thanks. ${formatUsd(r.credited)} was added to your budget.`);
      return;
    }
    setNotice(null);
    setPending({ message: r ? notYet : "PayPal has your payment, but we couldn't record it yet.", retry: () => void settle(record, 1, notYet) });
  }

  const activeTier = me.subscription?.status === "ACTIVE" ? props.tiers.find((t) => t.key === me.subscription!.tier) : undefined;

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-base font-semibold">Add money to your budget</CardTitle>
        <CardDescription>Pay with PayPal. On the demo, sign in with the sandbox PayPal login from the testing notes.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {notice && (
          <Alert>
            <CircleCheck />
            <AlertDescription role="status">{notice}</AlertDescription>
          </Alert>
        )}
        {pending && (
          <Alert>
            <Clock />
            <AlertDescription role="status" className="flex flex-wrap items-center gap-3">
              {pending.message}
              <Button size="sm" variant="outline" onClick={pending.retry}>
                Check again
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription role="alert">{error}</AlertDescription>
          </Alert>
        )}

        {!me.paymentsReady ? (
          <p className="text-sm text-muted-foreground">Payments aren&apos;t set up on this server yet.</p>
        ) : (
          <PayPalProvider clientId={props.clientId} environment={props.environment} components={["paypal-payments", "paypal-subscriptions"]} pageType="checkout">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border p-4">
                <div className="mb-3 flex items-center gap-2 font-medium">
                  <Repeat className="size-4 text-primary" /> Every month
                </div>
                {activeTier ? (
                  <p className="text-sm">
                    You give <strong>{activeTier.label}</strong>. Thank you.
                  </p>
                ) : (
                  <div className="grid gap-3">
                    {props.tiers.map((t) => (
                      <div key={t.key} className="grid gap-1.5">
                        <span className="text-sm text-muted-foreground">{t.label}</span>
                        <PayPalSubscriptionButton
                          createSubscription={async () => ({
                            subscriptionId: (await call<{ subscriptionId: string }>("POST", "/api/subscriptions", { tier: t.key })).subscriptionId,
                          })}
                          onApprove={async ({ subscriptionId }) => {
                            void settle(() => call<{ credited: number }>("POST", `/api/subscriptions/${subscriptionId}/reconcile`), 12, "Thanks. Your first payment will show up here soon.");
                          }}
                          onError={() => setError("PayPal couldn't start the subscription. Please try again.")}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="rounded-xl border p-4">
                <div className="mb-3 flex items-center gap-2 font-medium">
                  <Wallet className="size-4 text-primary" /> Once
                </div>
                <div className="grid gap-3">
                  <Select value={String(topupCents)} onValueChange={(v) => setTopupCents(Number(v))}>
                    <SelectTrigger className="w-full" aria-label="Amount to add">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[500, 1000, 2500].map((c) => (
                        <SelectItem key={c} value={String(c)}>
                          {formatUsd(c)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <PayPalOneTimePaymentButton
                    createOrder={async () => ({ orderId: (await call<{ orderId: string }>("POST", "/api/topups", { cents: topupCents })).orderId })}
                    onApprove={async ({ orderId }) => {
                      void settle(() => call<{ credited: number }>("POST", `/api/topups/${orderId}/capture`), 3, "Thanks. PayPal is still processing this payment.");
                    }}
                    onError={() => setError("PayPal couldn't take the payment. Please try again.")}
                  />
                </div>
              </div>
            </div>
          </PayPalProvider>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 6: Verify, with real sandbox money**

Run: `pnpm typecheck && pnpm --filter web build`. Then, with `DEMO_MODE=1 MIN_PAYOUT_CENTS=1` and the sandbox app in `.env.local`, press Try the demo and do the four steps in Chrome.
Expected, as in `docs/e2e-plan-3a.md`:
- **Run a sample session:** a receipt "Weighed by gemini-2.5-flash-lite" with 9 packages.
- **Add money:** $10 through the sandbox buyer shows $9.16.
- **Approve:** the projection appears in "Where the money goes".
- **Settle now:** a toast says "Settled 1 developer's budget: $9.16 set aside...", and the accordion lists 9 packages with their maintainers.
- No page scrolls sideways at 390 px.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "Rebuild the dashboard around the demo steps, receipts and where the money went"
```

### Task 10: The maintainer page

**Files:**
- Rewrite: `apps/web/app/maintainer/page.tsx`, `apps/web/app/maintainer/MaintainerPanel.tsx`

The behaviour is unchanged: the same `/api/maintainer/me` and the same notices from Plan 2c.

- [ ] **Step 1: Restyle**

```tsx
import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { MaintainerPanel } from "./MaintainerPanel";

export const metadata: Metadata = { title: "Upstream for maintainers" };

export default function MaintainerPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 pt-10 sm:pt-14">
      <Badge variant="outline" className="mb-4 gap-1.5 rounded-full px-3 py-1">
        <span className="size-1.5 rounded-full bg-primary" /> For maintainers
      </Badge>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Get paid for the open source AI agents use</h1>
      <p className="mt-2 mb-8 max-w-2xl text-muted-foreground">
        Money from developers&apos; budgets is filed under your GitHub account, so it waits for you even before you join.
      </p>
      <MaintainerPanel />
    </main>
  );
}
```

```tsx
"use client";

import { CircleCheck, Clock, HandCoins, LogOut, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatUsd } from "@/lib/format";
import type { MaintainerSummary } from "@/lib/maintainers/summary";

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

  if (me === null) return <Skeleton className="h-48 rounded-xl" />;
  if (me === "signed-out") {
    return (
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">See what agents have set aside for you</CardTitle>
          <CardDescription className="leading-relaxed">
            When a developer&apos;s AI coding agent builds with your package, they can choose to pay you for it through Upstream. Sign in with GitHub
            to see what&apos;s waiting for you, then link PayPal to be paid.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild size="lg">
            <a href="/maintainer/github/start">Sign in with GitHub</a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const stats = [
    { icon: Clock, label: "Waiting for you", cents: me.cents.waiting },
    { icon: Wallet, label: "On its way", cents: me.cents.onItsWay },
    { icon: HandCoins, label: "Paid", cents: me.cents.paid, accent: true },
  ];
  return (
    <div className="grid gap-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar className="size-10">
            <AvatarImage src={`https://github.com/${me.login}.png?size=80`} alt="" />
            <AvatarFallback>{me.login.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div>
            <div className="font-semibold">@{me.login}</div>
            <div className="text-sm text-muted-foreground">Signed in with GitHub</div>
          </div>
        </div>
        <form method="post" action="/maintainer/signout">
          <Button type="submit" variant="outline" size="sm">
            <LogOut /> Sign out
          </Button>
        </form>
      </div>
      {notice && (
        <Alert>
          <CircleCheck />
          <AlertDescription role="status">{notice}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((st) => (
          <Card key={st.label} className="shadow-sm">
            <CardHeader>
              <CardDescription className="font-medium">{st.label}</CardDescription>
              <CardAction>
                <span className="grid size-8 place-items-center rounded-lg bg-accent text-accent-foreground">
                  <st.icon className="size-4" />
                </span>
              </CardAction>
            </CardHeader>
            <CardContent>
              <div className={`text-3xl font-semibold tracking-tight tabular-nums ${st.accent ? "text-primary" : ""}`}>{formatUsd(st.cents)}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Where we pay you</CardTitle>
          <CardDescription>
            {me.paypal.linked
              ? me.paypal.firstPayoutFrom
                ? `PayPal is linked. Your first payout can go out from ${me.paypal.firstPayoutFrom}.`
                : "PayPal is linked. Payouts go out with each settlement."
              : "Link a verified PayPal account so we can pay you. Payouts start a week after you link it."}
          </CardDescription>
          <CardAction>
            {me.paypal.linked ? <Badge>PayPal linked</Badge> : <Badge variant="outline">Not linked yet</Badge>}
          </CardAction>
        </CardHeader>
        <CardContent>
          <Button asChild variant={me.paypal.linked ? "outline" : "default"}>
            <a href="/maintainer/paypal/start">{me.paypal.linked ? "Link a different PayPal account" : "Link PayPal"}</a>
          </Button>
        </CardContent>
      </Card>

      {me.packages.length > 0 && (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-base font-semibold">How agents use your packages</CardTitle>
            <CardDescription>Counted over every receipt that names them. No developer is identified.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Package</TableHead>
                  <TableHead>What agents did with it</TableHead>
                  <TableHead className="text-right">Set aside</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {me.packages.map((p) => (
                  <TableRow key={`${p.ecosystem}:${p.name}`}>
                    <TableCell className="font-medium">
                      {p.name} <span className="text-xs font-normal text-muted-foreground">{p.ecosystem}</span>
                    </TableCell>
                    <TableCell className="whitespace-normal text-muted-foreground">
                      {Object.entries(p.roles)
                        .map(([role, n]) => `${ROLE[role] ?? role} ${times(n)}`)
                        .join(", ") || "no details yet"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatUsd(p.cents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {(me.months.length > 0 || me.payouts.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {me.months.length > 0 && (
            <Card className="shadow-sm">
              <CardHeader>
                <CardTitle className="text-base font-semibold">By month</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableBody>
                    {me.months.map((m) => (
                      <TableRow key={m.month}>
                        <TableCell>{m.month}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatUsd(m.setAsideCents)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
          {me.payouts.length > 0 && (
            <Card className="shadow-sm">
              <CardHeader>
                <CardTitle className="text-base font-semibold">Payouts</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableBody>
                    {me.payouts.map((p, i) => (
                      <TableRow key={i}>
                        <TableCell>{p.date}</TableCell>
                        <TableCell className="tabular-nums">{formatUsd(p.cents)}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={p.status === "SUCCESS" ? "default" : "outline"}>
                            {p.status === "SUCCESS" ? "Paid" : p.status === "PENDING" ? "On its way" : p.status.toLowerCase()}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm --filter web build`, then open `/maintainer` signed out.
Expected: the sign-in card. Plan 3b's live sign-in checks the signed-in view.

- [ ] **Step 3: Commit**

```bash
git add apps/web
git commit -m "Restyle the maintainer page"
```

### Task 11: The README and the record of the local run

**Files:**
- Modify: `README.md`
- Create: `docs/e2e-plan-3a.md`

- [ ] **Step 1: Write them**

````diff
--- a/README.md
+++ b/README.md
@@ -23,4 +23,15 @@ Safeguards built in:
 - Money is tracked by GitHub account, so a renamed or reused username can't redirect it.
 
+## The demo
+
+The hosted demo runs on the PayPal sandbox, so no real money moves. **Try the demo** gives each visitor their own empty account, and the dashboard walks through four steps:
+
+1. **Add money** with a PayPal sandbox buyer (the login is in the Devpost testing notes).
+2. **Run a sample session.** A recorded Claude Code session goes through the real pipeline: the package registries, then the Gemini judge. How it was recorded is in `docs/demo-sample-session.md`.
+3. **Approve its receipt**, after reading why each package got its share.
+4. **Settle now.** Your budget is split across the packages' maintainers, and PayPal Payouts go to the ones who have joined. Everyone else's share waits for them. In the demo, payouts go out at any amount; the real service waits until a maintainer is owed $1.
+
+The landing page's **Agent usage vs funding** chart sets each package's share of agent work, from real Claude Code sessions, against its share of the money Upstream has set aside. `pnpm --filter web usage-index` rebuilds the usage side from the sessions on your own machine, keeping only package names and counts.
+
 ## PayPal and AI used
 
@@ -44,4 +55,5 @@ node packages/cli/plugin/dist/upstream.mjs dashboard
 
 Then:
+- **Try the demo flow locally:** add `DEMO_MODE=1` and `MIN_PAYOUT_CENTS=1` to `apps/web/.env.local`, restart, and press **Try the demo**.
 - **Use it from Claude Code:** start Claude Code with the plugin, `claude --plugin-dir packages/cli/plugin`.
 - **Run the tests:** `pnpm test`.
@@ -55,5 +67,5 @@ Then:
 packages/core   evidence schema shared by the CLI and the server
 packages/cli    the upstream command, the session-end hook, the MCP server and the Claude Code plugin
-apps/web        Next.js app: receipts, the AI judge, funding, settlement, payouts, maintainer sign-in
+apps/web        Next.js app (Tailwind and shadcn/ui): receipts, the AI judge, funding, settlement, payouts, maintainer sign-in, the demo
 docs            the design spec, the implementation plans and their ledgers, and records of live sandbox runs
 ```
````

```markdown
# Plan 3a local run (14 Oct 2026)

The whole demo flow, with real PayPal sandbox money and the real Gemini judge, against the local dev server.

- **Server:** `next dev` with PGlite, `DEMO_MODE=1` and `MIN_PAYOUT_CENTS=1`, the sandbox app "Upstream"
- **Browser:** Chrome, driven through CDP (browser-harness), at 1512 px and at a 390 px phone width
- **Buyer:** the dedicated US sandbox personal account from Plan 2a

## Steps

| Step | What happened |
|---|---|
| Try the demo | `POST /demo/start` made a fresh account and landed on `/dashboard` with the four steps |
| Run a sample session | `POST /api/demo/sample-session` took 3.1 s. Gemini (`gemini-2.5-flash-lite`, prompt `judge-v2`) weighed 9 packages: hono 21.2% ("built on it"), vitest 18.6%, @hono/zod-validator 16.1%, zod 13.6%, typescript 8.8%, nanoid 8.6%, and three smaller ones |
| Add money | A $10 one-time payment through the PayPal popup; the budget showed $9.16 after PayPal's fee |
| Approve | The receipt switched to Approved, and "If we settled today" showed the split |
| Settle now | `POST /api/demo/settle` took 13.3 s, most of it GitHub lookups for the 9 repos. It said "Settled 1 developer's budget: $9.16 set aside for open-source maintainers." |
| Where the money went | $9.16 across 32 maintainers of 9 packages, all "not joined yet", since none of them has signed in to this sandbox |

No payout went out in this run: the 7-day hold for a newly linked maintainer means the payout leg is shown on the hosted demo, with Arun's sandbox account linked a week ahead (Plan 3b). Plan 2b's live run already sent a real sandbox payout.

## Things worth knowing

- **The PayPal popup pre-filled the developer's own email**, remembered by the browser. It had to be replaced with the sandbox buyer's. The Devpost testing notes should say to use the sandbox login even if PayPal suggests another account.
- **The index chart** shows usage from 15 of the 545 local sessions that used any package, and its money side updated live after the settlement (vitest and zod picked up funding).
- **Phone width:** no page scrolls sideways at 390 px. The header drops "How it works" and "Maintainers" there; the footer links to the maintainer page.
```

- [ ] **Step 2: Run the whole suite**

Run: `rm -rf node_modules/.vitest-cache && pnpm test && pnpm typecheck && pnpm --filter web build`
Expected: 321 passed, 1 skipped; typecheck and build exit 0.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/e2e-plan-3a.md
git commit -m "Describe the demo in the README and record the local run"
```
