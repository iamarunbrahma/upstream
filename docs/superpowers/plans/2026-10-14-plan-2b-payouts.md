# Upstream Plan 2b: Settlement and Payouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once a month (or on "Settle now"), each funder's unspent budget is split across their approved receipts, then across each package's maintainers, to the cent. Maintainers who have linked PayPal are paid through one PayPal Payouts batch, and their payout status comes back from PayPal. Refunds take money back out. Self-dealing controls stop a funder from paying themselves.

**Architecture:**
- **Who gets paid** is decided without AI (spec section 6). A package's repo comes from Plan 1's registry lookup. The repo's `.github/FUNDING.yml` names people, in equal shares. An organisation entry's share goes to the repo's top 5 human committers of the last 90 days, by commit count. With no usable FUNDING.yml, those committers get it all. Answers are cached for 7 days.
- **Accruals:** a settlement turns budget into accruals: rows of "this much from this funder, for this maintainer, for this package". An accrual is `held`, then `queued` on a payout line, then `paid`, or `returned` to the funder's budget. A funder's balance is the money they put in, less accruals that weren't returned.
- **Exactly once:**
  - A settlement claims each receipt once, under a Postgres advisory lock.
  - Each settlement sends at most one Payouts batch, because its id is the batch's `sender_batch_id`, which PayPal refuses twice.
  - Every split uses largest-remainder rounding, so no cent is made or lost.
- **Reconcile instead of trusting events:** as in Plan 2a. Payout statuses arrive from verified webhooks, or from reading the batch on the next run, so local development works without a public URL.

**Tech Stack:** Plans 1 and 2a's stack. No new dependencies. Adds the PayPal Payouts v1 API and GitHub's REST API (contents, users, commits).

**Spec:** `docs/superpowers/specs/2026-10-14-upstream-design.md`. This plan implements:
- section 6 (maintainer resolution and split)
- section 7 "Allocation", the 14-day rule of "Spending rule", "Settlement and payout" and "Webhooks" (payout items)
- section 10's payout-side controls (self-dealing check, per-funder per-maintainer cap, first-payout hold)
- Plan 2a's final-review finding I6 (refunds and reversals)

Maintainer sign-in (GitHub OAuth plus Log in with PayPal) and the maintainer page are **Plan 2c**. Until then, `pnpm --filter web claim-maintainer` records a sandbox claim. The polished UI, demo mode and Render deploy are Plan 3.

**Decided with Arun, 14 Oct 2026:**
- Each settlement spends **all** of a funder's unspent money. With no approved receipts, it all carries over.
- At most **$100 a month** from one funder to one maintainer. Anything over stays in the funder's budget.
- A new maintainer's first payout waits **7 days** after they link PayPal.

**Verified 14 Oct 2026**, every task applied in a scratch worktree of `main` (commit 41fb7db):
- 238 tests pass across 40 files, one Postgres-only test is skipped, the web app and CLI typecheck, and `next build` lists `/api/settle`.
- **Live PayPal sandbox:**
  - A $1.00 Payouts batch to a `PAYPAL_ID` was created and read back. The item carried our `sender_item_id`, a `transaction_status`, and a **$0.25 fee charged to the sender**.
  - Sending the same `sender_batch_id` again is refused: `400`, issue `"Batch with given sender_batch_id already exists"`. This happens **even with the same `PayPal-Request-Id`**, so for Payouts that header gives no idempotency, and `sender_batch_id` is what makes sending safe (Task 4).
  - A $1.00 refund of a capture returned `id`, `amount { currency_code, value }`, `custom_id`, `status: COMPLETED`, an `up` link to `/v2/payments/captures/{id}`, and a `paypal_fee` of 0.00. PayPal keeps its original fee, so the platform loses the full refund (Task 6).
- **Live GitHub (unauthenticated):**
  - FUNDING.yml comes in several forms: `github: samuelcolvin`, `github: [vitest-dev]`, and the template with comments.
  - `/users/{login}` gives `type: Organization`.
  - Commits mark bots with `author.type: "Bot"`.
- **A live dry run** of `pnpm --filter web settle`, on a copy of the dev database holding Plan 2a's sandbox funder, set aside all $13.50:
  - $5.53 to pydantic's FUNDING.yml person
  - $4.86 and $2.21 to fastapi's top committers
  - 5 vitest committers, through its org entry

  Marking the pydantic maintainer as claimed at the funder's own PayPal account returned that $5.53 to the funder ("same-person").
- That dry run found **a Plan 1 bug**: pydantic's repo resolved to `sponsors/samuelcolvin`, its GitHub Sponsors link. Task 2 fixes it, and bumps the registry cache key so stale answers are ignored.

**Two things need Arun:**
1. **`GITHUB_TOKEN` in `.env.local` is refused by GitHub (401).** The code treats a refused token as a setup error, and says so. Use a new read-only token, or leave the variable empty and use GitHub's 60 unauthenticated requests an hour.
2. **Task 8 needs the PayPal account id of a second sandbox account**, such as maintainer test account sb-ls07n53353609. It's the "Account ID" on that account's page in developer.paypal.com. A payout to the funder's own account is (correctly) refused as self-dealing, so it can't stand in.

**Builds on:** Plans 1 and 2a on `main`. Ledgers: `docs/superpowers/plans/2026-10-14-plan-1-ledger.md` and `docs/superpowers/plans/2026-10-14-plan-2a-ledger.md`. What matters from them here:
- the funder balance shown on the dashboard
- `recordFunding` and `fundedCents`
- `handleWebhook` stores the event id only after its work succeeds (and a 503 makes PayPal resend)
- `FakePayPal.failNext`
- PGlite in `.data/` for local development, Postgres in production

## Global Constraints

- All of Plan 1's and Plan 2a's Global Constraints still apply:
  - versions, ESM, strict TypeScript
  - single-line commits, no attribution
  - plain user copy, no em dashes
  - integer cents, USD only
  - verified webhooks, and secrets kept server-side
- **No new dependencies.**
- **Every split of money uses `splitCents`** (largest remainder, ties to the earlier entry). The parts always add up to the whole.
- **A settlement spends a funder's whole unspent balance** across their approved, not-yet-settled receipts. Package shares are the receipts' summed `weightBp`. A share with nobody to receive it stays in the budget.
- **Self-dealing controls:**
  - **Same person:** money is returned, never paid, to a maintainer whose PayPal account id matches a `payer_id` on any of that funder's funding events or subscriptions.
  - **Monthly cap:** `MONTHLY_CAP_CENTS = 10000`, the most one funder sets aside for one maintainer per UTC calendar month.
  - **First-payout hold:** `FIRST_PAYOUT_HOLD_MS` = 7 days after `claimedAt`.
- **Payouts:**
  - Only `recipient_type: PAYPAL_ID`.
  - One batch per settlement: `sender_batch_id` = the settlement id, and `sender_item_id` = the payout line id.
  - A line is paid only at $1.00 or more (`MIN_PAYOUT_CENTS = 100`). Below that, money carries over.
  - Never rely on `PayPal-Request-Id` for Payouts.
- **Time limits:**
  - Proposed receipts expire after 14 days (`expired`).
  - Held money returns to the funder after 90 days, unless its maintainer has linked PayPal.
- **GitHub:**
  - `GITHUB_TOKEN` is optional.
  - 401 throws a clear setup error.
  - 403, 429 and 5xx mean "try later": that funder waits for the next run.
- **PGlite allows one process.** Locally, run settlements through `POST /api/settle` on the dev server. `pnpm --filter web settle` is for Postgres (Render cron), or for when the dev server is stopped.
- **`POST /api/settle`** requires `Authorization: Bearer $SETTLE_TOKEN`, compared in constant time. With no `SETTLE_TOKEN`, it is off (401).

## Review Focus

1. **Two settlement runs overlapping on real Postgres** (cron plus a "Settle now" click). The budget must be spent once. PGlite runs one transaction at a time, so it can't show this. `test/settle-pg.test.ts` runs three overlapping settlements when `TEST_DATABASE_URL` is set, and Task 8 runs it once against a throwaway Postgres.
2. **A payout batch whose answer was lost, or a retry after a failure.** There must never be two batches for one settlement, and no line may be paid twice. A "batch already exists" answer leaves the settlement waiting for webhooks to name the batch. The tests live in Task 4.
3. **A refund or reversal after money was set aside, or after it was paid.** The budget may go below zero. Unpaid money is taken back, newest first. Nothing more is set aside until the funder is covered. A refund never takes back more than its payment added. The tests live in Task 6.
4. **Who gets paid, on real-world input:**
   - every FUNDING.yml form, and organisation entries
   - bots, and renamed or deleted accounts
   - registry links that look like repos but aren't (Sponsors pages)
   - rate limits, and a refused token

   The tests live in Task 2.
5. **PayPal reporting a payout line `RETURNED` or `FAILED`, or a webhook for a line we didn't send or for another batch.** Bounced money is held again, never lost or paid twice. Foreign events change nothing. The tests live in Task 5.

## File Structure

```
apps/web/
  lib/funding/split.ts           splitCents: largest-remainder split of cents by integer weights
  lib/db/schema.ts               + maintainers, recipient_cache, settlements, payout_items, accruals,
                                   receipts.settlement_id, funding_events.refund_of, receipt status "expired"
  drizzle/0002_*.sql             generated, additive only
  lib/funding/ledger.ts          + givenCents, balanceCents
  lib/resolver/recipients.ts     FUNDING.yml parsing, resolveRecipients, recipientsFor (7-day cache), createGithubGet
  lib/resolver/github.ts         parseGithubRepo skips GitHub's own pages (sponsors/, orgs/, ...)
  lib/resolver/registry.ts       PyPI: prefer Source/Repository links
  lib/resolver/cache.ts          versioned cache key
  lib/funding/settle.ts          settle(): expire stale proposals, settle each funder, queue payouts (locked)
  lib/funding/payouts.ts         queuePayouts (returns, self-dealing, hold, $1 minimum), payOut (send batches)
  lib/funding/payout-status.ts   applyPayoutItem, reconcilePayouts
  lib/funding/refunds.ts         recordRefund for PAYMENT.CAPTURE/SALE.REFUNDED/REVERSED
  lib/funding/webhooks.ts        + payout-item and refund events
  lib/funding/run.ts             runSettlement, settlementDeps, describeRun
  lib/paypal/api.ts, fake.ts     + createPayoutBatch, getPayoutBatch
  app/api/settle/route.ts        POST "Settle now" (SETTLE_TOKEN)
  app/api/me/route.ts            balanceCents, givenCents
  app/dashboard/FundingPanel.tsx shows the balance and what was set aside
  jobs/settle.ts                 the scheduled job (Postgres)
  scripts/claim-maintainer.ts    sandbox-only stand-in for Plan 2c's sign-in
  test/split, settlement-schema, recipients, settle, settle-pg, settle-fixtures, payouts,
       payout-status, refunds, run (+ edits to settings, funding, paypal-client, github, registry, db)
packages/core/src/api.ts         ReceiptStatus + "expired"
packages/cli/src/format.ts       wording for an expired receipt
```

---

### Task 1: Settlement tables, a cent splitter and the funder balance

**Files:**
- Create: `apps/web/lib/funding/split.ts`, `apps/web/test/split.test.ts`, `apps/web/test/settlement-schema.test.ts`
- Modify: `apps/web/lib/db/schema.ts`, `apps/web/lib/funding/ledger.ts`, `apps/web/lib/funding/settings.ts`, `apps/web/app/api/me/route.ts`, `apps/web/app/api/topups/[id]/capture/route.ts`, `apps/web/app/api/subscriptions/[id]/reconcile/route.ts`, `apps/web/app/dashboard/FundingPanel.tsx`
- Modify tests: `apps/web/test/settings.test.ts`, `apps/web/test/funding.test.ts`
- Generate: `apps/web/drizzle/0002_*.sql`

**Interfaces:**
- Consumes: `recordFunding`, `fundedCents` (Plan 2a ledger), `createDevice` (Plan 1).
- Produces:
  - `splitCents(total: number, weights: number[]): number[]`
  - tables `maintainers`, `recipientCache`, `settlements`, `payoutItems` and `accruals`, plus the type `RepoRecipients { source: "funding" | "committers" | "none"; recipients: Array<{ login: string; shareBp: number }> }`
  - `receipts.settlementId`, and `fundingEvents.refundOf` with source `"refund"`
  - `givenCents(db, accountId): Promise<number>` and `balanceCents(db, accountId): Promise<number>`
  - The JSON responses of `/api/me`, the capture route and the reconcile route rename `fundedCents` to `balanceCents`.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/split.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { splitCents } from "../lib/funding/split";

describe("splitCents", () => {
  it("splits in proportion, and the parts always add up to the total", () => {
    expect(splitCents(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(splitCents(1350, [5240, 4090, 670])).toEqual([707, 552, 91]);
    for (const total of [1, 99, 1001, 99_999]) {
      expect(splitCents(total, [3, 7, 11, 13]).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it("never gives a cent to a zero weight", () => {
    expect(splitCents(5, [0, 1, 1])).toEqual([0, 3, 2]);
  });

  it("gives nothing when there is nothing to split or no weight", () => {
    expect(splitCents(0, [1, 2])).toEqual([0, 0]);
    expect(splitCents(500, [0, 0])).toEqual([0, 0]);
    expect(splitCents(500, [])).toEqual([]);
  });

  it("refuses fractional or negative amounts", () => {
    expect(() => splitCents(1.5, [1])).toThrow();
    expect(() => splitCents(-1, [1])).toThrow();
    expect(() => splitCents(10, [1, -1])).toThrow();
    expect(() => splitCents(10, [0.5])).toThrow();
  });
});
```

`apps/web/test/settlement-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { accruals, fundingEvents, maintainers, payoutItems, settlements } from "../lib/db/schema";
import { balanceCents, recordFunding } from "../lib/funding/ledger";

async function setup() {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  const { accountId } = await createDevice(db, null);
  const [s] = await db.insert(settlements).values({}).returning();
  return { db, accountId, settlementId: s!.id };
}
const accrual = (settlementId: string, funderId: string, cents: number, status: "held" | "queued" | "paid" | "returned") =>
  ({ settlementId, funderId, login: "alice", ecosystem: "npm" as const, name: "left-pad", cents, status });

describe("settlement tables", () => {
  it("are created by migrations, with one maintainer per PayPal account", async () => {
    const { db } = await setup();
    await db.insert(maintainers).values({ login: "alice", paypalPayerId: "PAYER-1" });
    await expect(db.insert(maintainers).values({ login: "bob", paypalPayerId: "PAYER-1" })).rejects.toThrow();
  });
});

describe("balanceCents", () => {
  it("is the money put in, less refunds and what settlements set aside, counting returned money back", async () => {
    const { db, accountId, settlementId } = await setup();
    await recordFunding(db, { accountId, source: "topup", paypalId: "CAP-1", amountCents: 1000, payerId: null, occurredAt: new Date(), raw: null });
    await db.insert(fundingEvents).values({ paypalId: "REF-1", accountId, source: "refund", refundOf: "CAP-1", amountCents: -150, occurredAt: new Date() });
    await db.insert(accruals).values([
      accrual(settlementId, accountId, 300, "held"),
      accrual(settlementId, accountId, 200, "paid"),
      accrual(settlementId, accountId, 50, "queued"),
      accrual(settlementId, accountId, 100, "returned"),
    ]);
    expect(await balanceCents(db, accountId)).toBe(1000 - 150 - 300 - 200 - 50);
  });

  it("is zero for a new account", async () => {
    const { db, accountId } = await setup();
    expect(await balanceCents(db, accountId)).toBe(0);
  });

  it("links a payout line to its settlement", async () => {
    const { db, settlementId } = await setup();
    const [item] = await db.insert(payoutItems).values({ settlementId, login: "alice", payerId: "PAYER-1", cents: 500 }).returning();
    expect(item!.status).toBe("PENDING");
  });
});
```

In `apps/web/test/settings.test.ts`, the dashboard figure becomes what's left after settlements. Change the schema import to:

```ts
import { accruals, settlements, subscriptions } from "../lib/db/schema";
```

Above `const fund = ...`, add:

```ts
/** A settlement set `cents` of this funder's budget aside for a maintainer. */
async function setAside(accountId: string, cents: number) {
  const [s] = await h.deps.db.insert(settlements).values({}).returning();
  await h.deps.db.insert(accruals).values({ settlementId: s!.id, funderId: accountId, login: "alice", ecosystem: "pypi", name: "fastapi", cents });
}
```

Before `it("approves receipts by itself when it's on and there is money in the budget"`, add:

```ts
  it("waits once a settlement has set the whole budget aside", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    await setAutoApprove(h.deps.db, accountId, true);
    await fund(accountId, 500);
    await setAside(accountId, 500);
    expect((await submitReceipt(h.deps, accountId, payload())).view.status).toBe("proposed");
  });
```

In "summarises the budget, subscription, setting and receipts", change `fundedCents: 916,` to `balanceCents: 916,`. Then, before `it("shows the active subscription even when an abandoned one changed more recently"`, add:

```ts
  it("shows the budget left after what settlements set aside for maintainers", async () => {
    const { accountId, token } = await createDevice(h.deps.db, null);
    await fund(accountId, 1000);
    await setAside(accountId, 400);
    const res = await getMe(new Request("http://up.test/api/me", { headers: { authorization: `Bearer ${token}` } }));
    expect(((await res.json()) as { balanceCents: number }).balanceCents).toBe(600);
  });
```

In `apps/web/test/funding.test.ts`, change `{ status: "ACTIVE", credited: 453, fundedCents: 453 }` to `{ status: "ACTIVE", credited: 453, balanceCents: 453 }`.

- [ ] **Step 2: Run them to see them fail**

Run: `rm -rf node_modules/.vitest-cache && pnpm test apps/web/test/split.test.ts apps/web/test/settlement-schema.test.ts apps/web/test/settings.test.ts apps/web/test/funding.test.ts`
Expected: FAIL.
- `split.test.ts` can't resolve `../lib/funding/split`.
- `settlement-schema.test.ts` fails: the new tables and `balanceCents` don't exist yet.
- 4 tests in settings and funding fail: there is no `balanceCents` field, and no tables to set money aside in.

- [ ] **Step 3: Add the splitter**

`apps/web/lib/funding/split.ts`:

```ts
/**
 * Splits `total` cents in proportion to non-negative integer `weights`, so the parts add up to `total` exactly.
 * Largest-remainder method; ties go to the earlier weight, so the same input always gives the same split.
 */
export function splitCents(total: number, weights: number[]): number[] {
  if (!Number.isInteger(total) || total < 0) throw new Error("total must be a whole, non-negative number of cents");
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) throw new Error("weights must be whole, non-negative numbers");
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = weights.map((w, i) => ({ i, rem: (total * w) % sum })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    parts[i]! += 1;
    left -= 1;
  }
  return parts;
}
```

- [ ] **Step 4: Add the tables**

In `apps/web/lib/db/schema.ts`, give `receipts` a settlement link. After its `decidedAt` column:

```ts
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** The settlement that spent this receipt's share of the budget; null until then. */
    settlementId: uuid("settlement_id").references(() => settlements.id),
  },
```

Let `fundingEvents` hold refunds. Replace its `source` column with:

```ts
    source: text("source", { enum: ["subscription", "topup", "refund"] }).notNull(),
    /** Refunds and reversals only: the sale or capture id they take money back from. Their amount is negative. */
    refundOf: text("refund_of"),
```

At the end of the file, add:

```ts
/** A GitHub account that can receive money. Plan 2c's sign-in sets `paypalPayerId` and `claimedAt`. */
export const maintainers = pgTable("maintainers", {
  login: text("login").primaryKey(),
  githubId: integer("github_id"),
  paypalPayerId: text("paypal_payer_id").unique(),
  claimedAt: timestamp("claimed_at", tz),
  createdAt: createdAt(),
});

export interface RepoRecipients {
  source: "funding" | "committers" | "none";
  /** GitHub logins with their share in basis points; the shares add up to 10000, or the list is empty. */
  recipients: Array<{ login: string; shareBp: number }>;
}

export const recipientCache = pgTable("recipient_cache", {
  repo: text("repo").primaryKey(),
  data: jsonb("data").$type<RepoRecipients>().notNull(),
  fetchedAt: timestamp("fetched_at", tz).notNull(),
});

/** One run of the settlement job. Its id is also the Payouts `sender_batch_id`, so a batch is sent once. */
export const settlements = pgTable("settlements", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: createdAt(),
  payoutBatchId: text("payout_batch_id"),
  batchStatus: text("batch_status"),
});

/** One line of a Payouts batch: everything one maintainer is owed in that run. Its id is the `sender_item_id`. */
export const payoutItems = pgTable(
  "payout_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    settlementId: uuid("settlement_id").notNull().references(() => settlements.id),
    login: text("login").notNull(),
    payerId: text("payer_id").notNull(),
    cents: integer("cents").notNull(),
    paypalItemId: text("paypal_item_id"),
    status: text("status").notNull().default("PENDING"),
    feeCents: integer("fee_cents"),
    updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
  },
  (t) => [index("payout_items_settlement").on(t.settlementId)],
);

/**
 * Money a settlement set aside from one funder for one maintainer, for one package.
 * held: waiting (not claimed yet, in the first-payout hold, or under $1 in total)
 * queued: on a Payouts line; paid: PayPal confirmed it; returned: back in the funder's budget.
 */
export const accruals = pgTable(
  "accruals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    settlementId: uuid("settlement_id").notNull().references(() => settlements.id),
    funderId: uuid("funder_id").notNull().references(() => accounts.id),
    login: text("login").notNull(),
    ecosystem: text("ecosystem", { enum: ["npm", "pypi"] }).notNull(),
    name: text("name").notNull(),
    cents: integer("cents").notNull(),
    status: text("status", { enum: ["held", "queued", "paid", "returned"] }).notNull().default("held"),
    returnReason: text("return_reason", { enum: ["unclaimed", "same-person", "refunded"] }),
    payoutItemId: uuid("payout_item_id").references(() => payoutItems.id),
    createdAt: createdAt(),
  },
  (t) => [index("accruals_funder").on(t.funderId), index("accruals_login_status").on(t.login, t.status)],
);
```

Run: `pnpm --filter web db:generate`
Expected: a new `apps/web/drizzle/0002_*.sql` that
- creates `accruals`, `maintainers` (with `UNIQUE("paypal_payer_id")`), `payout_items`, `recipient_cache` and `settlements`
- adds `funding_events.refund_of` and `receipts.settlement_id`
- adds four foreign keys and three indexes

Nothing is dropped or altered.

- [ ] **Step 5: The balance, and the routes that show it**

Replace `apps/web/lib/funding/ledger.ts` with:

```ts
import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals, fundingEvents } from "../db/schema";
import type { Money } from "../paypal/api";
import { toCents } from "../paypal/money";

export interface FundingInput {
  accountId: string;
  source: "subscription" | "topup";
  /** PayPal's sale id (subscriptions) or capture id (top-ups): the idempotency key. */
  paypalId: string;
  amountCents: number;
  payerId: string | null;
  occurredAt: Date;
  raw: unknown;
}

/** Records money in. Recording the same PayPal payment again is a no-op that returns false. */
export async function recordFunding(db: Db, f: FundingInput): Promise<boolean> {
  if (!Number.isInteger(f.amountCents) || f.amountCents <= 0) return false;
  const rows = await db
    .insert(fundingEvents)
    .values({ ...f, raw: (f.raw ?? null) as object })
    .onConflictDoNothing({ target: fundingEvents.paypalId })
    .returning({ id: fundingEvents.paypalId });
  return rows.length > 0;
}

/** Money put in, less refunds and reversals (which are stored as negative amounts). */
export async function fundedCents(db: Db, accountId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${fundingEvents.amountCents}), 0)` })
    .from(fundingEvents)
    .where(eq(fundingEvents.accountId, accountId));
  return Number(row?.total ?? 0);
}

/** What settlements set aside from this funder for maintainers, paid or not yet. Returned money doesn't count. */
export async function givenCents(db: Db, accountId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${accruals.cents}), 0)` })
    .from(accruals)
    .where(and(eq(accruals.funderId, accountId), ne(accruals.status, "returned")));
  return Number(row?.total ?? 0);
}

/** What the funder can still give: money put in, less what settlements set aside. */
export async function balanceCents(db: Db, accountId: string): Promise<number> {
  return (await fundedCents(db, accountId)) - (await givenCents(db, accountId));
}

/** A PayPal amount in cents, preferring the net amount after PayPal's fee. Anything that isn't USD counts as 0. */
export function netCents(net?: Money, gross?: Money): number {
  const m = net ?? gross;
  if (!m || m.currency_code !== "USD") return 0;
  return toCents(m.value);
}
```

In `apps/web/lib/funding/settings.ts`, import `balanceCents` instead of `fundedCents`, and auto-approve only while `(await balanceCents(db, accountId)) > 0`.

In `apps/web/app/api/topups/[id]/capture/route.ts` and `apps/web/app/api/subscriptions/[id]/reconcile/route.ts`, import `balanceCents` instead of `fundedCents`. Answer `balanceCents: await balanceCents(deps.db, accountId)` in place of `fundedCents: ...`.

Replace `apps/web/app/api/me/route.ts` with:

```ts
import { desc, eq, sql } from "drizzle-orm";
import { receipts, subscriptions } from "../../../lib/db/schema";
import { balanceCents } from "../../../lib/funding/ledger";
import { getSettings } from "../../../lib/funding/settings";
import { json, withAccount } from "../../../lib/http";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  return withAccount(req, async (deps, accountId) => {
    const [subscription] = await deps.db
      .select({ id: subscriptions.id, tier: subscriptions.tier, status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId))
      // A live subscription wins over an abandoned attempt that changed later, so we never invite a second one.
      .orderBy(sql`case ${subscriptions.status} when 'ACTIVE' then 0 when 'APPROVED' then 1 when 'SUSPENDED' then 2 else 3 end`, desc(subscriptions.updatedAt))
      .limit(1);
    const counts = await deps.db
      .select({ status: receipts.status, n: sql<string>`count(*)` })
      .from(receipts)
      .where(eq(receipts.accountId, accountId))
      .groupBy(receipts.status);
    return json({
      balanceCents: await balanceCents(deps.db, accountId),
      subscription: subscription ?? null,
      autoApprove: (await getSettings(deps.db, accountId)).autoApprove,
      receipts: { proposed: 0, approved: 0, skipped: 0, ...Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) },
      paymentsReady: Boolean(deps.paypal),
    });
  });
}
```

In `apps/web/app/dashboard/FundingPanel.tsx`, rename the `Me` field `fundedCents: number;` to `balanceCents: number;`, and show `{formatUsd(me.balanceCents)}` in place of `{formatUsd(me.fundedCents)}`.

- [ ] **Step 6: Run the tests to see them pass**

Run: `rm -rf node_modules/.vitest-cache && pnpm test`, then `pnpm --filter web exec tsc --noEmit`
Expected: every test passes, and the typecheck is clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/funding/split.ts apps/web/lib/db/schema.ts apps/web/drizzle apps/web/lib/funding/ledger.ts apps/web/lib/funding/settings.ts apps/web/app/api/me/route.ts "apps/web/app/api/topups/[id]/capture/route.ts" "apps/web/app/api/subscriptions/[id]/reconcile/route.ts" apps/web/app/dashboard/FundingPanel.tsx apps/web/test/split.test.ts apps/web/test/settlement-schema.test.ts apps/web/test/settings.test.ts apps/web/test/funding.test.ts
git commit -m "Add settlement tables, a cent splitter and the funder balance"
```

---

### Task 2: Who gets paid for a repo

**Files:**
- Create: `apps/web/lib/resolver/recipients.ts`, `apps/web/test/recipients.test.ts`
- Modify: `apps/web/lib/resolver/github.ts`, `apps/web/lib/resolver/registry.ts`, `apps/web/lib/resolver/cache.ts`
- Modify tests: `apps/web/test/github.test.ts`, `apps/web/test/registry.test.ts`, `apps/web/test/db.test.ts`

**Interfaces:**
- Consumes: `RepoRef` and `parseGithubRepo` (Plan 1), `recipientCache` and `RepoRecipients` (Task 1), `splitCents` (Task 1).
- Produces:
  - `type GithubGet = (path: string) => Promise<{ status: number; body: unknown }>`
  - `createGithubGet(token: string | undefined, fetchImpl?): GithubGet`
  - `fundingGithubLogins(yaml: string): string[]`
  - `resolveRecipients(repo: RepoRef, gh: GithubGet, now: Date): Promise<RepoRecipients | "later">`
  - `recipientsFor(db, gh, repo, now): Promise<RepoRecipients | "later">`
  - `RECIPIENT_TTL_MS`

- [ ] **Step 1: Write the failing tests**

`apps/web/test/recipients.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { fundingGithubLogins, recipientsFor, resolveRecipients, type GithubGet } from "../lib/resolver/recipients";

const NOW = new Date("2026-10-14T10:00:00Z");
const DAY = 86_400_000;
const repo = { owner: "acme", name: "widget" };
const base = "/repos/acme/widget";

const fundingFile = (text: string) => ({ status: 200, body: { encoding: "base64", content: Buffer.from(text).toString("base64") } });
const commit = (login: string, type = "User") => ({ author: { login, type } });
const commits = (...entries: Array<[string, number, string?]>) => ({
  status: 200,
  body: entries.flatMap(([login, n, type]) => Array.from({ length: n }, () => commit(login, type))),
});

/** A fake GitHub API: exact paths, or a path prefix ending in "*". Anything else is a 404. */
function github(routes: Record<string, { status: number; body: unknown }>) {
  const calls: string[] = [];
  const get: GithubGet = async (path) => {
    calls.push(path);
    const hit = routes[path] ?? Object.entries(routes).find(([k]) => k.endsWith("*") && path.startsWith(k.slice(0, -1)))?.[1];
    return hit ?? { status: 404, body: { message: "Not Found" } };
  };
  return { get, calls };
}

describe("fundingGithubLogins", () => {
  it("reads every way a FUNDING.yml names GitHub accounts", () => {
    expect(fundingGithubLogins("github: samuelcolvin\n")).toEqual(["samuelcolvin"]);
    expect(fundingGithubLogins("github: [vitest-dev]\nopen_collective: vitest\n")).toEqual(["vitest-dev"]);
    expect(fundingGithubLogins("github: [Alice, 'bob' , \"carol\"]")).toEqual(["alice", "bob", "carol"]);
    expect(fundingGithubLogins("ko_fi: x\ngithub:\n  - alice\n  - Bob # lead\npatreon: y\n")).toEqual(["alice", "bob"]);
    expect(fundingGithubLogins("# These are supported funding model platforms\n\ngithub: drizzle-team\npatreon: # Replace with a single Patreon username\n")).toEqual(["drizzle-team"]);
  });

  it("ignores the template's placeholder and anything that isn't a GitHub login", () => {
    expect(fundingGithubLogins("github: # Replace with up to 4 GitHub Sponsors-enabled usernames\n")).toEqual([]);
    expect(fundingGithubLogins("github: [ok-name, bad name, -dash, https://evil.example]")).toEqual(["ok-name"]);
    expect(fundingGithubLogins("open_collective: x\n")).toEqual([]);
  });
});

describe("resolveRecipients", () => {
  it("pays the people a FUNDING.yml names, in equal shares", async () => {
    const gh = github({
      [`${base}/contents/.github/FUNDING.yml`]: fundingFile("github: [alice, bob]\n"),
      "/users/alice": { status: 200, body: { type: "User" } },
      "/users/bob": { status: 200, body: { type: "User" } },
    });
    expect(await resolveRecipients(repo, gh.get, NOW)).toEqual({
      source: "funding",
      recipients: [
        { login: "alice", shareBp: 5000 },
        { login: "bob", shareBp: 5000 },
      ],
    });
    expect(gh.calls.some((c) => c.includes("/commits"))).toBe(false);
  });

  it("gives an organisation's share to the repo's recent human committers, by commit count", async () => {
    const gh = github({
      [`${base}/contents/.github/FUNDING.yml`]: fundingFile("github: [carol, acme]\n"),
      "/users/carol": { status: 200, body: { type: "User" } },
      "/users/acme": { status: 200, body: { type: "Organization" } },
      [`${base}/commits*`]: commits(["alice", 3], ["bob", 1], ["dependabot[bot]", 5, "Bot"], ["renovate-bot", 4, "Bot"]),
    });
    expect(await resolveRecipients(repo, gh.get, NOW)).toEqual({
      source: "funding",
      recipients: [
        { login: "carol", shareBp: 5000 },
        { login: "alice", shareBp: 3750 },
        { login: "bob", shareBp: 1250 },
      ],
    });
    expect(gh.calls).toContain(`${base}/commits?since=${encodeURIComponent(new Date(NOW.getTime() - 90 * DAY).toISOString())}&per_page=100`);
  });

  it("without a FUNDING.yml, pays the top 5 committers of the last 90 days", async () => {
    const gh = github({ [`${base}/commits*`]: commits(["a", 6], ["b", 5], ["c", 4], ["d", 3], ["e", 2], ["f", 1]) });
    const r = await resolveRecipients(repo, gh.get, NOW);
    expect(r).not.toBe("later");
    if (r === "later") return;
    expect(r.source).toBe("committers");
    expect(r.recipients.map((x) => x.login)).toEqual(["a", "b", "c", "d", "e"]);
    expect(r.recipients.reduce((s, x) => s + x.shareBp, 0)).toBe(10_000);
  });

  it("falls back to committers when every FUNDING.yml account is gone", async () => {
    const gh = github({
      [`${base}/contents/.github/FUNDING.yml`]: fundingFile("github: ghost\n"),
      [`${base}/commits*`]: commits(["alice", 1]),
    });
    expect(await resolveRecipients(repo, gh.get, NOW)).toEqual({ source: "committers", recipients: [{ login: "alice", shareBp: 10_000 }] });
  });

  it("finds nobody for a repo with no FUNDING.yml and no human commits", async () => {
    const gh = github({ [`${base}/commits*`]: commits(["renovate[bot]", 3, "Bot"]) });
    expect(await resolveRecipients(repo, gh.get, NOW)).toEqual({ source: "none", recipients: [] });
  });

  it("asks to try later when GitHub is rate-limiting or failing, and refuses a bad token loudly", async () => {
    expect(await resolveRecipients(repo, github({ [`${base}/contents/.github/FUNDING.yml`]: { status: 403, body: {} } }).get, NOW)).toBe("later");
    expect(await resolveRecipients(repo, github({ [`${base}/commits*`]: { status: 502, body: {} } }).get, NOW)).toBe("later");
    await expect(resolveRecipients(repo, github({ [`${base}/contents/.github/FUNDING.yml`]: { status: 401, body: {} } }).get, NOW)).rejects.toThrow(/GitHub token/);
  });
});

describe("recipientsFor", () => {
  it("remembers a repo's recipients for 7 days, and uses the old answer while GitHub says try later", async () => {
    const db = createPgliteDb();
    await migrateDb(db, "pglite");
    const gh = github({ [`${base}/commits*`]: commits(["alice", 1]) });
    const first = await recipientsFor(db, gh.get, repo, NOW);
    expect(first).toEqual({ source: "committers", recipients: [{ login: "alice", shareBp: 10_000 }] });
    const calls = gh.calls.length;
    expect(await recipientsFor(db, gh.get, repo, new Date(NOW.getTime() + 6 * DAY))).toEqual(first);
    expect(gh.calls.length).toBe(calls);

    const limited = github({ [`${base}/contents/.github/FUNDING.yml`]: { status: 403, body: {} } });
    expect(await recipientsFor(db, limited.get, repo, new Date(NOW.getTime() + 8 * DAY))).toEqual(first);
    const fresh = createPgliteDb();
    await migrateDb(fresh, "pglite");
    expect(await recipientsFor(fresh, limited.get, repo, NOW)).toBe("later");
  });
});
```

In `apps/web/test/github.test.ts`, after the "rejects non-GitHub and empty values" test, add:

```ts
  it("rejects GitHub's own pages, such as a Sponsors link, which aren't repos", () => {
    expect(parseGithubRepo("https://github.com/sponsors/samuelcolvin")).toBeNull();
    expect(parseGithubRepo("https://github.com/orgs/pydantic/people")).toBeNull();
    expect(parseGithubRepo("https://github.com/apps/renovate")).toBeNull();
  });
```

In `apps/web/test/registry.test.ts`, before `describe("resolvePackage failures"`, add:

```ts
describe("resolvePackage (PyPI) repo choice", () => {
  it("takes the repo from a Source or Repository link before any other GitHub link", async () => {
    const http = fake({
      "https://pypi.org/pypi/pydantic/json": {
        status: 200,
        body: {
          info: {
            summary: "Data validation",
            project_urls: {
              Funding: "https://github.com/sponsors/samuelcolvin",
              Changelog: "https://github.com/someone/notes",
              Homepage: "https://docs.pydantic.dev",
              Source: "https://github.com/pydantic/pydantic",
            },
          },
        },
      },
    });
    expect((await resolvePackage("pypi", "pydantic", http)).repo).toEqual({ owner: "pydantic", name: "pydantic" });
  });
});
```

In `apps/web/test/db.test.ts`, add `import { packageCache } from "../lib/db/schema";`. Then, before "does not cache server errors and returns not-found meanwhile", add:

```ts
  it("ignores answers cached by an older version of the lookup", async () => {
    const db = await freshDb();
    const stale = { ecosystem: "npm" as const, name: "zod", found: true, description: "old answer", homepage: null, repo: null, docsHosts: [], fundingUrls: [] };
    await db.insert(packageCache).values({ key: "npm:zod", data: stale, fetchedAt: new Date() });
    const { http, state } = counting(zod.status, zod.body);
    expect((await resolveWithCache(db, "npm", "zod", http)).description).toBe("schema validation");
    expect(state.calls).toBe(1);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `rm -rf node_modules/.vitest-cache && pnpm test apps/web/test/recipients.test.ts apps/web/test/github.test.ts apps/web/test/registry.test.ts apps/web/test/db.test.ts`
Expected: FAIL.
- `recipients.test.ts` can't resolve `../lib/resolver/recipients`.
- The Sponsors-page, repo-choice and cache-version tests fail.

- [ ] **Step 3: Resolve recipients**

`apps/web/lib/resolver/recipients.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { recipientCache, type RepoRecipients } from "../db/schema";
import { splitCents } from "../funding/split";
import type { RepoRef } from "./github";

export type GithubGet = (path: string) => Promise<{ status: number; body: unknown }>;

const DAY = 24 * 60 * 60 * 1000;
export const RECIPIENT_TTL_MS = 7 * DAY;
const COMMIT_WINDOW_MS = 90 * DAY;
const MAX_COMMITTERS = 5;
const LOGIN = /^[a-z\d][a-z\d-]{0,38}$/;

/** GitHub's REST API. The token is optional; without one GitHub allows 60 requests an hour. */
export function createGithubGet(token: string | undefined, fetchImpl: typeof fetch = fetch): GithubGet {
  return async (path) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "upstream-pay (+https://github.com/iamarunbrahma/upstream)",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

/** The GitHub accounts a FUNDING.yml names: `github: alice`, `github: [alice, bob]`, or a `- alice` list. Lower-cased. */
export function fundingGithubLogins(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const at = lines.findIndex((l) => /^github\s*:/.test(l));
  if (at < 0) return [];
  const value = lines[at]!.replace(/^github\s*:/, "").replace(/#.*$/, "").trim();
  let names: string[] = [];
  if (value.startsWith("[")) names = value.replace(/^\[|\]$/g, "").split(",");
  else if (value) names = [value];
  else {
    for (const line of lines.slice(at + 1)) {
      const m = line.match(/^\s+-\s*([^#]+?)\s*(?:#.*)?$/);
      if (!m) break;
      names.push(m[1]!);
    }
  }
  const clean = names.map((n) => n.trim().replace(/^["']|["']$/g, "").toLowerCase()).filter((n) => LOGIN.test(n));
  return [...new Set(clean)];
}

class TryLater extends Error {}

/** Rate limits and GitHub outages mean "try later"; a refused token is a setup mistake that must not stay quiet. */
function usable(r: { status: number; body: unknown }) {
  if (r.status === 401) throw new Error("GitHub refused the GitHub token (GITHUB_TOKEN). Replace it, or remove it to use GitHub without one.");
  if (r.status === 403 || r.status === 429 || r.status >= 500) throw new TryLater();
  return r;
}

function fileText(body: unknown): string {
  const b = body as { encoding?: string; content?: string } | null;
  return b?.encoding === "base64" && typeof b.content === "string" ? Buffer.from(b.content, "base64").toString("utf8") : "";
}

async function topCommitters(base: string, gh: GithubGet, now: Date): Promise<Array<{ login: string; commits: number }>> {
  const since = new Date(now.getTime() - COMMIT_WINDOW_MS).toISOString();
  const r = usable(await gh(`${base}/commits?since=${encodeURIComponent(since)}&per_page=100`));
  if (r.status !== 200 || !Array.isArray(r.body)) return [];
  const counts = new Map<string, number>();
  for (const c of r.body as Array<{ author?: { login?: string; type?: string } | null }>) {
    const login = c.author?.login?.toLowerCase();
    if (!login || c.author?.type !== "User" || login.endsWith("[bot]")) continue;
    counts.set(login, (counts.get(login) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_COMMITTERS)
    .map(([login, commits]) => ({ login, commits }));
}

/**
 * Who gets a repo's share (spec section 6): the people its FUNDING.yml names, in equal shares, with an
 * organisation's share going to the repo's top 5 human committers of the last 90 days by commit count.
 * Without a usable FUNDING.yml, those committers get it all. "later" means GitHub is rate-limiting or failing.
 */
export async function resolveRecipients(repo: RepoRef, gh: GithubGet, now: Date): Promise<RepoRecipients | "later"> {
  try {
    const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
    const funding = usable(await gh(`${base}/contents/.github/FUNDING.yml`));
    const named = funding.status === 200 ? fundingGithubLogins(fileText(funding.body)) : [];
    const people: string[] = [];
    let orgShares = 0;
    for (const login of named) {
      const account = usable(await gh(`/users/${encodeURIComponent(login)}`));
      if (account.status !== 200) continue; // renamed or deleted
      if ((account.body as { type?: string } | null)?.type === "Organization") orgShares += 1;
      else people.push(login);
    }
    const fromFunding = people.length + orgShares > 0;
    const committers = !fromFunding || orgShares > 0 ? await topCommitters(base, gh, now) : [];
    const commitTotal = committers.reduce((sum, c) => sum + c.commits, 0);

    // Everything on one integer scale: a named person weighs as much as one organisation's whole share.
    const weights = new Map<string, number>();
    const add = (login: string, w: number) => weights.set(login, (weights.get(login) ?? 0) + w);
    if (fromFunding) {
      for (const p of people) add(p, Math.max(commitTotal, 1));
      for (const c of committers) add(c.login, c.commits * orgShares);
    } else {
      for (const c of committers) add(c.login, c.commits);
    }
    const logins = [...weights.keys()];
    const shares = splitCents(10_000, logins.map((l) => weights.get(l)!));
    const recipients = logins.map((login, i) => ({ login, shareBp: shares[i]! })).filter((r) => r.shareBp > 0);
    if (recipients.length === 0) return { source: "none", recipients: [] };
    return { source: fromFunding ? "funding" : "committers", recipients };
  } catch (e) {
    if (e instanceof TryLater) return "later";
    throw e;
  }
}

/** resolveRecipients, remembered for 7 days per repo. While GitHub says "later", an older answer is better than none. */
export async function recipientsFor(db: Db, gh: GithubGet, repo: RepoRef, now: Date): Promise<RepoRecipients | "later"> {
  const key = `${repo.owner}/${repo.name}`;
  const [hit] = await db.select().from(recipientCache).where(eq(recipientCache.repo, key)).limit(1);
  if (hit && now.getTime() - hit.fetchedAt.getTime() < RECIPIENT_TTL_MS) return hit.data;
  const fresh = await resolveRecipients(repo, gh, now);
  if (fresh === "later") return hit?.data ?? "later";
  await db
    .insert(recipientCache)
    .values({ repo: key, data: fresh, fetchedAt: now })
    .onConflictDoUpdate({ target: recipientCache.repo, set: { data: fresh, fetchedAt: now } });
  return fresh;
}
```

- [ ] **Step 4: Stop mistaking Sponsors pages for repos**

Replace `apps/web/lib/resolver/github.ts` with:

```ts
export interface RepoRef {
  owner: string;
  name: string;
}

/** First path parts that are GitHub's own pages, never an owner: a Sponsors link is not a repo. */
const NOT_OWNERS = new Set(["sponsors", "orgs", "users", "apps", "marketplace", "features", "topics", "collections", "settings", "enterprise"]);

/** Owner/repo from the many ways registries spell a GitHub URL. Lower-cased. */
export function parseGithubRepo(url: string | null | undefined): RepoRef | null {
  if (!url) return null;
  const s = url.trim();
  const m =
    s.match(/^github:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i) ??
    s.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i) ??
    (/^[\w.-]+\/[\w.-]+$/.test(s) ? s.match(/^([\w.-]+)\/([\w.-]+)$/) : null);
  if (!m?.[1] || !m[2] || NOT_OWNERS.has(m[1].toLowerCase())) return null;
  return { owner: m[1].toLowerCase(), name: m[2].toLowerCase() };
}
```

In `apps/web/lib/resolver/registry.ts` (`resolvePypi`), replace

```ts
  const repo = entries.map(([, v]) => parseGithubRepo(v)).find((r) => r !== null) ?? null;
```

with

```ts
  // A Source or Repository link names the repo; any other GitHub link (a changelog, a Sponsors page) only might.
  const linked = [...pick(/source|repo|code|github/i), ...entries.filter(([k]) => !/fund|sponsor|donat/i.test(k)).map(([, v]) => v)];
  const repo = linked.map((v) => parseGithubRepo(v)).find((r) => r !== null) ?? null;
```

In `apps/web/lib/resolver/cache.ts`, add this under `CACHE_TTL_MS`:

```ts
/** Bumped when the lookup changes what it would answer, so answers cached before the change are ignored. */
const LOOKUP_VERSION = 2;
```

Then change `const key = \`${ecosystem}:${name}\`;` to `const key = \`v${LOOKUP_VERSION}:${ecosystem}:${name}\`;`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `rm -rf node_modules/.vitest-cache && pnpm test`, then `pnpm --filter web exec tsc --noEmit`
Expected: every test passes (including recipients 9/9), and the typecheck is clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/resolver apps/web/test/recipients.test.ts apps/web/test/github.test.ts apps/web/test/registry.test.ts apps/web/test/db.test.ts
git commit -m "Resolve who gets paid for a repo from FUNDING.yml or recent committers"
```

---

### Task 3: Settle approved receipts into accruals

**Files:**
- Create: `apps/web/lib/funding/settle.ts`, `apps/web/test/settle-fixtures.ts`, `apps/web/test/settle.test.ts`, `apps/web/test/settle-pg.test.ts`
- Modify: `apps/web/lib/db/schema.ts`, `packages/core/src/api.ts`, `apps/web/app/api/receipts/route.ts`, `packages/cli/src/format.ts`

**Interfaces:**
- Consumes: `splitCents`, `balanceCents`, `accruals`, `receipts.settlementId` (Task 1); `RepoRecipients` (Task 1); `RepoRef` (Plan 1).
- Produces:
  - `interface SettleDeps { db; repoFor(ecosystem, name): Promise<RepoRef | null>; recipients(repo): Promise<RepoRecipients | "later">; now?(): Date }`
  - `settle(deps): Promise<SettleSummary>`, where `SettleSummary = { settlementId, expiredReceipts, settledFunders, waitingFunders, setAsideCents }`
  - `MONTHLY_CAP_CENTS` and `PROPOSED_EXPIRY_MS`
  - receipt status `"expired"`
  - the test fixture `settlementWorld()`

- [ ] **Step 1: Write the failing tests**

`apps/web/test/settle-fixtures.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { accruals, maintainers, receiptItems, receipts, type RepoRecipients } from "../lib/db/schema";
import { recordFunding } from "../lib/funding/ledger";
import { FakePayPal } from "../lib/paypal/fake";

export const NOW = new Date("2026-10-14T10:00:00Z");
export const DAY = 86_400_000;

/**
 * A database, a fake PayPal and fake package lookups for settlement tests.
 * npm "a" is paid to alice and bob in halves; npm "b" all to carol. Set `lookups[...]` to change that.
 */
export async function settlementWorld() {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  const paypal = new FakePayPal();
  const lookups: Record<string, RepoRecipients | "later" | null> = {
    "npm:a": { source: "funding", recipients: [{ login: "alice", shareBp: 5000 }, { login: "bob", shareBp: 5000 }] },
    "npm:b": { source: "committers", recipients: [{ login: "carol", shareBp: 10_000 }] },
  };
  let clock = NOW;
  let seq = 0;
  const deps = {
    db,
    paypal,
    repoFor: async (ecosystem: string, name: string) => (lookups[`${ecosystem}:${name}`] === null ? null : { owner: ecosystem, name }),
    recipients: async (repo: { owner: string; name: string }) => lookups[`${repo.owner}:${repo.name}`] ?? { source: "none" as const, recipients: [] },
    now: () => clock,
  };

  const fund = (accountId: string, cents: number, payerId: string | null = null) =>
    recordFunding(db, { accountId, source: "topup", paypalId: `CAP-${++seq}`, amountCents: cents, payerId, occurredAt: clock, raw: null });

  return {
    db,
    paypal,
    lookups,
    deps,
    fund,
    /** Move the clock to `days` after NOW. */
    at: (days: number) => {
      clock = new Date(NOW.getTime() + days * DAY);
    },
    async funder(cents: number, payerId: string | null = null) {
      const { accountId } = await createDevice(db, null);
      if (cents > 0) await fund(accountId, cents, payerId);
      return accountId;
    },
    /** A receipt with these package weights (basis points, adding up to 10000). */
    async receipt(accountId: string, weights: Record<string, number>, status: "approved" | "proposed" = "approved", createdAt = clock) {
      const [r] = await db
        .insert(receipts)
        .values({ accountId, sessionId: `s-${++seq}`, agent: "claude-code", endedAt: createdAt, status, source: "ai", promptVersion: "judge-v2", createdAt })
        .returning({ id: receipts.id });
      await db.insert(receiptItems).values(
        Object.entries(weights).map(([name, weightBp]) => ({
          receiptId: r!.id,
          ecosystem: "npm" as const,
          name,
          weightBp,
          role: "feature",
          reason: "test",
          evidence: { ecosystem: "npm" as const, name, installed: true, manifestAdded: false, importFiles: 1, usageLines: 1, docsReads: 0, kind: "dependency" as const, description: null },
        })),
      );
      return r!.id;
    },
    /** A maintainer who linked this PayPal account `daysAgo` days before the current clock. */
    claim: (login: string, payerId: string, daysAgo: number) =>
      db.insert(maintainers).values({ login, paypalPayerId: payerId, claimedAt: new Date(clock.getTime() - daysAgo * DAY) }),
    /** Cents set aside from this funder, per maintainer and status. */
    async owed(funderId: string, status?: "held" | "queued" | "paid" | "returned") {
      const rows = await db
        .select({ login: accruals.login, status: accruals.status, cents: sql<number>`sum(${accruals.cents})::int` })
        .from(accruals)
        .where(eq(accruals.funderId, funderId))
        .groupBy(accruals.login, accruals.status);
      const out: Record<string, number> = {};
      for (const r of rows) if (!status || r.status === status) out[r.login] = (out[r.login] ?? 0) + r.cents;
      return out;
    },
  };
}
```

`apps/web/test/settle.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { receipts } from "../lib/db/schema";
import { balanceCents } from "../lib/funding/ledger";
import { MONTHLY_CAP_CENTS, settle } from "../lib/funding/settle";
import { decideReceipt, type Deps } from "../lib/receipts/service";
import { DAY, NOW, settlementWorld } from "./settle-fixtures";

let w: Awaited<ReturnType<typeof settlementWorld>>;
beforeEach(async () => {
  w = await settlementWorld();
});
const settledBy = async (id: string) => (await w.db.select({ s: receipts.settlementId }).from(receipts).where(eq(receipts.id, id)))[0]!.s;

describe("settle", () => {
  it("splits the whole budget across approved receipts, then across each package's maintainers, to the cent", async () => {
    const f = await w.funder(1350);
    const r1 = await w.receipt(f, { a: 6000, b: 4000 });
    const r2 = await w.receipt(f, { a: 10_000 });
    const run = await settle(w.deps);
    expect(await w.owed(f)).toEqual({ alice: 540, bob: 540, carol: 270 });
    expect(await balanceCents(w.db, f)).toBe(0);
    expect(await settledBy(r1)).toBe(run.settlementId);
    expect(await settledBy(r2)).toBe(run.settlementId);
    expect(run).toMatchObject({ settledFunders: 1, waitingFunders: 0, setAsideCents: 1350 });
  });

  it("settles each receipt once, even when it runs twice", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await settle(w.deps);
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({ carol: 1000 });
  });

  it("keeps a package's share in the budget when nobody can be paid for it", async () => {
    w.lookups["npm:orphan"] = null;
    w.lookups["npm:nobody"] = { source: "none", recipients: [] };
    const f = await w.funder(900);
    const r = await w.receipt(f, { b: 3400, orphan: 3300, nobody: 3300 });
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({ carol: 306 });
    expect(await balanceCents(w.db, f)).toBe(594);
    expect(await settledBy(r)).not.toBeNull();
  });

  it("waits for GitHub instead of guessing, and settles on a later run", async () => {
    w.lookups["npm:b"] = "later";
    const f = await w.funder(500);
    const r = await w.receipt(f, { a: 5000, b: 5000 });
    expect(await settle(w.deps)).toMatchObject({ settledFunders: 0, waitingFunders: 1 });
    expect(await w.owed(f)).toEqual({});
    expect(await settledBy(r)).toBeNull();
    w.lookups["npm:b"] = { source: "committers", recipients: [{ login: "carol", shareBp: 10_000 }] };
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({ alice: 125, bob: 125, carol: 250 });
  });

  it("waits for money: approved receipts with an empty budget are settled once money arrives", async () => {
    const f = await w.funder(0);
    const r = await w.receipt(f, { b: 10_000 });
    await settle(w.deps);
    expect(await settledBy(r)).toBeNull();
    await w.fund(f, 700);
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({ carol: 700 });
  });

  it("never sets aside more than $100 a month from one funder for one maintainer", async () => {
    const f = await w.funder(30_000);
    await w.receipt(f, { b: 10_000 });
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({ carol: MONTHLY_CAP_CENTS });
    expect(await balanceCents(w.db, f)).toBe(20_000);

    await w.receipt(f, { b: 10_000 });
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({ carol: MONTHLY_CAP_CENTS });

    w.at(19); // 2 November: a new month
    await w.receipt(f, { b: 10_000 });
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({ carol: 2 * MONTHLY_CAP_CENTS });
  });

  it("only spends each funder's own budget", async () => {
    const rich = await w.funder(1000);
    const poor = await w.funder(100);
    await w.receipt(rich, { b: 10_000 });
    await w.receipt(poor, { a: 10_000 });
    await settle(w.deps);
    expect(await w.owed(rich)).toEqual({ carol: 1000 });
    expect(await w.owed(poor)).toEqual({ alice: 50, bob: 50 });
  });

  it("drops receipts nobody approved within 14 days, and they can't be approved afterwards", async () => {
    const f = await w.funder(500);
    const stale = await w.receipt(f, { b: 10_000 }, "proposed", new Date(NOW.getTime() - 15 * DAY));
    const fresh = await w.receipt(f, { b: 10_000 }, "proposed", new Date(NOW.getTime() - 13 * DAY));
    expect((await settle(w.deps)).expiredReceipts).toBe(1);
    const status = async (id: string) => (await w.db.select({ s: receipts.status }).from(receipts).where(eq(receipts.id, id)))[0]!.s;
    expect(await status(stale)).toBe("expired");
    expect(await status(fresh)).toBe("proposed");
    const view = await decideReceipt({ db: w.db } as unknown as Deps, f, stale, "approve");
    expect(view?.status).toBe("expired");
    expect(await w.owed(f)).toEqual({});
  });
});
```

`apps/web/test/settle-pg.test.ts` is skipped unless `TEST_DATABASE_URL` is set. Task 8 runs it.

```ts
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { accruals, receiptItems, receipts } from "../lib/db/schema";
import { recordFunding } from "../lib/funding/ledger";
import { settle } from "../lib/funding/settle";

/**
 * PGlite runs one transaction at a time, so only real Postgres can show two settlement runs overlapping.
 * TEST_DATABASE_URL must point at a throwaway database: this test wipes its public schema.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("settle on Postgres", () => {
  it("spends a budget once when two runs overlap", async () => {
    const db = createPgDb(url!);
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await db.execute(sql`create schema public`);
    await migrateDb(db, "pg");
    const { accountId } = await createDevice(db, null);
    await recordFunding(db, { accountId, source: "topup", paypalId: "CAP-PG", amountCents: 1000, payerId: null, occurredAt: new Date(), raw: null });
    const [r] = await db
      .insert(receipts)
      .values({ accountId, sessionId: "s-pg", agent: "claude-code", endedAt: new Date(), status: "approved", source: "ai", promptVersion: "judge-v2" })
      .returning({ id: receipts.id });
    await db.insert(receiptItems).values({
      receiptId: r!.id,
      ecosystem: "npm",
      name: "b",
      weightBp: 10_000,
      role: "feature",
      reason: "test",
      evidence: { ecosystem: "npm", name: "b", installed: true, manifestAdded: false, importFiles: 1, usageLines: 1, docsReads: 0, kind: "dependency", description: null },
    });
    const deps = {
      db,
      repoFor: async () => ({ owner: "o", name: "b" }),
      recipients: async () => ({ source: "committers" as const, recipients: [{ login: "carol", shareBp: 10_000 }] }),
    };
    await Promise.all([settle(deps), settle(deps), settle(deps)]);
    const [row] = await db.select({ total: sql<string>`coalesce(sum(${accruals.cents}), 0)` }).from(accruals).where(eq(accruals.funderId, accountId));
    expect(Number(row!.total)).toBe(1000);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `rm -rf node_modules/.vitest-cache && pnpm test apps/web/test/settle.test.ts`
Expected: FAIL, because `../lib/funding/settle` can't be resolved.

- [ ] **Step 3: Let receipts expire**

In `apps/web/lib/db/schema.ts`, the receipts `status` enum becomes `["proposed", "approved", "skipped", "expired"]`.

In `packages/core/src/api.ts`:

```ts
export type ReceiptStatus = "proposed" | "approved" | "skipped" | "expired";
```

In `apps/web/app/api/receipts/route.ts`, the query enum becomes `z.enum(["proposed", "approved", "skipped", "expired"]).optional()`.

In `packages/cli/src/format.ts`:

```ts
const STATUS = {
  proposed: "Waiting for your approval.",
  approved: "Approved.",
  skipped: "Skipped.",
  expired: "Not approved within 14 days, so it won't be paid.",
} as const;
```

`decideReceipt` already changes only `proposed` receipts, so an expired one can't be approved later.

- [ ] **Step 4: Settle**

`apps/web/lib/funding/settle.ts`:

```ts
import type { Ecosystem } from "@upstream/core";
import { and, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals, receiptItems, receipts, settlements, type RepoRecipients } from "../db/schema";
import type { RepoRef } from "../resolver/github";
import { balanceCents } from "./ledger";
import { splitCents } from "./split";

const DAY = 24 * 60 * 60 * 1000;
/** Proposed receipts nobody approved within this long are dropped (spec section 7, spending rule). */
export const PROPOSED_EXPIRY_MS = 14 * DAY;
/** Self-dealing control: one funder sets aside at most this much for one maintainer per calendar month (UTC). */
export const MONTHLY_CAP_CENTS = 10_000;
/** Postgres advisory lock that keeps two settlement runs from spending the same budget. */
const SETTLE_LOCK = 7_340_211;

export interface SettleDeps {
  db: Db;
  /** The package's GitHub repo, or null when it has none (Plan 1's cached registry lookup). */
  repoFor: (ecosystem: Ecosystem, name: string) => Promise<RepoRef | null>;
  /** Who gets the repo's share, or "later" while GitHub is rate-limiting (cached GitHub lookup). */
  recipients: (repo: RepoRef) => Promise<RepoRecipients | "later">;
  now?: () => Date;
}

export interface SettleSummary {
  settlementId: string;
  expiredReceipts: number;
  /** Funders whose approved receipts were settled in this run. */
  settledFunders: number;
  /** Funders left for a later run: GitHub said "later", or their budget was empty. */
  waitingFunders: number;
  setAsideCents: number;
}

type Lookup = RepoRecipients | "later" | null;
const keyOf = (ecosystem: string, name: string) => `${ecosystem}:${name}`;

/** Looks up every package that unsettled approved receipts mention. Network calls happen here, outside the lock. */
async function lookUpPackages(deps: SettleDeps): Promise<Map<string, Lookup>> {
  const pkgs = await deps.db
    .selectDistinct({ ecosystem: receiptItems.ecosystem, name: receiptItems.name })
    .from(receiptItems)
    .innerJoin(receipts, eq(receipts.id, receiptItems.receiptId))
    .where(and(eq(receipts.status, "approved"), isNull(receipts.settlementId)));
  const found = new Map<string, Lookup>();
  for (const p of pkgs) {
    const repo = await deps.repoFor(p.ecosystem, p.name);
    found.set(keyOf(p.ecosystem, p.name), repo ? await deps.recipients(repo) : null);
  }
  return found;
}

/**
 * Spends one funder's whole unspent budget on their approved, not-yet-settled receipts:
 * across packages by summed receipt weight, then across each package's recipients by share,
 * both with largest-remainder rounding. A share with nobody to receive it, or over the monthly cap,
 * stays in the budget. Returns null when the funder has to wait for a later run.
 */
async function settleFunder(tx: Db, settlementId: string, funderId: string, found: Map<string, Lookup>, now: Date): Promise<number | null> {
  const open = await tx
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.accountId, funderId), eq(receipts.status, "approved"), isNull(receipts.settlementId)));
  if (open.length === 0) return 0;
  const items = await tx
    .select({ ecosystem: receiptItems.ecosystem, name: receiptItems.name, weightBp: receiptItems.weightBp })
    .from(receiptItems)
    .where(inArray(receiptItems.receiptId, open.map((r) => r.id)));
  const weights = new Map<string, { ecosystem: Ecosystem; name: string; bp: number }>();
  for (const i of items) {
    const k = keyOf(i.ecosystem, i.name);
    const w = weights.get(k) ?? { ecosystem: i.ecosystem, name: i.name, bp: 0 };
    w.bp += i.weightBp;
    weights.set(k, w);
  }
  const pkgs = [...weights.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (pkgs.some(([k]) => !found.has(k) || found.get(k) === "later")) return null;
  const budget = await balanceCents(tx, funderId);
  if (budget <= 0) return null;

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const sofar = await tx
    .select({ login: accruals.login, cents: sql<string>`sum(${accruals.cents})` })
    .from(accruals)
    .where(and(eq(accruals.funderId, funderId), gte(accruals.createdAt, monthStart), ne(accruals.status, "returned")))
    .groupBy(accruals.login);
  const given = new Map(sofar.map((r) => [r.login, Number(r.cents)]));

  const perPkg = splitCents(budget, pkgs.map(([, w]) => w.bp));
  const rows: Array<typeof accruals.$inferInsert> = [];
  pkgs.forEach(([k, w], i) => {
    const who = found.get(k) as RepoRecipients | null;
    if (!who || who.recipients.length === 0 || perPkg[i] === 0) return;
    const parts = splitCents(perPkg[i]!, who.recipients.map((r) => r.shareBp));
    who.recipients.forEach((r, j) => {
      const room = Math.max(0, MONTHLY_CAP_CENTS - (given.get(r.login) ?? 0));
      const cents = Math.min(parts[j]!, room);
      if (cents <= 0) return;
      given.set(r.login, (given.get(r.login) ?? 0) + cents);
      rows.push({ settlementId, funderId, login: r.login, ecosystem: w.ecosystem, name: w.name, cents, createdAt: now });
    });
  });
  if (rows.length > 0) await tx.insert(accruals).values(rows);
  await tx.update(receipts).set({ settlementId }).where(inArray(receipts.id, open.map((r) => r.id)));
  return rows.reduce((sum, r) => sum + r.cents, 0);
}

/** One settlement run: drops stale proposals, then settles every funder with approved receipts. Safe to run twice. */
export async function settle(deps: SettleDeps): Promise<SettleSummary> {
  const now = deps.now?.() ?? new Date();
  const found = await lookUpPackages(deps);
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETTLE_LOCK})`);
    const [run] = await tx.insert(settlements).values({ createdAt: now }).returning({ id: settlements.id });
    const expired = await tx
      .update(receipts)
      .set({ status: "expired", updatedAt: now })
      .where(and(eq(receipts.status, "proposed"), lt(receipts.createdAt, new Date(now.getTime() - PROPOSED_EXPIRY_MS))))
      .returning({ id: receipts.id });
    const funders = await tx
      .selectDistinct({ id: receipts.accountId })
      .from(receipts)
      .where(and(eq(receipts.status, "approved"), isNull(receipts.settlementId)));
    const summary: SettleSummary = { settlementId: run!.id, expiredReceipts: expired.length, settledFunders: 0, waitingFunders: 0, setAsideCents: 0 };
    for (const f of funders) {
      const cents = await settleFunder(tx as unknown as Db, run!.id, f.id, found, now);
      if (cents === null) summary.waitingFunders += 1;
      else {
        summary.settledFunders += 1;
        summary.setAsideCents += cents;
      }
    }
    return summary;
  });
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `rm -rf node_modules/.vitest-cache && pnpm test`, then `pnpm --filter web exec tsc --noEmit` and `pnpm --filter upstream-pay exec tsc --noEmit`
Expected:
- settle 8/8, and the rest pass
- `settle-pg.test.ts` is reported as skipped
- both typechecks are clean

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/funding/settle.ts apps/web/lib/db/schema.ts packages/core/src/api.ts apps/web/app/api/receipts/route.ts packages/cli/src/format.ts apps/web/test/settle-fixtures.ts apps/web/test/settle.test.ts apps/web/test/settle-pg.test.ts
git commit -m "Settle approved receipts into per-maintainer accruals"
```

---

### Task 4: Pay claimed maintainers through PayPal Payouts

**Files:**
- Create: `apps/web/lib/funding/payouts.ts`, `apps/web/test/payouts.test.ts`
- Modify: `apps/web/lib/paypal/api.ts`, `apps/web/lib/paypal/fake.ts`, `apps/web/lib/funding/settle.ts`, `apps/web/test/paypal-client.test.ts`

**Interfaces:**
- Consumes: `settle` (Task 3), `maintainers`, `payoutItems`, `settlements` (Task 1), `PayPalError` (Plan 2a).
- Produces:
  - `PayPalApi.createPayoutBatch(senderBatchId, lines: PayoutLine[]): Promise<PaypalPayoutBatch>` and `PayPalApi.getPayoutBatch(batchId): Promise<PaypalPayoutBatch>`
  - the types `PayoutLine`, `PaypalPayoutItem` and `PaypalPayoutBatch`
  - on `FakePayPal`: `payoutBatches`, `loseNextAnswer(method)` and `setPayoutItemStatus(senderItemId, status)`
  - `queuePayouts(tx, settlementId, now): Promise<QueueSummary>` and `payOut(deps: PayoutDeps): Promise<SendResult[]>`
  - `MIN_PAYOUT_CENTS`, `FIRST_PAYOUT_HOLD_MS` and `UNCLAIMED_RETURN_MS`
  - `SettleSummary` now extends `QueueSummary { returnedCents, payoutLines, queuedCents }`

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/paypal-client.test.ts`, inside `describe("createPayPalApi"`, before "treats missing webhook headers...", add:

```ts
  it("builds the Payouts requests PayPal expects, paying verified PayPal accounts by id", async () => {
    const f = fakeFetch([
      token,
      { status: 201, body: { batch_header: { payout_batch_id: "B-1", batch_status: "PENDING", sender_batch_header: { sender_batch_id: "settle-1" } } } },
      { status: 200, body: { batch_header: { payout_batch_id: "B-1", batch_status: "SUCCESS" }, items: [{ payout_item_id: "PI-1", transaction_status: "SUCCESS" }] } },
    ]);
    const api = createPayPalApi(createPayPalHttp({ clientId: "id", clientSecret: "s", baseUrl: "https://api.test", fetchImpl: f.impl }));
    const sent = await api.createPayoutBatch("settle-1", [{ senderItemId: "line-1", payerId: "PAYER-A", cents: 540, note: "For your work on fastapi" }]);
    const got = await api.getPayoutBatch("B-1");
    expect(sent.batch_header.payout_batch_id).toBe("B-1");
    expect(got.items?.[0]?.transaction_status).toBe("SUCCESS");
    expect(JSON.parse(String(f.calls[1]!.init.body))).toMatchObject({
      sender_batch_header: { sender_batch_id: "settle-1" },
      items: [{ recipient_type: "PAYPAL_ID", receiver: "PAYER-A", amount: { value: "5.40", currency: "USD" }, sender_item_id: "line-1", note: "For your work on fastapi" }],
    });
    expect(f.calls[1]!.url).toBe("https://api.test/v1/payments/payouts");
    expect(f.calls[2]!.url).toBe("https://api.test/v1/payments/payouts/B-1?page_size=1000");
  });
```

`apps/web/test/payouts.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accruals, settlements } from "../lib/db/schema";
import { balanceCents } from "../lib/funding/ledger";
import { FIRST_PAYOUT_HOLD_MS, payOut } from "../lib/funding/payouts";
import { settle } from "../lib/funding/settle";
import { PayPalError } from "../lib/paypal/client";
import { DAY, settlementWorld } from "./settle-fixtures";

let w: Awaited<ReturnType<typeof settlementWorld>>;
beforeEach(async () => {
  w = await settlementWorld();
});
const run = async () => {
  const s = await settle(w.deps);
  return { ...s, sent: await payOut(w.deps) };
};
const batches = () => [...w.paypal.payoutBatches.values()];

describe("payOut", () => {
  it("pays each claimed maintainer on one line, in one PayPal batch named after the settlement", async () => {
    const f = await w.funder(1350);
    await w.receipt(f, { a: 6000, b: 4000 });
    await w.receipt(f, { a: 10_000 });
    await w.claim("alice", "PAYER-ALICE", 8);
    await w.claim("bob", "PAYER-BOB", 8);
    const r = await run();
    expect(r).toMatchObject({ payoutLines: 2, queuedCents: 1080 });
    expect(batches()).toHaveLength(1);
    expect(batches()[0]!.senderBatchId).toBe(r.settlementId);
    expect(batches()[0]!.items.map((i) => [i.payout_item?.receiver, i.payout_item?.amount?.value])).toEqual([
      ["PAYER-ALICE", "5.40"],
      ["PAYER-BOB", "5.40"],
    ]);
    expect(await w.owed(f, "queued")).toEqual({ alice: 540, bob: 540 });
    expect(await w.owed(f, "held")).toEqual({ carol: 270 });
    const [s] = await w.db.select().from(settlements).where(eq(settlements.id, r.settlementId));
    expect(s!.payoutBatchId).toBe(batches()[0]!.id);
  });

  it("sends a settlement's batch once, even when PayPal's answer was lost", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await w.claim("carol", "PAYER-CAROL", 8);
    await settle(w.deps);
    w.paypal.loseNextAnswer("createPayoutBatch");
    expect((await payOut(w.deps))[0]).toMatchObject({ outcome: "failed" });
    expect((await payOut(w.deps))[0]).toMatchObject({ outcome: "sent-before" });
    expect(await payOut(w.deps)).toEqual([]);
    expect(batches()).toHaveLength(1);
  });

  it("tries again on the next run when PayPal fails before taking the batch", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await w.claim("carol", "PAYER-CAROL", 8);
    await settle(w.deps);
    w.paypal.failNext("createPayoutBatch", new PayPalError(503, "SERVICE_UNAVAILABLE", "try later", null));
    expect((await payOut(w.deps))[0]).toMatchObject({ outcome: "failed" });
    expect(batches()).toHaveLength(0);
    expect((await payOut(w.deps))[0]).toMatchObject({ outcome: "sent" });
    expect(batches()).toHaveLength(1);
  });

  it("carries amounts under $1 over until they add up", async () => {
    const f = await w.funder(60);
    await w.receipt(f, { b: 10_000 });
    await w.claim("carol", "PAYER-CAROL", 8);
    expect(await run()).toMatchObject({ payoutLines: 0 });
    expect(await w.owed(f, "held")).toEqual({ carol: 60 });
    await w.fund(f, 50);
    await w.receipt(f, { b: 10_000 });
    expect(await run()).toMatchObject({ payoutLines: 1, queuedCents: 110 });
  });

  it("waits 7 days after a maintainer links PayPal before their first payout", async () => {
    expect(FIRST_PAYOUT_HOLD_MS).toBe(7 * DAY);
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await w.claim("carol", "PAYER-CAROL", 2);
    expect(await run()).toMatchObject({ payoutLines: 0 });
    w.at(5);
    expect(await run()).toMatchObject({ payoutLines: 1, queuedCents: 1000 });
  });

  it("never pays a funder's money to the funder's own PayPal account", async () => {
    const f = await w.funder(1000, "PAYER-SAME");
    await w.receipt(f, { a: 10_000 });
    await w.claim("alice", "PAYER-SAME", 8);
    await w.claim("bob", "PAYER-BOB", 8);
    const r = await run();
    expect(r).toMatchObject({ payoutLines: 1, queuedCents: 500, returnedCents: 500 });
    expect(await w.owed(f, "returned")).toEqual({ alice: 500 });
    expect(await balanceCents(w.db, f)).toBe(500);
    const [back] = await w.db.select().from(accruals).where(eq(accruals.login, "alice"));
    expect(back!.returnReason).toBe("same-person");
  });

  it("gives unclaimed money back to the funder after 90 days, to be given again", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await run();
    w.at(89);
    expect(await run()).toMatchObject({ returnedCents: 0 });
    w.at(91);
    expect(await run()).toMatchObject({ returnedCents: 1000 });
    expect(await w.owed(f, "returned")).toEqual({ carol: 1000 });
    expect(await balanceCents(w.db, f)).toBe(1000);
    await w.receipt(f, { a: 10_000 });
    await run();
    expect(await w.owed(f, "held")).toEqual({ alice: 500, bob: 500 });
  });

  it("still pays a maintainer who claimed in time but is in the hold when the 90 days end", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await run();
    w.at(89);
    await w.claim("carol", "PAYER-CAROL", 0);
    w.at(91);
    expect(await run()).toMatchObject({ returnedCents: 0, payoutLines: 0 });
    w.at(97);
    expect(await run()).toMatchObject({ payoutLines: 1, queuedCents: 1000 });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `rm -rf node_modules/.vitest-cache && pnpm test apps/web/test/payouts.test.ts apps/web/test/paypal-client.test.ts`
Expected: FAIL.
- `../lib/funding/payouts` can't be resolved.
- The Payouts request test fails: `createPayoutBatch` is not a function.

- [ ] **Step 3: The Payouts API and its fake**

Replace `apps/web/lib/paypal/api.ts` with:

```ts
import type { PayPalHttp } from "./client";
import { fromCents } from "./money";

export interface Money {
  currency_code: string;
  value: string;
}

export interface PaypalSubscription {
  id: string;
  status: string;
  plan_id?: string;
  custom_id?: string;
  start_time?: string;
  subscriber?: { payer_id?: string; email_address?: string };
}

export interface PaypalSubscriptionTxn {
  id: string;
  status: string;
  time?: string;
  amount_with_breakdown?: { gross_amount?: Money; net_amount?: Money };
}

export interface PaypalCapture {
  id: string;
  status: string;
  custom_id?: string;
  create_time?: string;
  amount?: Money;
  seller_receivable_breakdown?: { gross_amount?: Money; net_amount?: Money };
}

export interface PaypalOrder {
  id: string;
  status: string;
  payer?: { payer_id?: string };
  purchase_units?: Array<{ custom_id?: string; payments?: { captures?: PaypalCapture[] } }>;
}

/** One Payouts line: `cents` to the PayPal account `payerId`. `senderItemId` is our own id for the line. */
export interface PayoutLine {
  senderItemId: string;
  payerId: string;
  cents: number;
  note: string;
}

/** Payouts amounts use `currency`, not `currency_code` like the rest of the API. */
export interface PayoutMoney {
  currency: string;
  value: string;
}

export interface PaypalPayoutItem {
  payout_item_id?: string;
  transaction_status?: string;
  payout_batch_id?: string;
  payout_item_fee?: PayoutMoney;
  payout_item?: { recipient_type?: string; receiver?: string; sender_item_id?: string; amount?: PayoutMoney };
}

export interface PaypalPayoutBatch {
  batch_header: { payout_batch_id: string; batch_status: string; sender_batch_header?: { sender_batch_id?: string } };
  items?: PaypalPayoutItem[];
}

export interface WebhookVerification {
  headers: Record<string, string | null>;
  webhookId: string;
  event: unknown;
}

export interface PayPalApi {
  findProductByName(name: string): Promise<{ id: string } | null>;
  createProduct(name: string, description: string): Promise<{ id: string }>;
  listPlans(productId: string): Promise<Array<{ id: string; name: string; status: string }>>;
  createPlan(productId: string, name: string, monthlyCents: number): Promise<{ id: string }>;
  createSubscription(planId: string, customId: string): Promise<PaypalSubscription>;
  getSubscription(id: string): Promise<PaypalSubscription>;
  listSubscriptionTransactions(id: string, startIso: string, endIso: string): Promise<PaypalSubscriptionTxn[]>;
  createOrder(cents: number, customId: string, description: string): Promise<PaypalOrder>;
  getOrder(id: string): Promise<PaypalOrder>;
  captureOrder(id: string): Promise<PaypalOrder>;
  verifyWebhookSignature(input: WebhookVerification): Promise<boolean>;
  /** PayPal refuses a second batch with the same `senderBatchId`, which is what makes sending safe to repeat. */
  createPayoutBatch(senderBatchId: string, lines: PayoutLine[]): Promise<PaypalPayoutBatch>;
  getPayoutBatch(batchId: string): Promise<PaypalPayoutBatch>;
}

const WEBHOOK_HEADERS = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"] as const;

export function createPayPalApi(http: PayPalHttp): PayPalApi {
  const id = (s: string) => encodeURIComponent(s);
  return {
    async findProductByName(name) {
      const res = await http.request<{ products?: Array<{ id: string; name: string }> }>("GET", "/v1/catalogs/products?page_size=20");
      return res.products?.find((p) => p.name === name) ?? null;
    },
    createProduct(name, description) {
      return http.request("POST", "/v1/catalogs/products", { name, description, type: "SERVICE", category: "SOFTWARE" });
    },
    async listPlans(productId) {
      const res = await http.request<{ plans?: Array<{ id: string; name: string; status: string }> }>(
        "GET",
        `/v1/billing/plans?product_id=${id(productId)}&page_size=20`,
      );
      return res.plans ?? [];
    },
    createPlan(productId, name, monthlyCents) {
      return http.request("POST", "/v1/billing/plans", {
        product_id: productId,
        name,
        status: "ACTIVE",
        billing_cycles: [
          {
            frequency: { interval_unit: "MONTH", interval_count: 1 },
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: { fixed_price: { value: fromCents(monthlyCents), currency_code: "USD" } },
          },
        ],
        payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: "CONTINUE", payment_failure_threshold: 3 },
      });
    },
    createSubscription(planId, customId) {
      return http.request("POST", "/v1/billing/subscriptions", {
        plan_id: planId,
        custom_id: customId,
        application_context: { brand_name: "Upstream", shipping_preference: "NO_SHIPPING", user_action: "SUBSCRIBE_NOW" },
      });
    },
    getSubscription(subId) {
      return http.request("GET", `/v1/billing/subscriptions/${id(subId)}`);
    },
    async listSubscriptionTransactions(subId, startIso, endIso) {
      const q = `start_time=${encodeURIComponent(startIso)}&end_time=${encodeURIComponent(endIso)}`;
      const res = await http.request<{ transactions?: PaypalSubscriptionTxn[] }>("GET", `/v1/billing/subscriptions/${id(subId)}/transactions?${q}`);
      return res.transactions ?? [];
    },
    createOrder(cents, customId, description) {
      return http.request("POST", "/v2/checkout/orders", {
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: fromCents(cents) }, custom_id: customId, description }],
      });
    },
    getOrder(orderId) {
      return http.request("GET", `/v2/checkout/orders/${id(orderId)}`);
    },
    captureOrder(orderId) {
      return http.request("POST", `/v2/checkout/orders/${id(orderId)}/capture`, {});
    },
    async verifyWebhookSignature({ headers, webhookId, event }) {
      const h = Object.fromEntries(WEBHOOK_HEADERS.map((k) => [k, headers[k] ?? null]));
      if (WEBHOOK_HEADERS.some((k) => !h[k])) return false;
      const res = await http.request<{ verification_status?: string }>("POST", "/v1/notifications/verify-webhook-signature", {
        auth_algo: h["paypal-auth-algo"],
        cert_url: h["paypal-cert-url"],
        transmission_id: h["paypal-transmission-id"],
        transmission_sig: h["paypal-transmission-sig"],
        transmission_time: h["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: event,
      });
      return res.verification_status === "SUCCESS";
    },
    createPayoutBatch(senderBatchId, lines) {
      return http.request("POST", "/v1/payments/payouts", {
        sender_batch_header: {
          sender_batch_id: senderBatchId,
          email_subject: "You've received money from Upstream",
          email_message: "Developers whose AI coding agents used your open-source work are saying thanks.",
        },
        items: lines.map((l) => ({
          recipient_type: "PAYPAL_ID",
          receiver: l.payerId,
          amount: { value: fromCents(l.cents), currency: "USD" },
          sender_item_id: l.senderItemId,
          note: l.note,
        })),
      });
    },
    getPayoutBatch(batchId) {
      return http.request("GET", `/v1/payments/payouts/${id(batchId)}?page_size=1000`);
    },
  };
}
```

Replace `apps/web/lib/paypal/fake.ts` with:

```ts
import type { PayoutLine, PayPalApi, PaypalOrder, PaypalPayoutItem, PaypalSubscription, PaypalSubscriptionTxn, WebhookVerification } from "./api";
import { PayPalError } from "./client";
import { fromCents } from "./money";

/** In-memory stand-in for PayPal, used by tests. Mirrors the response shapes the real API returns. */
export class FakePayPal implements PayPalApi {
  calls: string[] = [];
  signatureValid = true;
  products = new Map<string, { id: string; name: string }>();
  plans = new Map<string, { id: string; name: string; status: string; productId: string; cents: number }>();
  subscriptions = new Map<string, PaypalSubscription & { transactions: PaypalSubscriptionTxn[] }>();
  orders = new Map<string, PaypalOrder & { cents: number; approvedBy: string | null }>();
  payoutBatches = new Map<string, { id: string; senderBatchId: string; status: string; items: PaypalPayoutItem[] }>();
  private failures = new Map<string, Error>();
  private lostAnswers = new Set<string>();
  private seq = 0;

  private next(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  private enter(method: string): void {
    this.calls.push(method);
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
  }

  /** Make the next call to `method` throw `error`. */
  failNext(method: keyof PayPalApi, error: Error): void {
    this.failures.set(method, error);
  }

  /** The next call to `method` takes effect at PayPal, but its answer never arrives (a timeout). */
  loseNextAnswer(method: keyof PayPalApi): void {
    this.lostAnswers.add(method);
  }

  private answer<T>(method: string, value: T): T {
    if (this.lostAnswers.delete(method)) throw new PayPalError(504, "TIMEOUT", "PayPal took too long to answer", null);
    return value;
  }

  async findProductByName(name: string) {
    this.enter("findProductByName");
    return [...this.products.values()].find((p) => p.name === name) ?? null;
  }

  async createProduct(name: string) {
    this.enter("createProduct");
    const p = { id: this.next("PROD-"), name };
    this.products.set(p.id, p);
    return { id: p.id };
  }

  async listPlans(productId: string) {
    this.enter("listPlans");
    return [...this.plans.values()].filter((p) => p.productId === productId).map(({ id, name, status }) => ({ id, name, status }));
  }

  async createPlan(productId: string, name: string, monthlyCents: number) {
    this.enter("createPlan");
    const p = { id: this.next("P-"), name, status: "ACTIVE", productId, cents: monthlyCents };
    this.plans.set(p.id, p);
    return { id: p.id };
  }

  async createSubscription(planId: string, customId: string) {
    this.enter("createSubscription");
    const s = { id: this.next("I-"), status: "APPROVAL_PENDING", plan_id: planId, custom_id: customId, transactions: [] };
    this.subscriptions.set(s.id, s);
    return { id: s.id, status: s.status, plan_id: planId, custom_id: customId };
  }

  /** The buyer approves in the PayPal popup; PayPal activates and takes the first payment. */
  approveSubscription(id: string, payerId: string, firstNetCents = 453): void {
    const s = this.subscriptions.get(id)!;
    s.status = "ACTIVE";
    s.start_time = "2026-10-14T10:00:00Z";
    s.subscriber = { payer_id: payerId };
    this.addSubscriptionPayment(id, this.next("SALE-"), firstNetCents);
  }

  addSubscriptionPayment(id: string, txnId: string, netCents: number, status = "COMPLETED"): void {
    this.subscriptions.get(id)!.transactions.push({
      id: txnId,
      status,
      time: "2026-10-14T10:00:05Z",
      amount_with_breakdown: {
        gross_amount: { currency_code: "USD", value: fromCents(netCents + 47) },
        net_amount: { currency_code: "USD", value: fromCents(netCents) },
      },
    });
  }

  async getSubscription(id: string) {
    this.enter("getSubscription");
    const s = this.subscriptions.get(id);
    if (!s) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "subscription not found", null);
    const { transactions: _t, ...rest } = s;
    return rest;
  }

  async listSubscriptionTransactions(id: string) {
    this.enter("listSubscriptionTransactions");
    const s = this.subscriptions.get(id);
    // Like the real sandbox: listing transactions of a subscription that was never approved is a 404.
    if (!s || s.status === "APPROVAL_PENDING") throw new PayPalError(404, "INVALID_RESOURCE_ID", "The specified resource does not exist.", null);
    return [...s.transactions];
  }

  async createOrder(cents: number, customId: string) {
    this.enter("createOrder");
    const o = { id: this.next("ORDER-"), status: "CREATED", cents, approvedBy: null, purchase_units: [{ custom_id: customId }] };
    this.orders.set(o.id, o);
    return { id: o.id, status: o.status, purchase_units: o.purchase_units };
  }

  approveOrder(id: string, payerId: string): void {
    const o = this.orders.get(id)!;
    o.status = "APPROVED";
    o.approvedBy = payerId;
  }

  async getOrder(id: string) {
    this.enter("getOrder");
    const o = this.orders.get(id);
    if (!o) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "order not found", null);
    return { id: o.id, status: o.status, payer: o.approvedBy ? { payer_id: o.approvedBy } : undefined, purchase_units: o.purchase_units };
  }

  async captureOrder(id: string) {
    this.enter("captureOrder");
    const o = this.orders.get(id);
    if (!o) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "order not found", null);
    if (o.status === "COMPLETED") throw new PayPalError(422, "ORDER_ALREADY_CAPTURED", "Order already captured", null);
    if (o.status !== "APPROVED") throw new PayPalError(422, "ORDER_NOT_APPROVED", "Payer has not approved the order", null);
    o.status = "COMPLETED";
    const net = o.cents - Math.round(o.cents * 0.0349) - 49;
    o.purchase_units = [
      {
        custom_id: o.purchase_units?.[0]?.custom_id,
        payments: {
          captures: [
            {
              id: this.next("CAP-"),
              status: "COMPLETED",
              custom_id: o.purchase_units?.[0]?.custom_id,
              create_time: "2026-10-14T10:00:00Z",
              amount: { currency_code: "USD", value: fromCents(o.cents) },
              seller_receivable_breakdown: {
                gross_amount: { currency_code: "USD", value: fromCents(o.cents) },
                net_amount: { currency_code: "USD", value: fromCents(net) },
              },
            },
          ],
        },
      },
    ];
    return this.getOrder(id);
  }

  async verifyWebhookSignature(input: WebhookVerification) {
    this.enter("verifyWebhookSignature");
    return this.signatureValid && Boolean(input.headers["paypal-transmission-sig"]);
  }

  async createPayoutBatch(senderBatchId: string, lines: PayoutLine[]) {
    this.enter("createPayoutBatch");
    // Like the real API: the same sender_batch_id twice is refused, whatever the request id.
    if ([...this.payoutBatches.values()].some((b) => b.senderBatchId === senderBatchId)) {
      throw new PayPalError(400, "Batch with given sender_batch_id already exists", "User business error.", null);
    }
    const id = this.next("BATCH-");
    const items = lines.map((l) => ({
      payout_item_id: this.next("PI-"),
      transaction_status: "PENDING",
      payout_batch_id: id,
      payout_item_fee: { currency: "USD", value: "0.25" },
      payout_item: { recipient_type: "PAYPAL_ID", receiver: l.payerId, sender_item_id: l.senderItemId, amount: { currency: "USD", value: fromCents(l.cents) } },
    }));
    this.payoutBatches.set(id, { id, senderBatchId, status: "PENDING", items });
    return this.answer("createPayoutBatch", { batch_header: { payout_batch_id: id, batch_status: "PENDING", sender_batch_header: { sender_batch_id: senderBatchId } } });
  }

  async getPayoutBatch(id: string) {
    this.enter("getPayoutBatch");
    const b = this.payoutBatches.get(id);
    if (!b) throw new PayPalError(404, "INVALID_RESOURCE_ID", "batch not found", null);
    return { batch_header: { payout_batch_id: b.id, batch_status: b.status }, items: b.items.map((i) => structuredClone(i)) };
  }

  /** PayPal finishes (or fails) one payout line. */
  setPayoutItemStatus(senderItemId: string, status: string): PaypalPayoutItem {
    for (const b of this.payoutBatches.values()) {
      const item = b.items.find((i) => i.payout_item?.sender_item_id === senderItemId);
      if (item) {
        item.transaction_status = status;
        b.status = b.items.every((i) => i.transaction_status !== "PENDING") ? "SUCCESS" : "PROCESSING";
        return structuredClone(item);
      }
    }
    throw new Error(`no payout line ${senderItemId}`);
  }
}
```

- [ ] **Step 4: Queue and send payouts**

`apps/web/lib/funding/payouts.ts` (Task 6 adds the refund take-back to it):

```ts
import { and, eq, isNotNull, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals, fundingEvents, maintainers, payoutItems, settlements, subscriptions } from "../db/schema";
import type { PayPalApi } from "../paypal/api";
import { PayPalError } from "../paypal/client";

const DAY = 24 * 60 * 60 * 1000;
/** A maintainer is paid once they're owed at least this much; below it, money carries over (spec section 7). */
export const MIN_PAYOUT_CENTS = 100;
/** Self-dealing control: a new maintainer's first payout waits this long after they link PayPal. */
export const FIRST_PAYOUT_HOLD_MS = 7 * DAY;
/** Money nobody claimed in this long goes back into the funder's budget. */
export const UNCLAIMED_RETURN_MS = 90 * DAY;

export interface QueueSummary {
  returnedCents: number;
  payoutLines: number;
  queuedCents: number;
}

const total = (rows: Array<{ cents: number }>) => rows.reduce((sum, r) => sum + r.cents, 0);

/**
 * Runs inside the settlement's locked transaction. Gives money back to funders when it sat unclaimed for
 * 90 days, or when it would go to the funder's own PayPal account. Then puts everything held for each
 * maintainer who linked PayPal at least 7 days ago, and is owed $1 or more, on one payout line.
 */
export async function queuePayouts(tx: Db, settlementId: string, now: Date): Promise<QueueSummary> {
  const claimed = tx.select({ login: maintainers.login }).from(maintainers).where(isNotNull(maintainers.paypalPayerId));
  const unclaimed = await tx
    .update(accruals)
    .set({ status: "returned", returnReason: "unclaimed" })
    .where(and(eq(accruals.status, "held"), lt(accruals.createdAt, new Date(now.getTime() - UNCLAIMED_RETURN_MS)), notInArray(accruals.login, claimed)))
    .returning({ cents: accruals.cents });
  // The funder's PayPal accounts are the payers on their own payments and subscriptions.
  const samePerson = await tx
    .update(accruals)
    .set({ status: "returned", returnReason: "same-person" })
    .where(
      and(
        eq(accruals.status, "held"),
        sql`exists (
          select 1 from ${maintainers} m
          where m.login = ${accruals.login} and m.paypal_payer_id is not null and (
            exists (select 1 from ${fundingEvents} f where f.account_id = ${accruals.funderId} and f.payer_id = m.paypal_payer_id)
            or exists (select 1 from ${subscriptions} s where s.account_id = ${accruals.funderId} and s.payer_id = m.paypal_payer_id)
          )
        )`,
      ),
    )
    .returning({ cents: accruals.cents });

  const ready = await tx
    .select({ login: maintainers.login, payerId: maintainers.paypalPayerId, cents: sql<string>`sum(${accruals.cents})` })
    .from(accruals)
    .innerJoin(maintainers, eq(maintainers.login, accruals.login))
    .where(and(eq(accruals.status, "held"), isNotNull(maintainers.paypalPayerId), lte(maintainers.claimedAt, new Date(now.getTime() - FIRST_PAYOUT_HOLD_MS))))
    .groupBy(maintainers.login, maintainers.paypalPayerId)
    .having(sql`sum(${accruals.cents}) >= ${MIN_PAYOUT_CENTS}`)
    .orderBy(maintainers.login);
  let queuedCents = 0;
  for (const r of ready) {
    const cents = Number(r.cents);
    const [line] = await tx.insert(payoutItems).values({ settlementId, login: r.login, payerId: r.payerId!, cents, updatedAt: now }).returning({ id: payoutItems.id });
    await tx.update(accruals).set({ status: "queued", payoutItemId: line!.id }).where(and(eq(accruals.status, "held"), eq(accruals.login, r.login)));
    queuedCents += cents;
  }
  return { returnedCents: total(unclaimed) + total(samePerson), payoutLines: ready.length, queuedCents };
}

export interface PayoutDeps {
  db: Db;
  paypal: PayPalApi;
}

export interface SendResult {
  settlementId: string;
  /** sent: PayPal took the batch. sent-before: PayPal already has it, from an earlier try whose answer was lost. */
  outcome: "sent" | "sent-before" | "failed";
  batchId?: string;
  error?: string;
}

const isDuplicateBatch = (e: unknown) => e instanceof PayPalError && e.status === 400 && /sender_batch_id already exists/i.test(`${e.code} ${e.message}`);

async function lineNote(db: Db, lineId: string): Promise<string> {
  const rows = await db.selectDistinct({ name: accruals.name }).from(accruals).where(eq(accruals.payoutItemId, lineId)).orderBy(accruals.name);
  const names = rows.map((r) => r.name);
  const shown = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
  return `Thanks for ${shown}. AI coding agents used it, and their developers chose to pay you through Upstream.`;
}

/**
 * Sends each settlement's payout lines that PayPal hasn't taken yet, as one batch whose sender_batch_id is the
 * settlement id. PayPal refuses that id twice, so repeating this never pays twice. A failure leaves the lines
 * for the next run.
 */
export async function payOut(deps: PayoutDeps): Promise<SendResult[]> {
  const waiting = await deps.db
    .selectDistinct({ id: settlements.id })
    .from(settlements)
    .innerJoin(payoutItems, eq(payoutItems.settlementId, settlements.id))
    .where(and(isNull(settlements.payoutBatchId), isNull(settlements.batchStatus)));
  const results: SendResult[] = [];
  for (const { id } of waiting) {
    const lines = await deps.db.select().from(payoutItems).where(eq(payoutItems.settlementId, id)).orderBy(payoutItems.login);
    try {
      const notes = await Promise.all(lines.map((l) => lineNote(deps.db, l.id)));
      const batch = await deps.paypal.createPayoutBatch(
        id,
        lines.map((l, i) => ({ senderItemId: l.id, payerId: l.payerId, cents: l.cents, note: notes[i]! })),
      );
      await deps.db
        .update(settlements)
        .set({ payoutBatchId: batch.batch_header.payout_batch_id, batchStatus: batch.batch_header.batch_status })
        .where(eq(settlements.id, id));
      results.push({ settlementId: id, outcome: "sent", batchId: batch.batch_header.payout_batch_id });
    } catch (e) {
      if (isDuplicateBatch(e)) {
        // PayPal has this batch but we never heard its id. Its payout webhooks carry the id and fill it in.
        await deps.db.update(settlements).set({ batchStatus: "UNKNOWN" }).where(eq(settlements.id, id));
        results.push({ settlementId: id, outcome: "sent-before" });
      } else if (e instanceof PayPalError) {
        results.push({ settlementId: id, outcome: "failed", error: `${e.status} ${e.code}` });
      } else {
        throw e;
      }
    }
  }
  return results;
}
```

In `apps/web/lib/funding/settle.ts`:
1. Import `queuePayouts` and the `QueueSummary` type from `./payouts`.
2. Make `SettleSummary` extend `QueueSummary`.
3. Build `summary` as a plain object, without the `SettleSummary` annotation.
4. Change the transaction's final `return summary;` to:

```ts
    return { ...summary, ...(await queuePayouts(tx as unknown as Db, run!.id, now)) };
```

5. Replace the comment above `settle` with:

```ts
/**
 * One settlement run: drops stale proposals, settles every funder with approved receipts, then puts what's
 * owed on payout lines (sent by payOut). Safe to run twice: each receipt and each accrual is spent once.
 */
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `rm -rf node_modules/.vitest-cache && pnpm test`, then `pnpm --filter web exec tsc --noEmit`
Expected: payouts 8/8, every other test passes, and the typecheck is clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/paypal/api.ts apps/web/lib/paypal/fake.ts apps/web/lib/funding/payouts.ts apps/web/lib/funding/settle.ts apps/web/test/paypal-client.test.ts apps/web/test/payouts.test.ts
git commit -m "Pay claimed maintainers through PayPal Payouts with self-dealing controls"
```

---

### Task 5: Payout line status from webhooks and batch reads

**Files:**
- Create: `apps/web/lib/funding/payout-status.ts`, `apps/web/test/payout-status.test.ts`
- Modify: `apps/web/lib/funding/webhooks.ts`

**Interfaces:**
- Consumes: `payOut`, `PayoutDeps` (Task 4), `PaypalPayoutItem` (Task 4), `handleWebhook` (Plan 2a).
- Produces:
  - `applyPayoutItem(db, item): Promise<"payout line updated" | "unknown payout line" | "ignored">`
  - `reconcilePayouts(deps: PayoutDeps): Promise<number>`
  - `PAYMENT.PAYOUTS-ITEM.*` webhooks are applied.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/payout-status.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accruals, payoutItems, settlements } from "../lib/db/schema";
import { balanceCents } from "../lib/funding/ledger";
import { reconcilePayouts } from "../lib/funding/payout-status";
import { payOut } from "../lib/funding/payouts";
import { settle } from "../lib/funding/settle";
import { handleWebhook } from "../lib/funding/webhooks";
import { settlementWorld } from "./settle-fixtures";

const SIGNED = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT",
  "paypal-transmission-id": "t-1",
  "paypal-transmission-sig": "sig",
  "paypal-transmission-time": "2026-10-14T10:00:00Z",
};

let w: Awaited<ReturnType<typeof settlementWorld>>;
let funder: string;
beforeEach(async () => {
  w = await settlementWorld();
  funder = await w.funder(1000);
  await w.receipt(funder, { b: 10_000 });
  await w.claim("carol", "PAYER-CAROL", 8);
});
const line = async () => (await w.db.select().from(payoutItems).orderBy(payoutItems.updatedAt))[0]!;
const webhook = (id: string, type: string, resource: unknown) =>
  handleWebhook({ db: w.db, paypal: w.paypal, planIds: {}, webhookId: "WH-1" }, new Headers(SIGNED), JSON.stringify({ id, event_type: type, resource }));

describe("payout status", () => {
  it("marks a maintainer's money paid once PayPal confirms the line, and records PayPal's fee", async () => {
    await settle(w.deps);
    await payOut(w.deps);
    w.paypal.setPayoutItemStatus((await line()).id, "SUCCESS");
    expect(await reconcilePayouts(w.deps)).toBe(1);
    expect(await w.owed(funder, "paid")).toEqual({ carol: 1000 });
    expect(await line()).toMatchObject({ status: "SUCCESS", feeCents: 25 });
    expect(await reconcilePayouts(w.deps)).toBe(0);
  });

  it("puts bounced money back on hold, and pays it on a later run", async () => {
    await settle(w.deps);
    await payOut(w.deps);
    w.paypal.setPayoutItemStatus((await line()).id, "RETURNED");
    await reconcilePayouts(w.deps);
    expect(await w.owed(funder, "held")).toEqual({ carol: 1000 });
    const [a] = await w.db.select().from(accruals);
    expect(a!.payoutItemId).toBeNull();
    expect(await balanceCents(w.db, funder)).toBe(0);
    await settle(w.deps);
    await payOut(w.deps);
    expect(w.paypal.payoutBatches.size).toBe(2);
    expect(await w.owed(funder, "queued")).toEqual({ carol: 1000 });
  });

  it("updates from a verified payout webhook, once, and learns a batch id PayPal never sent back", async () => {
    await settle(w.deps);
    w.paypal.loseNextAnswer("createPayoutBatch");
    await payOut(w.deps);
    await payOut(w.deps);
    const [before] = await w.db.select().from(settlements);
    expect(before).toMatchObject({ payoutBatchId: null, batchStatus: "UNKNOWN" });

    const item = w.paypal.setPayoutItemStatus((await line()).id, "SUCCESS");
    expect(await webhook("E1", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", item)).toEqual({ status: 200, outcome: "payout line updated" });
    expect(await webhook("E1", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", item)).toEqual({ status: 200, outcome: "duplicate" });
    expect(await w.owed(funder, "paid")).toEqual({ carol: 1000 });
    const [after] = await w.db.select().from(settlements).where(eq(settlements.id, before!.id));
    expect(after!.payoutBatchId).toBe(item.payout_batch_id);
  });

  it("ignores payout events for lines it didn't send, or that name another batch", async () => {
    await settle(w.deps);
    await payOut(w.deps);
    const real = w.paypal.setPayoutItemStatus((await line()).id, "SUCCESS");
    const stranger = { ...real, payout_item: { ...real.payout_item, sender_item_id: "8a1c2b3d-0000-4000-8000-000000000000" } };
    expect((await webhook("E1", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", stranger)).outcome).toBe("unknown payout line");
    expect((await webhook("E2", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", { ...real, payout_batch_id: "BATCH-OTHER" })).outcome).toBe("unknown payout line");
    expect((await webhook("E3", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", { payout_item: { sender_item_id: "not-a-line" } })).outcome).toBe("ignored");
    expect(await w.owed(funder, "paid")).toEqual({});
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `rm -rf node_modules/.vitest-cache && pnpm test apps/web/test/payout-status.test.ts`
Expected: FAIL, because `../lib/funding/payout-status` can't be resolved.

- [ ] **Step 3: Apply payout statuses**

`apps/web/lib/funding/payout-status.ts`:

```ts
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { accruals, payoutItems, settlements } from "../db/schema";
import type { PaypalPayoutItem } from "../paypal/api";
import { toCents } from "../paypal/money";
import type { PayoutDeps } from "./payouts";

/** PayPal paid the line. */
const PAID = ["SUCCESS"];
/** The money didn't arrive, or came back: it's held again, to be paid on a later run or returned after 90 days. */
const BOUNCED = ["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED"];
const FINAL = [...PAID, ...BOUNCED];

/**
 * Applies PayPal's status for one payout line, from a webhook or from reading the batch. The line must be one
 * we sent, in the batch PayPal names. Applying the same status again changes nothing.
 */
export async function applyPayoutItem(db: Db, item: PaypalPayoutItem): Promise<"payout line updated" | "unknown payout line" | "ignored"> {
  const id = z.uuid().safeParse(item.payout_item?.sender_item_id);
  if (!id.success || !item.transaction_status) return "ignored";
  const [line] = await db
    .select({ id: payoutItems.id, settlementId: payoutItems.settlementId, batchId: settlements.payoutBatchId })
    .from(payoutItems)
    .innerJoin(settlements, eq(settlements.id, payoutItems.settlementId))
    .where(eq(payoutItems.id, id.data))
    .limit(1);
  if (!line) return "unknown payout line";
  if (item.payout_batch_id && line.batchId && item.payout_batch_id !== line.batchId) return "unknown payout line";
  if (item.payout_batch_id && !line.batchId) {
    await db.update(settlements).set({ payoutBatchId: item.payout_batch_id }).where(eq(settlements.id, line.settlementId));
  }
  const fee = item.payout_item_fee?.currency === "USD" ? toCents(item.payout_item_fee.value) : null;
  await db
    .update(payoutItems)
    .set({ status: item.transaction_status, paypalItemId: item.payout_item_id ?? null, feeCents: fee, updatedAt: new Date() })
    .where(eq(payoutItems.id, line.id));
  if (PAID.includes(item.transaction_status)) {
    await db.update(accruals).set({ status: "paid" }).where(and(eq(accruals.payoutItemId, line.id), eq(accruals.status, "queued")));
  } else if (BOUNCED.includes(item.transaction_status)) {
    await db
      .update(accruals)
      .set({ status: "held", payoutItemId: null })
      .where(and(eq(accruals.payoutItemId, line.id), inArray(accruals.status, ["queued", "paid"])));
  }
  return "payout line updated";
}

/** Reads every sent batch that still has unfinished lines, for when webhooks can't reach us. Returns lines updated. */
export async function reconcilePayouts(deps: PayoutDeps): Promise<number> {
  const open = await deps.db
    .selectDistinct({ id: settlements.id, batchId: settlements.payoutBatchId })
    .from(settlements)
    .innerJoin(payoutItems, eq(payoutItems.settlementId, settlements.id))
    .where(isNotNull(settlements.payoutBatchId));
  let updated = 0;
  for (const s of open) {
    const lines = await deps.db.select({ status: payoutItems.status }).from(payoutItems).where(eq(payoutItems.settlementId, s.id));
    if (lines.every((l) => FINAL.includes(l.status))) continue;
    const batch = await deps.paypal.getPayoutBatch(s.batchId!);
    await deps.db.update(settlements).set({ batchStatus: batch.batch_header.batch_status }).where(eq(settlements.id, s.id));
    for (const item of batch.items ?? []) {
      if ((await applyPayoutItem(deps.db, { ...item, payout_batch_id: item.payout_batch_id ?? s.batchId! })) === "payout line updated") updated += 1;
    }
  }
  return updated;
}
```

In `apps/web/lib/funding/webhooks.ts`:
1. Import `type PaypalPayoutItem` from `../paypal/api`, and `applyPayoutItem` from `./payout-status`.
2. In `dispatch`, after the `PAYMENT.CAPTURE.COMPLETED` line, add:

```ts
  if (type.startsWith("PAYMENT.PAYOUTS-ITEM.")) return applyPayoutItem(deps.db, r as PaypalPayoutItem);
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `rm -rf node_modules/.vitest-cache && pnpm test`, then `pnpm --filter web exec tsc --noEmit`
Expected: payout-status 4/4, webhooks unchanged, and every test passes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/funding/payout-status.ts apps/web/lib/funding/webhooks.ts apps/web/test/payout-status.test.ts
git commit -m "Track payout line status from webhooks and batch reads"
```

---

### Task 6: Refunds and reversals

**Files:**
- Create: `apps/web/lib/funding/refunds.ts`, `apps/web/test/refunds.test.ts`
- Modify: `apps/web/lib/funding/webhooks.ts`, `apps/web/lib/funding/payouts.ts`

**Interfaces:**
- Consumes: `fundingEvents.refundOf` (Task 1), `balanceCents` (Task 1), `queuePayouts` (Task 4).
- Produces:
  - `REFUND_EVENTS`
  - `recordRefund(db, type, resource): Promise<"refund recorded" | "already recorded" | "unknown payment" | "ignored">`
  - `queuePayouts` takes back unpaid money from a funder below zero (return reason `"refunded"`).

- [ ] **Step 1: Write the failing tests**

`apps/web/test/refunds.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { balanceCents, fundedCents, recordFunding } from "../lib/funding/ledger";
import { settle } from "../lib/funding/settle";
import { handleWebhook } from "../lib/funding/webhooks";
import { settlementWorld } from "./settle-fixtures";

const SIGNED = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT",
  "paypal-transmission-id": "t-1",
  "paypal-transmission-sig": "sig",
  "paypal-transmission-time": "2026-10-14T10:00:00Z",
};

let w: Awaited<ReturnType<typeof settlementWorld>>;
let n = 0;
beforeEach(async () => {
  w = await settlementWorld();
});
const webhook = (type: string, resource: unknown) =>
  handleWebhook({ db: w.db, paypal: w.paypal, planIds: {}, webhookId: "WH-1" }, new Headers(SIGNED), JSON.stringify({ id: `E-${++n}`, event_type: type, resource }));

/** The shape PayPal's sandbox returned for a capture refund on 14 Oct 2026. */
const captureRefund = (id: string, captureId: string, value: string, accountId: string) => ({
  id,
  amount: { currency_code: "USD", value },
  seller_payable_breakdown: { gross_amount: { currency_code: "USD", value }, paypal_fee: { currency_code: "USD", value: "0.00" }, net_amount: { currency_code: "USD", value } },
  custom_id: accountId,
  status: "COMPLETED",
  create_time: "2026-10-14T01:30:09-07:00",
  links: [
    { href: `https://api.sandbox.paypal.com/v2/payments/refunds/${id}`, rel: "self", method: "GET" },
    { href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}`, rel: "up", method: "GET" },
  ],
});
const topup = (accountId: string, captureId: string, cents: number) =>
  recordFunding(w.db, { accountId, source: "topup", paypalId: captureId, amountCents: cents, payerId: "PAYER-F", occurredAt: new Date(), raw: null });

describe("refunds and reversals", () => {
  it("take a refunded top-up back out of the budget, once", async () => {
    const f = await w.funder(0);
    await topup(f, "CAP-1", 1000);
    const refund = captureRefund("REF-1", "CAP-1", "4.00", f);
    expect((await webhook("PAYMENT.CAPTURE.REFUNDED", refund)).outcome).toBe("refund recorded");
    expect((await webhook("PAYMENT.CAPTURE.REFUNDED", refund)).outcome).toBe("already recorded");
    expect(await fundedCents(w.db, f)).toBe(600);
  });

  it("never take back more than the payment added to the budget", async () => {
    const f = await w.funder(0);
    await topup(f, "CAP-1", 916);
    expect((await webhook("PAYMENT.CAPTURE.REFUNDED", captureRefund("REF-1", "CAP-1", "10.00", f))).outcome).toBe("refund recorded");
    expect((await webhook("PAYMENT.CAPTURE.REVERSED", captureRefund("REF-2", "CAP-1", "10.00", f))).outcome).toBe("already recorded");
    expect(await fundedCents(w.db, f)).toBe(0);
  });

  it("handle subscription refunds and reversals, which name the sale their own way", async () => {
    const f = await w.funder(0);
    await recordFunding(w.db, { accountId: f, source: "subscription", paypalId: "SALE-1", amountCents: 453, payerId: "PAYER-F", occurredAt: new Date(), raw: null });
    await recordFunding(w.db, { accountId: f, source: "subscription", paypalId: "SALE-2", amountCents: 453, payerId: "PAYER-F", occurredAt: new Date(), raw: null });
    expect((await webhook("PAYMENT.SALE.REFUNDED", { id: "R-9", sale_id: "SALE-1", amount: { total: "2.00", currency: "USD" }, state: "completed" })).outcome).toBe(
      "refund recorded",
    );
    expect((await webhook("PAYMENT.SALE.REVERSED", { id: "SALE-2", amount: { total: "-5.00", currency: "USD" }, state: "reversed" })).outcome).toBe("refund recorded");
    expect(await fundedCents(w.db, f)).toBe(453 - 200);
  });

  it("take back money not yet paid out when the payment is refunded after a settlement", async () => {
    const f = await w.funder(0);
    await topup(f, "CAP-1", 1000);
    await w.receipt(f, { b: 10_000 });
    await settle(w.deps);
    expect(await w.owed(f, "held")).toEqual({ carol: 1000 });
    await webhook("PAYMENT.CAPTURE.REFUNDED", captureRefund("REF-1", "CAP-1", "4.00", f));
    expect(await balanceCents(w.db, f)).toBe(-400);
    await w.claim("carol", "PAYER-CAROL", 8);
    expect(await settle(w.deps)).toMatchObject({ returnedCents: 1000, payoutLines: 0 });
    expect(await w.owed(f, "returned")).toEqual({ carol: 1000 });
    expect(await balanceCents(w.db, f)).toBe(600);
  });

  it("ignore refunds of payments they don't know, and anything that isn't USD", async () => {
    const f = await w.funder(0);
    await topup(f, "CAP-1", 1000);
    expect((await webhook("PAYMENT.CAPTURE.REFUNDED", captureRefund("REF-1", "CAP-UNKNOWN", "1.00", f))).outcome).toBe("unknown payment");
    expect((await webhook("PAYMENT.CAPTURE.REFUNDED", { ...captureRefund("REF-2", "CAP-1", "1.00", f), amount: { currency_code: "EUR", value: "1.00" } })).outcome).toBe("ignored");
    expect((await webhook("PAYMENT.CAPTURE.REFUNDED", { id: "REF-3" })).outcome).toBe("ignored");
    expect(await fundedCents(w.db, f)).toBe(1000);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `rm -rf node_modules/.vitest-cache && pnpm test apps/web/test/refunds.test.ts`
Expected: FAIL (5 tests). The refund events come back `"ignored"`, so nothing is taken back.

- [ ] **Step 3: Record refunds**

`apps/web/lib/funding/refunds.ts`:

```ts
import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { fundingEvents } from "../db/schema";
import { toCents } from "../paypal/money";

export const REFUND_EVENTS = ["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED", "PAYMENT.SALE.REFUNDED", "PAYMENT.SALE.REVERSED"];

type Resource = Record<string, unknown>;

/** The sale or capture a refund takes money from: `sale_id` (v1), or the "up" / "sale" link (v2 and v1). */
function refundedPaymentId(type: string, r: Resource): string | null {
  if (typeof r.sale_id === "string") return r.sale_id;
  for (const link of Array.isArray(r.links) ? (r.links as Array<{ rel?: unknown; href?: unknown }>) : []) {
    if ((link.rel === "up" || link.rel === "sale") && typeof link.href === "string") {
      const m = link.href.match(/\/(?:captures|sale)\/([A-Za-z0-9-]+)$/);
      if (m) return m[1]!;
    }
  }
  // A reversed sale can arrive as the sale itself.
  return type === "PAYMENT.SALE.REVERSED" && typeof r.id === "string" ? r.id : null;
}

/** The refunded amount in cents: v2 uses { value, currency_code }, v1 { total, currency }, sometimes negative. */
function refundCents(r: Resource): number {
  const a = r.amount as { value?: unknown; total?: unknown; currency_code?: unknown; currency?: unknown } | undefined;
  const value = a?.value ?? a?.total;
  if ((a?.currency_code ?? a?.currency) !== "USD" || typeof value !== "string") return 0;
  return toCents(value.replace(/^-/, ""));
}

/**
 * Takes refunded or reversed money back out of the funder's budget, as a negative funding event. Never takes
 * back more than the payment added, however many refunds name it. The same refund twice is recorded once.
 */
export async function recordRefund(db: Db, type: string, r: Resource): Promise<"refund recorded" | "already recorded" | "unknown payment" | "ignored"> {
  const refundId = typeof r.id === "string" ? r.id : null;
  const paymentId = refundedPaymentId(type, r);
  const cents = refundCents(r);
  if (!refundId || !paymentId || cents <= 0) return "ignored";
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${paymentId}))`);
    const [payment] = await tx
      .select()
      .from(fundingEvents)
      .where(and(eq(fundingEvents.paypalId, paymentId), ne(fundingEvents.source, "refund")))
      .limit(1);
    if (!payment) return "unknown payment";
    const [prior] = await tx
      .select({ total: sql<string>`coalesce(sum(${fundingEvents.amountCents}), 0)` })
      .from(fundingEvents)
      .where(eq(fundingEvents.refundOf, paymentId));
    const left = payment.amountCents + Number(prior?.total ?? 0);
    const take = Math.min(cents, Math.max(left, 0));
    if (take === 0) return "already recorded";
    const rows = await tx
      .insert(fundingEvents)
      .values({
        paypalId: `refund:${refundId}`,
        accountId: payment.accountId,
        source: "refund",
        refundOf: paymentId,
        amountCents: -take,
        payerId: null,
        occurredAt: typeof r.create_time === "string" ? new Date(r.create_time) : new Date(),
        raw: r,
      })
      .onConflictDoNothing({ target: fundingEvents.paypalId })
      .returning({ id: fundingEvents.paypalId });
    return rows.length > 0 ? "refund recorded" : "already recorded";
  });
}
```

In `apps/web/lib/funding/webhooks.ts`:
1. Import `recordRefund` and `REFUND_EVENTS` from `./refunds`.
2. In `dispatch`, after the payout-item line, add:

```ts
  if (REFUND_EVENTS.includes(type)) return recordRefund(deps.db, type, r);
```

- [ ] **Step 4: Take back unpaid money after a refund**

Replace `apps/web/lib/funding/payouts.ts` with:

```ts
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals, fundingEvents, maintainers, payoutItems, settlements, subscriptions } from "../db/schema";
import type { PayPalApi } from "../paypal/api";
import { PayPalError } from "../paypal/client";
import { balanceCents } from "./ledger";

const DAY = 24 * 60 * 60 * 1000;
/** A maintainer is paid once they're owed at least this much; below it, money carries over (spec section 7). */
export const MIN_PAYOUT_CENTS = 100;
/** Self-dealing control: a new maintainer's first payout waits this long after they link PayPal. */
export const FIRST_PAYOUT_HOLD_MS = 7 * DAY;
/** Money nobody claimed in this long goes back into the funder's budget. */
export const UNCLAIMED_RETURN_MS = 90 * DAY;

export interface QueueSummary {
  returnedCents: number;
  payoutLines: number;
  queuedCents: number;
}

const total = (rows: Array<{ cents: number }>) => rows.reduce((sum, r) => sum + r.cents, 0);

/**
 * Runs inside the settlement's locked transaction. Gives money back to funders when it sat unclaimed for
 * 90 days, or when it would go to the funder's own PayPal account. Then puts everything held for each
 * maintainer who linked PayPal at least 7 days ago, and is owed $1 or more, on one payout line.
 */
export async function queuePayouts(tx: Db, settlementId: string, now: Date): Promise<QueueSummary> {
  const refunded = await takeBackRefunded(tx);
  const claimed = tx.select({ login: maintainers.login }).from(maintainers).where(isNotNull(maintainers.paypalPayerId));
  const unclaimed = await tx
    .update(accruals)
    .set({ status: "returned", returnReason: "unclaimed" })
    .where(and(eq(accruals.status, "held"), lt(accruals.createdAt, new Date(now.getTime() - UNCLAIMED_RETURN_MS)), notInArray(accruals.login, claimed)))
    .returning({ cents: accruals.cents });
  // The funder's PayPal accounts are the payers on their own payments and subscriptions.
  const samePerson = await tx
    .update(accruals)
    .set({ status: "returned", returnReason: "same-person" })
    .where(
      and(
        eq(accruals.status, "held"),
        sql`exists (
          select 1 from ${maintainers} m
          where m.login = ${accruals.login} and m.paypal_payer_id is not null and (
            exists (select 1 from ${fundingEvents} f where f.account_id = ${accruals.funderId} and f.payer_id = m.paypal_payer_id)
            or exists (select 1 from ${subscriptions} s where s.account_id = ${accruals.funderId} and s.payer_id = m.paypal_payer_id)
          )
        )`,
      ),
    )
    .returning({ cents: accruals.cents });

  const ready = await tx
    .select({ login: maintainers.login, payerId: maintainers.paypalPayerId, cents: sql<string>`sum(${accruals.cents})` })
    .from(accruals)
    .innerJoin(maintainers, eq(maintainers.login, accruals.login))
    .where(and(eq(accruals.status, "held"), isNotNull(maintainers.paypalPayerId), lte(maintainers.claimedAt, new Date(now.getTime() - FIRST_PAYOUT_HOLD_MS))))
    .groupBy(maintainers.login, maintainers.paypalPayerId)
    .having(sql`sum(${accruals.cents}) >= ${MIN_PAYOUT_CENTS}`)
    .orderBy(maintainers.login);
  let queuedCents = 0;
  for (const r of ready) {
    const cents = Number(r.cents);
    const [line] = await tx.insert(payoutItems).values({ settlementId, login: r.login, payerId: r.payerId!, cents, updatedAt: now }).returning({ id: payoutItems.id });
    await tx.update(accruals).set({ status: "queued", payoutItemId: line!.id }).where(and(eq(accruals.status, "held"), eq(accruals.login, r.login)));
    queuedCents += cents;
  }
  return { returnedCents: refunded + total(unclaimed) + total(samePerson), payoutLines: ready.length, queuedCents };
}

/** A refund after a settlement can leave a funder below zero. Take back their money not yet paid out, newest first. */
async function takeBackRefunded(tx: Db): Promise<number> {
  const funders = await tx.selectDistinct({ id: accruals.funderId }).from(accruals).where(eq(accruals.status, "held"));
  let returned = 0;
  for (const f of funders) {
    let short = -(await balanceCents(tx, f.id));
    if (short <= 0) continue;
    const held = await tx
      .select({ id: accruals.id, cents: accruals.cents })
      .from(accruals)
      .where(and(eq(accruals.funderId, f.id), eq(accruals.status, "held")))
      .orderBy(desc(accruals.createdAt), desc(accruals.cents));
    const ids: string[] = [];
    for (const a of held) {
      if (short <= 0) break;
      ids.push(a.id);
      short -= a.cents;
    }
    if (ids.length === 0) continue;
    const back = await tx.update(accruals).set({ status: "returned", returnReason: "refunded" }).where(inArray(accruals.id, ids)).returning({ cents: accruals.cents });
    returned += total(back);
  }
  return returned;
}

export interface PayoutDeps {
  db: Db;
  paypal: PayPalApi;
}

export interface SendResult {
  settlementId: string;
  /** sent: PayPal took the batch. sent-before: PayPal already has it, from an earlier try whose answer was lost. */
  outcome: "sent" | "sent-before" | "failed";
  batchId?: string;
  error?: string;
}

const isDuplicateBatch = (e: unknown) => e instanceof PayPalError && e.status === 400 && /sender_batch_id already exists/i.test(`${e.code} ${e.message}`);

async function lineNote(db: Db, lineId: string): Promise<string> {
  const rows = await db.selectDistinct({ name: accruals.name }).from(accruals).where(eq(accruals.payoutItemId, lineId)).orderBy(accruals.name);
  const names = rows.map((r) => r.name);
  const shown = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
  return `Thanks for ${shown}. AI coding agents used it, and their developers chose to pay you through Upstream.`;
}

/**
 * Sends each settlement's payout lines that PayPal hasn't taken yet, as one batch whose sender_batch_id is the
 * settlement id. PayPal refuses that id twice, so repeating this never pays twice. A failure leaves the lines
 * for the next run.
 */
export async function payOut(deps: PayoutDeps): Promise<SendResult[]> {
  const waiting = await deps.db
    .selectDistinct({ id: settlements.id })
    .from(settlements)
    .innerJoin(payoutItems, eq(payoutItems.settlementId, settlements.id))
    .where(and(isNull(settlements.payoutBatchId), isNull(settlements.batchStatus)));
  const results: SendResult[] = [];
  for (const { id } of waiting) {
    const lines = await deps.db.select().from(payoutItems).where(eq(payoutItems.settlementId, id)).orderBy(payoutItems.login);
    try {
      const notes = await Promise.all(lines.map((l) => lineNote(deps.db, l.id)));
      const batch = await deps.paypal.createPayoutBatch(
        id,
        lines.map((l, i) => ({ senderItemId: l.id, payerId: l.payerId, cents: l.cents, note: notes[i]! })),
      );
      await deps.db
        .update(settlements)
        .set({ payoutBatchId: batch.batch_header.payout_batch_id, batchStatus: batch.batch_header.batch_status })
        .where(eq(settlements.id, id));
      results.push({ settlementId: id, outcome: "sent", batchId: batch.batch_header.payout_batch_id });
    } catch (e) {
      if (isDuplicateBatch(e)) {
        // PayPal has this batch but we never heard its id. Its payout webhooks carry the id and fill it in.
        await deps.db.update(settlements).set({ batchStatus: "UNKNOWN" }).where(eq(settlements.id, id));
        results.push({ settlementId: id, outcome: "sent-before" });
      } else if (e instanceof PayPalError) {
        results.push({ settlementId: id, outcome: "failed", error: `${e.status} ${e.code}` });
      } else {
        throw e;
      }
    }
  }
  return results;
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `rm -rf node_modules/.vitest-cache && pnpm test`, then `pnpm --filter web exec tsc --noEmit`
Expected: refunds 5/5, payouts still 8/8, and every test passes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/funding/refunds.ts apps/web/lib/funding/webhooks.ts apps/web/lib/funding/payouts.ts apps/web/test/refunds.test.ts
git commit -m "Take refunds and reversals back out of the budget"
```

---

### Task 7: The settlement job, "Settle now" and a sandbox claim

**Files:**
- Create: `apps/web/lib/funding/run.ts`, `apps/web/app/api/settle/route.ts`, `apps/web/jobs/settle.ts`, `apps/web/scripts/claim-maintainer.ts`, `apps/web/test/run.test.ts`
- Modify: `apps/web/app/api/me/route.ts`, `apps/web/app/dashboard/FundingPanel.tsx`, `apps/web/package.json`, `apps/web/.env.example`, `apps/web/test/settings.test.ts`

**Interfaces:**
- Consumes: `settle` (Tasks 3 and 4), `payOut` (Task 4), `reconcilePayouts` (Task 5), `resolveWithCache` (Plan 1), `recipientsFor` and `createGithubGet` (Task 2), `givenCents` (Task 1), `bearerToken` (Plan 1).
- Produces:
  - `RunDeps = SettleDeps & PayoutDeps`
  - `settlementDeps(deps: Deps & { paypal }, gh, now?): RunDeps`
  - `runSettlement(deps): Promise<RunReport>` and `describeRun(report): string[]`
  - `POST /api/settle`, which answers `{ report, summary }`
  - the scripts `settle` and `claim-maintainer`
  - `/api/me` adds `givenCents`

- [ ] **Step 1: Write the failing tests**

`apps/web/test/run.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { describeRun, runSettlement, settlementDeps } from "../lib/funding/run";
import { FakePayPal } from "../lib/paypal/fake";
import type { Deps } from "../lib/receipts/service";
import type { GithubGet } from "../lib/resolver/recipients";
import { settlementWorld } from "./settle-fixtures";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
const { POST: settleNow } = await import("../app/api/settle/route");

describe("runSettlement", () => {
  it("catches up on payout statuses, settles, then sends, and says what happened in plain words", async () => {
    const w = await settlementWorld();
    const f = await w.funder(1350);
    await w.receipt(f, { a: 6000, b: 4000 });
    await w.receipt(f, { a: 10_000 });
    await w.claim("alice", "PAYER-ALICE", 8);
    const first = await runSettlement(w.deps);
    expect(first).toMatchObject({ settledFunders: 1, setAsideCents: 1350, payoutLines: 1, queuedCents: 540, reconciledLines: 0 });
    expect(first.sent).toMatchObject([{ outcome: "sent" }]);
    expect(describeRun(first)).toEqual([
      "Settled 1 developer's budget: $13.50 set aside for open-source maintainers.",
      "Put $5.40 on 1 payout line.",
      "PayPal took the payout batch.",
    ]);
    const line = [...w.paypal.payoutBatches.values()][0]!.items[0]!;
    w.paypal.setPayoutItemStatus(line.payout_item!.sender_item_id!, "SUCCESS");
    const second = await runSettlement(w.deps);
    expect(second.reconciledLines).toBe(1);
    expect(describeRun(second)).toEqual(["Checked 1 payout line with PayPal.", "Nothing new to settle."]);
  });
});

describe("settlementDeps", () => {
  it("finds a package's repo through the registry and its people through GitHub", async () => {
    const db = createPgliteDb();
    await migrateDb(db, "pglite");
    const http = async (url: string) =>
      url.includes("pypi.org/pypi/widget/json")
        ? { status: 200, body: { info: { summary: "Widgets", project_urls: { Source: "https://github.com/Acme/Widget" } } } }
        : { status: 404, body: null };
    const gh: GithubGet = async (path) =>
      path.startsWith("/repos/acme/widget/commits") ? { status: 200, body: [{ author: { login: "alice", type: "User" } }] } : { status: 404, body: null };
    const deps = settlementDeps({ db, http, model: null, paypal: new FakePayPal() } as unknown as Deps & { paypal: FakePayPal }, gh);
    const repo = await deps.repoFor("pypi", "widget");
    expect(repo).toEqual({ owner: "acme", name: "widget" });
    expect(await deps.recipients(repo!)).toEqual({ source: "committers", recipients: [{ login: "alice", shareBp: 10_000 }] });
    expect(await deps.repoFor("pypi", "missing")).toBeNull();
  });
});

describe("POST /api/settle", () => {
  beforeEach(async () => {
    const db = createPgliteDb();
    await migrateDb(db, "pglite");
    h.deps = { db, http: async () => ({ status: 404, body: null }), model: null, paypal: new FakePayPal() } as unknown as Deps;
    process.env.SETTLE_TOKEN = "settle-secret";
  });
  afterEach(() => {
    delete process.env.SETTLE_TOKEN;
  });
  const call = (token?: string) =>
    settleNow(new Request("http://up.test/api/settle", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} }));

  it("runs a settlement only for someone holding the settle token", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("wrong")).status).toBe(401);
    const ok = await call("settle-secret");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { summary: string[] }).summary).toEqual(["Nothing new to settle."]);
  });

  it("is switched off when no settle token is set", async () => {
    delete process.env.SETTLE_TOKEN;
    expect((await call("settle-secret")).status).toBe(401);
  });
});
```

In `apps/web/test/settings.test.ts`:
- In "summarises the budget, subscription, setting and receipts", add `givenCents: 0,` after `balanceCents: 916,`.
- In "shows the budget left after what settlements set aside for maintainers", replace the last assertion with:

```ts
    expect(await res.json()).toMatchObject({ balanceCents: 600, givenCents: 400 });
```

- [ ] **Step 2: Run them to see them fail**

Run: `rm -rf node_modules/.vitest-cache && pnpm test apps/web/test/run.test.ts apps/web/test/settings.test.ts`
Expected: FAIL. `../lib/funding/run` can't be resolved, and 2 settings tests fail on `givenCents`.

- [ ] **Step 3: The run, its plain-words report, and the endpoint**

`apps/web/lib/funding/run.ts`:

```ts
import type { PayPalApi } from "../paypal/api";
import { formatUsd } from "../format";
import type { Deps } from "../receipts/service";
import { resolveWithCache } from "../resolver/cache";
import { recipientsFor, type GithubGet } from "../resolver/recipients";
import { reconcilePayouts } from "./payout-status";
import { payOut, type PayoutDeps, type SendResult } from "./payouts";
import { settle, type SettleDeps, type SettleSummary } from "./settle";

export type RunDeps = SettleDeps & PayoutDeps;

export interface RunReport extends SettleSummary {
  reconciledLines: number;
  sent: SendResult[];
}

/** Settlement deps from the app's: Plan 1's cached registry lookup for repos, and cached GitHub lookups for people. */
export function settlementDeps(deps: Deps & { paypal: PayPalApi }, gh: GithubGet, now?: () => Date): RunDeps {
  const clock = () => now?.() ?? new Date();
  return {
    db: deps.db,
    paypal: deps.paypal,
    now: clock,
    repoFor: async (ecosystem, name) => (await resolveWithCache(deps.db, ecosystem, name, deps.http, clock())).repo,
    recipients: (repo) => recipientsFor(deps.db, gh, repo, clock()),
  };
}

/** The whole job: catch up on payout statuses with PayPal, settle, then send payouts. */
export async function runSettlement(deps: RunDeps): Promise<RunReport> {
  const reconciledLines = await reconcilePayouts(deps);
  const summary = await settle(deps);
  return { ...summary, reconciledLines, sent: await payOut(deps) };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a run did, in plain words, for the job's log and the "Settle now" button. */
export function describeRun(r: RunReport): string[] {
  const out: string[] = [];
  if (r.reconciledLines > 0) out.push(`Checked ${plural(r.reconciledLines, "payout line", "payout lines")} with PayPal.`);
  const before = out.length;
  if (r.expiredReceipts > 0) out.push(`Dropped ${plural(r.expiredReceipts, "receipt", "receipts")} nobody approved within 14 days.`);
  if (r.settledFunders > 0) {
    out.push(`Settled ${plural(r.settledFunders, "developer's budget", "developers' budgets")}: ${formatUsd(r.setAsideCents)} set aside for open-source maintainers.`);
  }
  if (r.waitingFunders > 0) {
    out.push(`${plural(r.waitingFunders, "developer", "developers")} will be settled on a later run (GitHub was busy, or the budget is empty).`);
  }
  if (r.returnedCents > 0) {
    out.push(`Gave ${formatUsd(r.returnedCents)} back to developers' budgets (unclaimed for 90 days, refunded, or it would have paid the developer themselves).`);
  }
  if (r.payoutLines > 0) out.push(`Put ${formatUsd(r.queuedCents)} on ${plural(r.payoutLines, "payout line", "payout lines")}.`);
  for (const s of r.sent) {
    if (s.outcome === "sent") out.push("PayPal took the payout batch.");
    else if (s.outcome === "sent-before") out.push("PayPal already had a payout batch from an earlier try. Its updates will fill in the details.");
    else out.push(`PayPal couldn't take a payout batch (${s.error}). It will be sent on the next run.`);
  }
  if (out.length === before) out.push("Nothing new to settle.");
  return out;
}
```

`apps/web/app/api/settle/route.ts`:

```ts
import { createHash, timingSafeEqual } from "node:crypto";
import { bearerToken } from "../../../lib/auth";
import { getDeps } from "../../../lib/deps";
import { describeRun, runSettlement, settlementDeps } from "../../../lib/funding/run";
import { json } from "../../../lib/http";
import { createGithubGet } from "../../../lib/resolver/recipients";

export const runtime = "nodejs";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** "Settle now": runs the settlement job in this process. Needs the SETTLE_TOKEN; without one set, it's off. */
export async function POST(req: Request): Promise<Response> {
  const expected = process.env.SETTLE_TOKEN;
  const given = bearerToken(req);
  if (!expected || !given || !timingSafeEqual(digest(given), digest(expected))) return json({ error: "not allowed" }, 401);
  const deps = await getDeps();
  if (!deps.paypal) return json({ error: "Payments aren't set up on this server yet" }, 503);
  const report = await runSettlement(settlementDeps({ ...deps, paypal: deps.paypal }, createGithubGet(process.env.GITHUB_TOKEN)));
  return json({ report, summary: describeRun(report) });
}
```

`apps/web/jobs/settle.ts`:

```ts
// The settlement job, for a scheduled run (Render cron) against Postgres. With PGlite, use POST /api/settle
// instead: only one process may open a PGlite database, and the dev server already has it.
import { getDeps } from "../lib/deps";
import { describeRun, runSettlement, settlementDeps } from "../lib/funding/run";
import { createGithubGet } from "../lib/resolver/recipients";

const deps = await getDeps();
if (!deps.paypal) {
  console.error("PayPal isn't set up (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET), so nothing can be paid out.");
  process.exit(1);
}
const report = await runSettlement(settlementDeps({ ...deps, paypal: deps.paypal }, createGithubGet(process.env.GITHUB_TOKEN)));
for (const line of describeRun(report)) console.log(line);
process.exit(0);
```

`apps/web/scripts/claim-maintainer.ts`:

```ts
// Sandbox only, until maintainers can sign in themselves (Plan 2c): records that a GitHub account can be paid
// at a PayPal account id, as if they had linked it `daysAgo` days ago (default 8, past the first-payout hold).
// Usage: pnpm --filter web claim-maintainer <github-login> <paypal-payer-id> [days-ago]
import { getDeps } from "../lib/deps";
import { maintainers } from "../lib/db/schema";
import { SANDBOX_API } from "../lib/paypal/client";

const [login, payerId, daysAgo = "8"] = process.argv.slice(2);
if (!login || !payerId || !/^\d+$/.test(daysAgo)) {
  console.error("Usage: pnpm --filter web claim-maintainer <github-login> <paypal-payer-id> [days-ago]");
  process.exit(1);
}
if ((process.env.PAYPAL_API_BASE ?? SANDBOX_API) !== SANDBOX_API) {
  console.error("This only works against the PayPal sandbox. Real maintainers link PayPal themselves.");
  process.exit(1);
}
const claimedAt = new Date(Date.now() - Number(daysAgo) * 24 * 60 * 60 * 1000);
const { db } = await getDeps();
await db
  .insert(maintainers)
  .values({ login: login.toLowerCase(), paypalPayerId: payerId, claimedAt })
  .onConflictDoUpdate({ target: maintainers.login, set: { paypalPayerId: payerId, claimedAt } });
console.log(`${login.toLowerCase()} can now be paid at sandbox PayPal account ${payerId}, as if linked ${daysAgo} days ago.`);
process.exit(0);
```

In `apps/web/package.json`, add these two scripts after `paypal:setup`:

```json
    "settle": "node --env-file-if-exists=.env.local --import tsx jobs/settle.ts",
    "claim-maintainer": "node --env-file-if-exists=.env.local --import tsx scripts/claim-maintainer.ts"
```

- [ ] **Step 4: Show what was set aside**

Replace `apps/web/app/api/me/route.ts` with:

```ts
import { desc, eq, sql } from "drizzle-orm";
import { receipts, subscriptions } from "../../../lib/db/schema";
import { balanceCents, givenCents } from "../../../lib/funding/ledger";
import { getSettings } from "../../../lib/funding/settings";
import { json, withAccount } from "../../../lib/http";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  return withAccount(req, async (deps, accountId) => {
    const [subscription] = await deps.db
      .select({ id: subscriptions.id, tier: subscriptions.tier, status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId))
      // A live subscription wins over an abandoned attempt that changed later, so we never invite a second one.
      .orderBy(sql`case ${subscriptions.status} when 'ACTIVE' then 0 when 'APPROVED' then 1 when 'SUSPENDED' then 2 else 3 end`, desc(subscriptions.updatedAt))
      .limit(1);
    const counts = await deps.db
      .select({ status: receipts.status, n: sql<string>`count(*)` })
      .from(receipts)
      .where(eq(receipts.accountId, accountId))
      .groupBy(receipts.status);
    return json({
      balanceCents: await balanceCents(deps.db, accountId),
      givenCents: await givenCents(deps.db, accountId),
      subscription: subscription ?? null,
      autoApprove: (await getSettings(deps.db, accountId)).autoApprove,
      receipts: { proposed: 0, approved: 0, skipped: 0, ...Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) },
      paymentsReady: Boolean(deps.paypal),
    });
  });
}
```

In `apps/web/app/dashboard/FundingPanel.tsx`, add `givenCents: number;` to `Me` after `balanceCents: number;`. Then, just above `{notice && <p role="status">{notice}</p>}`, add:

```tsx
      {me.givenCents > 0 && <p>{formatUsd(me.givenCents)} set aside for open-source maintainers so far.</p>}
```

Replace `apps/web/.env.example` with:

```bash
# Gemini (attribution judge)
GEMINI_API_KEY=
GEMINI_MODEL=
# Postgres URL in production; leave empty locally to use PGlite in .data/
DATABASE_URL=
# GitHub token for finding who maintains a repo (read-only, public repos). Optional: without it GitHub allows
# 60 requests an hour. A token GitHub refuses stops the settlement with a clear error.
GITHUB_TOKEN=
# PayPal sandbox app
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
# Defaults to the sandbox API
PAYPAL_API_BASE=
# From the dashboard's Webhooks page, once the hosted URL is registered. Without it /api/paypal/webhook answers 503.
PAYPAL_WEBHOOK_ID=
# Written by `pnpm --filter web paypal:setup --write`
PAYPAL_PLAN_STARTER=
PAYPAL_PLAN_BUILDER=
PAYPAL_PLAN_TEAM=
# Browser-side PayPal buttons
NEXT_PUBLIC_PAYPAL_CLIENT_ID=
NEXT_PUBLIC_PAYPAL_ENV=sandbox
# Public address of this server, for the login links the CLI prints (defaults to the request's own address)
PUBLIC_URL=
# Lets POST /api/settle run a settlement ("Settle now"). Leave empty to switch that endpoint off.
SETTLE_TOKEN=
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `rm -rf node_modules/.vitest-cache && pnpm test`, then `pnpm --filter web exec tsc --noEmit` and `pnpm --filter web build`
Expected:
- run 4/4, and every test passes (238, plus 1 skipped)
- the typecheck is clean
- the build lists `/api/settle`

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/funding/run.ts apps/web/app/api/settle apps/web/jobs apps/web/scripts/claim-maintainer.ts apps/web/package.json apps/web/.env.example apps/web/app/api/me/route.ts apps/web/app/dashboard/FundingPanel.tsx apps/web/test/run.test.ts apps/web/test/settings.test.ts
git commit -m "Add the settlement job, a protected Settle now endpoint and a sandbox claim script"
```

---

### Task 8: Live run against the PayPal sandbox and GitHub

No new code. This proves the Plan 2b goal with real sandbox money and real GitHub data, and records what happened.

**Files:**
- Create: `docs/e2e-plan-2b.md` (what ran and what came out). It contains no secrets, and names no real maintainer. Write "fastapi's top committer", not their login.

**Needs:**
- **A second sandbox PayPal account id.** Ask Arun to log in at developer.paypal.com, then read the "Account ID" of maintainer test account sb-ls07n53353609 from its account page. It's an identifier, not a credential.
- **`SETTLE_TOKEN`** in `apps/web/.env.local`: a random 32-byte hex value Claude generates. Never print it.
- **`GITHUB_TOKEN`:** a new read-only token from Arun, or run with `GITHUB_TOKEN=` set empty, since 60 requests an hour is enough here.
- **Optional, for Review Focus 1:** a throwaway Postgres, such as `docker run --rm -d -p 54329:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine` once Arun has Docker Desktop running.
- The dev database still holds Plan 2a's sandbox funder (about $13.50 and one approved receipt: fastapi, pydantic and vitest).

- [ ] **Step 1: Claim two maintainers, with the dev server stopped (PGlite allows one process)**

Use `GITHUB_TOKEN= pnpm --filter web settle` once to see who the receipt's packages resolve to. Expected:
- "Settled 1 developer's budget: $13.50 set aside for open-source maintainers."
- Every package has someone to pay. pydantic must **not** resolve to a `sponsors/` path.

Then claim:
1. fastapi's top committer, at the **second** sandbox account id: `pnpm --filter web claim-maintainer <login> <account-id> 8`.
2. pydantic's FUNDING.yml person, at the **funder's own** payer id, from `funding_events.payer_id`. This is the self-dealing case.

These claims exist only in the local sandbox database. They are stand-ins until Plan 2c's sign-in.

- [ ] **Step 2: Settle through the dev server**

Start `pnpm --filter web dev` with `SETTLE_TOKEN` set, then run:

```
curl -s -X POST localhost:3000/api/settle -H "authorization: Bearer $SETTLE_TOKEN"
```

Expected summary:
- "Gave $5.53 back to developers' budgets (...)"
- "Put $4.86 on 1 payout line."
- "PayPal took the payout batch."

On the dashboard: "$5.53 in your budget" and "$7.97 set aside for open-source maintainers so far."

- [ ] **Step 3: Watch the payout land**

After about a minute, call `/api/settle` again.
Expected:
- "Checked 1 payout line with PayPal."
- The line's status is `SUCCESS` (or still `PENDING`; record which, and how long it took).
- `fee_cents` is 25.

Call it once more.
Expected: no second batch for the first settlement. `GET /v1/payments/payouts/{batch}` lists one item.

- [ ] **Step 4: Overlapping settlements on Postgres (if a throwaway Postgres is available)**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/postgres pnpm test apps/web/test/settle-pg.test.ts`
Expected: 1 passed.

To check that the test means something, comment out the `pg_advisory_xact_lock` line in `settle.ts` and rerun. Expected: FAIL. Restore the line.

- [ ] **Step 5: Record and commit**

Write `docs/e2e-plan-2b.md` covering:
- the summaries from each call
- the budget and set-aside figures
- the payout line's status and fee, and how long it took
- the self-dealing return
- the Postgres check, or that it was skipped and why
- anything surprising

Payout and refund webhooks can't reach `localhost`. Their live check happens after the Render deploy in Plan 3, through the dashboard's Webhooks simulator. Note that here.

```bash
git add docs/e2e-plan-2b.md
git commit -m "Record Plan 2b sandbox run"
```

---

## After Plan 2b

**Plan 2c (maintainer sign-in):**
- GitHub OAuth gives the `maintainers` row its `login` and `githubId`.
- Log in with PayPal sets `paypalPayerId`, from a verified account only, and `claimedAt`.
  - **Linking a different PayPal account resets `claimedAt`**, so the 7-day hold starts again.
  - Two GitHub logins can never share one PayPal account (`UNIQUE`).
- The https return URL on Render has to be added in the PayPal dashboard first.
- A maintainer page shows earnings by month and the status of each payout line.
- `claim-maintainer` is then removed.

**Plan 3 (product and deploy):**
- the styled dashboard and the Agent Usage vs Funding index
- the current period's projected amount at the current pace, on the dashboard and in the agent (spec section 7, "Allocation")
- demo mode, with a "Settle now" button that calls `/api/settle` server-side
- Render: web service, Postgres, two crons (monthly `pnpm --filter web settle`, and daily `pnpm --filter web settle --payouts-only` so a failed send is retried well inside PayPal's 30-day duplicate window), and the webhook registered for funding, payout-item and refund events
- the README, which says the platform pays PayPal's $0.25 per payout line, and the production note from spec section 7
- the video and the Devpost submission
