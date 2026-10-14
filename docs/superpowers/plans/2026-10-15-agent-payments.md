# Paying from the agent - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer tells their coding agent to add money to their Upstream budget; Upstream's server starts the PayPal order with PayPal's Agent Toolkit, the developer approves it in PayPal, and the agent confirms what was added.

**Architecture:** Three new MCP tools in the CLI plugin call two new device-token routes. The routes use `lib/funding/agent-payments.ts`, which keeps its own `agent_payments` records (the toolkit's orders carry no `custom_id`) and talks to PayPal only through `AgentOrders`, a small interface implemented by a wrapper around `@paypal/agent-toolkit` (orders create, get and capture only, sandbox only, called directly with no server-side language model). Crediting reuses the existing `creditCaptures`, so a retry never credits twice.

**Tech Stack:** Next.js 16 route handlers, Drizzle + PGlite/Postgres, Vitest 5, `@paypal/agent-toolkit@1.11.0` (its `ai-sdk` entry), `@modelcontextprotocol/server` in the CLI, zod 4.

**Spec:** `docs/superpowers/specs/2026-10-14-agent-payments-design.md`

## Global Constraints

- Sandbox only: the toolkit is never built unless `PAYPAL_API_BASE` resolves to `https://api-m.sandbox.paypal.com`.
- Pin `@paypal/agent-toolkit` at exactly `1.11.0`.
- Only these toolkit actions are enabled: `orders: { create: true, get: true, capture: true }` (tools `create_order`, `get_order`, `pay_order`).
- No server-side language model: Upstream calls the toolkit tools' `execute` directly.
- Amounts: $1 to $500 per payment, whole cents (`TOPUP_MIN_CENTS` = 100, `TOPUP_MAX_CENTS` = 50_000).
- At most 3 unfinished agent payments per account (status `created`, younger than 6 hours).
- At most $100 a day of agent payments per account (sum of `cents` over the last 24 hours, status not `cancelled`).
- An order id is only checked or captured for the account that created it.
- Never log the toolkit's access token or full order bodies.
- User-facing words are plain, no em dashes; error answers are one sentence.
- Commit messages: one short imperative line, no attribution of any kind.
- Run tests with `--maxWorkers=2` (the machine is often busy).

## Review Focus

1. The toolkit answering with something other than the JSON it documents (a plain string, an error object without `code`, `null`): the developer gets a clear "PayPal couldn't..." answer, never a crash or a credited payment. Pinned in Task 1.
2. The agent checking the payment again and again, before and after approval: it never captures early, and after capture every check reports the same amount added and the budget is credited once. Pinned in Task 2.
3. An order that expired or was voided at PayPal (get answers 404, or status `VOIDED`): reported as cancelled, not as a server error, and it stops counting toward the daily cap. Pinned in Task 2.
4. Limits at their edges: exactly $100 in a day is allowed and $100.01 isn't; a 4th waiting payment is refused, and allowed again once one is 6 hours old. Pinned in Task 2.
5. Decimal dollars from the agent (9.99, 10): the CLI sends exactly 999 and 1000 cents. Pinned in Task 4.

## Decisions made while planning

- **No new budget route.** `GET /api/me` already accepts the machine token and returns `balanceCents`, `givenCents` and `subscription`; `upstream_budget` uses it. (The spec listed `GET /api/agent/budget`; this is the same data without a second endpoint.)
- **A fresh toolkit per call.** The toolkit fetches one OAuth token and caches it forever, while PayPal tokens expire after hours, so `createAgentOrders` builds a new toolkit for each create, get or capture.
- **The toolkit's answers are JSON strings, errors included.** Its `run` never throws: failures come back as `{code, message, status}` or `{error: {message, type}}`. The wrapper turns those into `PayPalError`.
- **The capture action is `orders.capture`** (it enables the `pay_order` tool), and order items need `itemCost`, `itemTotal` and `taxPercent`.

---

### Task 1: The PayPal Agent Toolkit wrapper

**Files:**
- Modify: `apps/web/package.json` (dependency), `apps/web/next.config.ts` (server external package)
- Create: `apps/web/lib/paypal/agent-toolkit.ts`
- Modify: `apps/web/lib/paypal/fake.ts` (add `FakeAgentOrders`)
- Test: `apps/web/test/agent-toolkit.test.ts`

**Interfaces:**
- Produces:
  - `interface AgentOrders { createOrder(cents: number, returnUrl: string, cancelUrl: string): Promise<{ id: string; status: string; approveUrl: string }>; getOrder(id: string): Promise<PaypalOrder>; captureOrder(id: string): Promise<PaypalOrder> }`
  - `type ToolkitTools` (tools by name, each with `execute(args, options)`)
  - `agentOrdersFromTools(makeTools: () => ToolkitTools): AgentOrders`
  - `toolkitTools(cfg: { clientId: string; clientSecret: string }): ToolkitTools`
  - `createAgentOrders(cfg: { clientId: string; clientSecret: string; apiBase: string }): AgentOrders` (throws unless sandbox)
  - `isSandboxBase(apiBase: string): boolean`
  - `const AGENT_ORDER_ITEM = "Upstream open-source budget"`
  - `class FakeAgentOrders implements AgentOrders` in `lib/paypal/fake.ts`, with `pp: FakePayPal`, `calls: string[]`, `urls: Map<string, { returnUrl: string; cancelUrl: string }>`; its approve link is `https://www.sandbox.paypal.com/checkoutnow?token=<orderId>`.

- [ ] **Step 1: Install the toolkit alone and check the app still builds**

```bash
cd /Users/arunbrahma/Desktop/AltGAN/codepad/hackathons/upstream
pnpm --filter web add @paypal/agent-toolkit@1.11.0
```

Then add it to the server externals in `apps/web/next.config.ts`:

```ts
  serverExternalPackages: ["@electric-sql/pglite", "@paypal/agent-toolkit"],
```

Run: `pnpm --filter web build > /tmp/agtk-build.log 2>&1; tail -20 /tmp/agtk-build.log`
Expected: the build finishes ("Compiled successfully" and the route list). If pnpm refuses a dependency's build script, add that package to `allowBuilds` in `pnpm-workspace.yaml` and rerun. If the build fails on a zod, `ai` or Next conflict, STOP and report: the spec's risk 11 says to stop here.

- [ ] **Step 2: Write the failing tests**

`apps/web/test/agent-toolkit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { agentOrdersFromTools, AGENT_ORDER_ITEM, createAgentOrders, isSandboxBase, toolkitTools, type ToolkitTools } from "../lib/paypal/agent-toolkit";
import { PayPalError } from "../lib/paypal/client";

/** Toolkit tools that answer the way the real ones do: a JSON string (or a given raw string), recording each call. */
function fakeTools(answers: Record<string, unknown>, seen: Array<[string, unknown]> = []): ToolkitTools {
  return Object.fromEntries(
    Object.entries(answers).map(([name, answer]) => [
      name,
      {
        execute: async (args: unknown) => {
          seen.push([name, args]);
          return typeof answer === "string" ? answer : JSON.stringify(answer);
        },
      },
    ]),
  );
}

const order = (links: Array<{ rel: string; href: string }>) => ({ id: "5O190127TN364715T", status: "PAYER_ACTION_REQUIRED", links });

describe("the PayPal Agent Toolkit wrapper", () => {
  it("creates a USD order for the amount, with Upstream's return pages, and returns PayPal's approval link", async () => {
    const seen: Array<[string, unknown]> = [];
    const orders = agentOrdersFromTools(() =>
      fakeTools({ create_order: order([{ rel: "self", href: "x" }, { rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=5O1" }]) }, seen),
    );
    const out = await orders.createOrder(1000, "https://up.test/agent/paid", "https://up.test/agent/paid?cancelled=1");
    expect(out).toEqual({ id: "5O190127TN364715T", status: "PAYER_ACTION_REQUIRED", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=5O1" });
    expect(seen).toEqual([
      [
        "create_order",
        {
          currencyCode: "USD",
          items: [{ name: AGENT_ORDER_ITEM, quantity: 1, itemCost: 10, itemTotal: 10, taxPercent: 0 }],
          returnUrl: "https://up.test/agent/paid",
          cancelUrl: "https://up.test/agent/paid?cancelled=1",
        },
      ],
    ]);
  });

  it("falls back to the approve link, and refuses an order with no link to approve it", async () => {
    const withApprove = agentOrdersFromTools(() => fakeTools({ create_order: order([{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=A" }]) }));
    expect((await withApprove.createOrder(999, "r", "c")).approveUrl).toBe("https://www.sandbox.paypal.com/checkoutnow?token=A");
    const none = agentOrdersFromTools(() => fakeTools({ create_order: order([{ rel: "self", href: "x" }]) }));
    await expect(none.createOrder(999, "r", "c")).rejects.toBeInstanceOf(PayPalError);
  });

  it("turns the toolkit's error answers into PayPalError, whatever shape they come in", async () => {
    const httpError = agentOrdersFromTools(() => fakeTools({ get_order: { code: "PAYPAL_API_HTTP_ERROR", message: "Not found", status: 404 } }));
    await expect(httpError.getOrder("X")).rejects.toMatchObject({ status: 404, code: "PAYPAL_API_HTTP_ERROR" });
    const plainError = agentOrdersFromTools(() => fakeTools({ get_order: { error: { message: "socket hang up", type: "paypal_error" } } }));
    await expect(plainError.getOrder("X")).rejects.toMatchObject({ status: 502 });
    const notJson = agentOrdersFromTools(() => fakeTools({ get_order: "<html>Bad gateway</html>" }));
    await expect(notJson.getOrder("X")).rejects.toMatchObject({ status: 502, code: "TOOLKIT_BAD_ANSWER" });
    const nothing = agentOrdersFromTools(() => fakeTools({ get_order: "null" }));
    await expect(nothing.getOrder("X")).rejects.toMatchObject({ status: 502, code: "TOOLKIT_BAD_ANSWER" });
  });

  it("captures with pay_order and returns the captured order, or fails clearly", async () => {
    const captured = { id: "O1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "C1", status: "COMPLETED" }] } }] };
    const good = agentOrdersFromTools(() => fakeTools({ pay_order: { status: "success", response: captured } }));
    expect(await good.captureOrder("O1")).toEqual(captured);
    const bad = agentOrdersFromTools(() => fakeTools({ pay_order: { status: "error", response: { name: "UNPROCESSABLE_ENTITY" } } }));
    await expect(bad.captureOrder("O1")).rejects.toBeInstanceOf(PayPalError);
  });

  it("says so when a tool isn't enabled, and builds fresh tools for every call", async () => {
    let built = 0;
    const orders = agentOrdersFromTools(() => {
      built += 1;
      return fakeTools({ get_order: { id: "O1", status: "CREATED" } });
    });
    await orders.getOrder("O1");
    await orders.getOrder("O1");
    expect(built).toBe(2);
    await expect(orders.captureOrder("O1")).rejects.toMatchObject({ status: 500, code: "TOOL_NOT_ENABLED" });
  });

  it("runs on the PayPal sandbox only, with only the three order tools switched on", () => {
    expect(isSandboxBase("https://api-m.sandbox.paypal.com")).toBe(true);
    expect(isSandboxBase("https://api-m.sandbox.paypal.com/")).toBe(true);
    expect(isSandboxBase("https://api-m.paypal.com")).toBe(false);
    expect(() => createAgentOrders({ clientId: "id", clientSecret: "secret", apiBase: "https://api-m.paypal.com" })).toThrow(/sandbox/);
    expect(Object.keys(toolkitTools({ clientId: "id", clientSecret: "secret" })).sort()).toEqual(["create_order", "get_order", "pay_order"]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run apps/web/test/agent-toolkit.test.ts --maxWorkers=2`
Expected: FAIL, "Cannot find module '../lib/paypal/agent-toolkit'".

- [ ] **Step 4: Write the wrapper**

`apps/web/lib/paypal/agent-toolkit.ts`:

```ts
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import type { PaypalOrder } from "./api";
import { PayPalError, SANDBOX_API } from "./client";
import { fromCents } from "./money";

/**
 * What Upstream needs from PayPal to take a payment the developer's coding agent started. The real one is PayPal's
 * Agent Toolkit (orders create, get and capture only); tests use FakeAgentOrders.
 */
export interface AgentOrders {
  createOrder(cents: number, returnUrl: string, cancelUrl: string): Promise<{ id: string; status: string; approveUrl: string }>;
  getOrder(id: string): Promise<PaypalOrder>;
  captureOrder(id: string): Promise<PaypalOrder>;
}

/** The toolkit's tools as Upstream calls them: by name, each answering with a JSON string. */
export type ToolkitTools = Record<string, { execute?(args: unknown, options: unknown): PromiseLike<unknown> } | undefined>;

export const AGENT_ORDER_ITEM = "Upstream open-source budget";

export function isSandboxBase(apiBase: string): boolean {
  return apiBase.trim().replace(/\/+$/, "") === SANDBOX_API;
}

const badAnswer = () => new PayPalError(502, "TOOLKIT_BAD_ANSWER", "PayPal's Agent Toolkit gave an answer Upstream couldn't read", null);

/** Runs one toolkit tool. Its `run` never throws: failures come back as {code, message, status} or {error: {...}}. */
async function call(tools: ToolkitTools, name: "create_order" | "get_order" | "pay_order", args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = tools[name];
  if (!tool?.execute) throw new PayPalError(500, "TOOL_NOT_ENABLED", `The PayPal Agent Toolkit tool ${name} isn't enabled`, null);
  const raw = await tool.execute(args, { toolCallId: `upstream-${name}`, messages: [] });
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      throw badAnswer();
    }
  }
  if (!data || typeof data !== "object") throw badAnswer();
  const d = data as Record<string, unknown>;
  const failure = d.error && typeof d.error === "object" ? (d.error as Record<string, unknown>) : d.code && d.message && !d.id ? d : null;
  if (failure) {
    throw new PayPalError(Number(failure.status) || 502, String(failure.code ?? failure.type ?? "PAYPAL_TOOL_ERROR"), String(failure.message ?? "PayPal returned an error"), null);
  }
  return d;
}

interface OrderWithLinks extends PaypalOrder {
  links?: Array<{ rel?: string; href?: string }>;
}

/** AgentOrders over toolkit tools. `makeTools` runs for every call, so each call gets a fresh PayPal token. */
export function agentOrdersFromTools(makeTools: () => ToolkitTools): AgentOrders {
  return {
    async createOrder(cents, returnUrl, cancelUrl) {
      const dollars = Number(fromCents(cents));
      const o = (await call(makeTools(), "create_order", {
        currencyCode: "USD",
        items: [{ name: AGENT_ORDER_ITEM, quantity: 1, itemCost: dollars, itemTotal: dollars, taxPercent: 0 }],
        returnUrl,
        cancelUrl,
      })) as unknown as OrderWithLinks;
      const link = o.links?.find((l) => l.rel === "payer-action") ?? o.links?.find((l) => l.rel === "approve");
      if (!o.id || !link?.href) throw new PayPalError(502, "NO_APPROVAL_LINK", "PayPal didn't return a link to approve the payment", null);
      return { id: o.id, status: o.status, approveUrl: link.href };
    },
    async getOrder(id) {
      return (await call(makeTools(), "get_order", { id })) as unknown as PaypalOrder;
    },
    async captureOrder(id) {
      const r = await call(makeTools(), "pay_order", { id });
      if (r.status !== "success" || !r.response || typeof r.response !== "object") {
        throw new PayPalError(502, "CAPTURE_FAILED", "PayPal couldn't capture the payment", null);
      }
      return r.response as PaypalOrder;
    },
  };
}

/** PayPal's Agent Toolkit with only creating, reading and capturing orders switched on, on the sandbox. */
export function toolkitTools(cfg: { clientId: string; clientSecret: string }): ToolkitTools {
  const toolkit = new PayPalAgentToolkit({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    configuration: { actions: { orders: { create: true, get: true, capture: true } }, context: { sandbox: true } },
  });
  return toolkit.getTools() as unknown as ToolkitTools;
}

export function createAgentOrders(cfg: { clientId: string; clientSecret: string; apiBase: string }): AgentOrders {
  if (!isSandboxBase(cfg.apiBase)) throw new Error("Payments from the agent run on the PayPal sandbox only");
  return agentOrdersFromTools(() => toolkitTools(cfg));
}
```

Append to `apps/web/lib/paypal/fake.ts` (and add `import type { AgentOrders } from "./agent-toolkit";` to its imports):

```ts
/** Stand-in for the Agent Toolkit's order tools, backed by a FakePayPal. Like the toolkit's orders, these carry no custom_id. */
export class FakeAgentOrders implements AgentOrders {
  calls: string[] = [];
  urls = new Map<string, { returnUrl: string; cancelUrl: string }>();
  constructor(readonly pp: FakePayPal = new FakePayPal()) {}

  async createOrder(cents: number, returnUrl: string, cancelUrl: string) {
    this.calls.push("createOrder");
    const o = await this.pp.createOrder(cents, "");
    this.urls.set(o.id, { returnUrl, cancelUrl });
    return { id: o.id, status: o.status, approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}` };
  }

  async getOrder(id: string) {
    this.calls.push("getOrder");
    return this.pp.getOrder(id);
  }

  async captureOrder(id: string) {
    this.calls.push("captureOrder");
    return this.pp.captureOrder(id);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run apps/web/test/agent-toolkit.test.ts --maxWorkers=2`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml pnpm-workspace.yaml apps/web/next.config.ts apps/web/lib/paypal/agent-toolkit.ts apps/web/lib/paypal/fake.ts apps/web/test/agent-toolkit.test.ts
git commit -m "Wrap PayPal's Agent Toolkit for orders started from the agent"
```

---

### Task 2: Agent payments, their limits and crediting

**Files:**
- Modify: `apps/web/lib/db/schema.ts` (table `agentPayments`)
- Create: `apps/web/drizzle/0009_*.sql` and `apps/web/drizzle/meta/*` (generated)
- Create: `apps/web/lib/funding/agent-payments.ts`
- Test: `apps/web/test/agent-payments.test.ts`

**Interfaces:**
- Consumes: `AgentOrders`, `FakeAgentOrders` (Task 1); `creditCaptures(db, accountId, order, now)`, `TOPUP_MIN_CENTS`, `TOPUP_MAX_CENTS` from `lib/funding/topups.ts`; `balanceCents(db, accountId)`, `netCents(net, gross)` from `lib/funding/ledger.ts`; `FundingError(status, message)` from `lib/funding/subscriptions.ts`; `PayPalError` from `lib/paypal/client.ts`.
- Produces:
  - table `agentPayments` (`orderId` text pk, `accountId` uuid, `cents` integer, `status` "created" | "captured" | "cancelled", `createdAt`, `capturedAt`)
  - `interface AgentPaymentDeps { db: Db; orders: AgentOrders; now?: () => Date }`
  - `startAgentPayment(deps, accountId: string, cents: number, urls: { returnUrl: string; cancelUrl: string }): Promise<{ orderId: string; approveUrl: string; cents: number }>`
  - `finishAgentPayment(deps, accountId: string, orderId: string): Promise<AgentPaymentResult>` where `AgentPaymentResult = { status: "added"; addedCents: number; budgetCents: number } | { status: "waiting" | "cancelled"; budgetCents: number }`
  - `AGENT_OPEN_LIMIT = 3`, `AGENT_DAILY_CENTS = 10_000`

- [ ] **Step 1: Add the table and generate the migration**

In `apps/web/lib/db/schema.ts`, after `fundingEvents`:

```ts
/** Payments a developer's coding agent started. Ownership lives here: the Agent Toolkit's orders carry no custom_id. */
export const agentPayments = pgTable(
  "agent_payments",
  {
    orderId: text("order_id").primaryKey(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    cents: integer("cents").notNull(),
    status: text("status", { enum: ["created", "captured", "cancelled"] }).notNull().default("created"),
    createdAt: createdAt(),
    capturedAt: timestamp("captured_at", tz),
  },
  (t) => [index("agent_payments_account").on(t.accountId)],
);
```

Run: `pnpm --filter web db:generate`
Expected: a new `apps/web/drizzle/0009_<name>.sql` containing `CREATE TABLE "agent_payments"` and the index, plus updated `meta/_journal.json` and `meta/0009_snapshot.json`.

- [ ] **Step 2: Write the failing tests**

`apps/web/test/agent-payments.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { agentPayments } from "../lib/db/schema";
import { finishAgentPayment, startAgentPayment, type AgentPaymentDeps } from "../lib/funding/agent-payments";
import { fundedCents } from "../lib/funding/ledger";
import { PayPalError } from "../lib/paypal/client";
import { FakeAgentOrders } from "../lib/paypal/fake";

const URLS = { returnUrl: "https://up.test/agent/paid", cancelUrl: "https://up.test/agent/paid?cancelled=1" };
const HOUR = 60 * 60 * 1000;
// The fake takes 3.49% + $0.49 like PayPal: $10.00 nets $9.16, $40.00 nets $38.11.
const NET_OF_1000 = 916;

let orders: FakeAgentOrders;
let deps: AgentPaymentDeps;
let now: Date;
beforeEach(async () => {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  orders = new FakeAgentOrders();
  now = new Date("2026-10-20T10:00:00Z");
  deps = { db, orders, now: () => now };
});
const account = async () => (await createDevice(deps.db, null)).accountId;
const later = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

describe("payments from the agent", () => {
  it("starts a payment with PayPal's approval link and Upstream's return pages, and records who started it", async () => {
    const a = await account();
    const p = await startAgentPayment(deps, a, 1000, URLS);
    expect(p).toEqual({ orderId: "ORDER-1", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1", cents: 1000 });
    expect(orders.urls.get("ORDER-1")).toEqual(URLS);
    expect(await deps.db.select().from(agentPayments)).toMatchObject([{ orderId: "ORDER-1", accountId: a, cents: 1000, status: "created" }]);
  });

  it("waits until the developer approves in PayPal, then captures and credits once, however often it's checked", async () => {
    const a = await account();
    const { orderId } = await startAgentPayment(deps, a, 1000, URLS);
    expect(await finishAgentPayment(deps, a, orderId)).toEqual({ status: "waiting", budgetCents: 0 });
    expect(await finishAgentPayment(deps, a, orderId)).toEqual({ status: "waiting", budgetCents: 0 });
    expect(orders.calls).not.toContain("captureOrder");
    orders.pp.approveOrder(orderId, "PAYER-A");
    const added = { status: "added", addedCents: NET_OF_1000, budgetCents: NET_OF_1000 };
    expect(await finishAgentPayment(deps, a, orderId)).toEqual(added);
    expect(await finishAgentPayment(deps, a, orderId)).toEqual(added);
    expect(orders.calls.filter((c) => c === "captureOrder")).toHaveLength(1);
    expect(await fundedCents(deps.db, a)).toBe(NET_OF_1000);
    const [row] = await deps.db.select().from(agentPayments).where(eq(agentPayments.orderId, orderId));
    expect(row).toMatchObject({ status: "captured", capturedAt: now });
  });

  it("keeps payments between $1 and $500 in whole cents, and asks PayPal for nothing otherwise", async () => {
    const a = await account();
    for (const cents of [99, 50_001, 1000.5]) {
      await expect(startAgentPayment(deps, a, cents, URLS)).rejects.toMatchObject({ status: 400 });
    }
    expect(orders.calls).toEqual([]);
  });

  it("allows at most 3 payments waiting for approval, and a 4th once one is 6 hours old", async () => {
    const a = await account();
    for (let i = 0; i < 3; i++) await startAgentPayment(deps, a, 500, URLS);
    await expect(startAgentPayment(deps, a, 500, URLS)).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/3 payments/) });
    later(6 * HOUR + 1);
    expect((await startAgentPayment(deps, a, 500, URLS)).orderId).toBe("ORDER-4");
  });

  it("caps the agent at $100 a day, counting payments still waiting but not cancelled ones", async () => {
    const a = await account();
    const first = await startAgentPayment(deps, a, 4000, URLS);
    orders.pp.approveOrder(first.orderId, "PAYER-A");
    await finishAgentPayment(deps, a, first.orderId);
    await startAgentPayment(deps, a, 4000, URLS);
    await expect(startAgentPayment(deps, a, 2001, URLS)).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/\$100 a day/) });
    await startAgentPayment(deps, a, 2000, URLS);
    later(24 * HOUR + 1);
    expect((await startAgentPayment(deps, a, 4000, URLS)).cents).toBe(4000);
  });

  it("never shows or captures another account's payment", async () => {
    const a = await account();
    const b = await account();
    const { orderId } = await startAgentPayment(deps, a, 1000, URLS);
    orders.pp.approveOrder(orderId, "PAYER-A");
    await expect(finishAgentPayment(deps, b, orderId)).rejects.toMatchObject({ status: 404 });
    await expect(finishAgentPayment(deps, b, "ORDER-NOPE")).rejects.toMatchObject({ status: 404 });
    expect(orders.calls).not.toContain("captureOrder");
    expect(await fundedCents(deps.db, b)).toBe(0);
  });

  it("reports a voided or expired order as cancelled, and stops counting it toward the daily cap", async () => {
    const a = await account();
    const voided = await startAgentPayment(deps, a, 5000, URLS);
    orders.pp.orders.get(voided.orderId)!.status = "VOIDED";
    expect(await finishAgentPayment(deps, a, voided.orderId)).toEqual({ status: "cancelled", budgetCents: 0 });
    const expired = await startAgentPayment(deps, a, 5000, URLS);
    orders.pp.orders.delete(expired.orderId);
    expect(await finishAgentPayment(deps, a, expired.orderId)).toEqual({ status: "cancelled", budgetCents: 0 });
    expect(await finishAgentPayment(deps, a, expired.orderId)).toEqual({ status: "cancelled", budgetCents: 0 });
    expect((await startAgentPayment(deps, a, 10_000, URLS)).cents).toBe(10_000);
  });

  it("finishes the job when the capture went through but PayPal's answer was lost", async () => {
    const a = await account();
    const { orderId } = await startAgentPayment(deps, a, 1000, URLS);
    orders.pp.approveOrder(orderId, "PAYER-A");
    const realCapture = orders.pp.captureOrder.bind(orders.pp);
    orders.pp.captureOrder = async (id: string) => {
      await realCapture(id);
      throw new PayPalError(503, "SERVICE_UNAVAILABLE", "timed out", null);
    };
    expect(await finishAgentPayment(deps, a, orderId)).toEqual({ status: "added", addedCents: NET_OF_1000, budgetCents: NET_OF_1000 });
  });

  it("passes a failed capture through, and a retry is safe", async () => {
    const a = await account();
    const { orderId } = await startAgentPayment(deps, a, 1000, URLS);
    orders.pp.approveOrder(orderId, "PAYER-A");
    orders.pp.failNext("captureOrder", new PayPalError(503, "SERVICE_UNAVAILABLE", "try later", null));
    await expect(finishAgentPayment(deps, a, orderId)).rejects.toBeInstanceOf(PayPalError);
    expect(await fundedCents(deps.db, a)).toBe(0);
    expect((await finishAgentPayment(deps, a, orderId)).status).toBe("added");
  });

  it("records nothing when PayPal can't create the order", async () => {
    const a = await account();
    orders.pp.failNext("createOrder", new PayPalError(503, "SERVICE_UNAVAILABLE", "try later", null));
    await expect(startAgentPayment(deps, a, 1000, URLS)).rejects.toBeInstanceOf(PayPalError);
    expect(await deps.db.select().from(agentPayments)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run apps/web/test/agent-payments.test.ts --maxWorkers=2`
Expected: FAIL, "Cannot find module '../lib/funding/agent-payments'".

- [ ] **Step 4: Write `lib/funding/agent-payments.ts`**

```ts
import { and, eq, gt, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { agentPayments } from "../db/schema";
import type { AgentOrders } from "../paypal/agent-toolkit";
import type { PaypalOrder } from "../paypal/api";
import { PayPalError } from "../paypal/client";
import { balanceCents, netCents } from "./ledger";
import { FundingError } from "./subscriptions";
import { creditCaptures, TOPUP_MAX_CENTS, TOPUP_MIN_CENTS } from "./topups";

export const AGENT_OPEN_LIMIT = 3;
export const AGENT_DAILY_CENTS = 10_000;
const OPEN_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AgentPaymentDeps {
  db: Db;
  orders: AgentOrders;
  now?: () => Date;
}

export type AgentPaymentResult =
  | { status: "added"; addedCents: number; budgetCents: number }
  | { status: "waiting" | "cancelled"; budgetCents: number };

/** Starts a PayPal order the developer's agent asked for. Nothing moves until the developer approves it in PayPal. */
export async function startAgentPayment(
  deps: AgentPaymentDeps,
  accountId: string,
  cents: number,
  urls: { returnUrl: string; cancelUrl: string },
): Promise<{ orderId: string; approveUrl: string; cents: number }> {
  if (!Number.isInteger(cents) || cents < TOPUP_MIN_CENTS || cents > TOPUP_MAX_CENTS) {
    throw new FundingError(400, "Payments from the agent can be from $1 to $500");
  }
  const now = deps.now?.() ?? new Date();
  const [open] = await deps.db
    .select({ n: sql<string>`count(*)` })
    .from(agentPayments)
    .where(and(eq(agentPayments.accountId, accountId), eq(agentPayments.status, "created"), gt(agentPayments.createdAt, new Date(now.getTime() - OPEN_MS))));
  if (Number(open?.n ?? 0) >= AGENT_OPEN_LIMIT) {
    throw new FundingError(429, "You already have 3 payments waiting for approval in PayPal. Approve one, or wait a few hours, then try again.");
  }
  const [day] = await deps.db
    .select({ total: sql<string>`coalesce(sum(${agentPayments.cents}), 0)` })
    .from(agentPayments)
    .where(and(eq(agentPayments.accountId, accountId), ne(agentPayments.status, "cancelled"), gt(agentPayments.createdAt, new Date(now.getTime() - DAY_MS))));
  if (Number(day?.total ?? 0) + cents > AGENT_DAILY_CENTS) {
    throw new FundingError(429, "Your agent can add at most $100 a day. Add more on the dashboard, or try again tomorrow.");
  }
  const order = await deps.orders.createOrder(cents, urls.returnUrl, urls.cancelUrl);
  await deps.db.insert(agentPayments).values({ orderId: order.id, accountId, cents, createdAt: now });
  return { orderId: order.id, approveUrl: order.approveUrl, cents };
}

/** Net of PayPal's fee, over the order's completed captures. */
function orderNetCents(order: PaypalOrder): number {
  return (order.purchase_units ?? [])
    .flatMap((u) => u.payments?.captures ?? [])
    .filter((c) => c.status === "COMPLETED")
    .reduce((sum, c) => sum + netCents(c.seller_receivable_breakdown?.net_amount, c.amount), 0);
}

/**
 * Checks a payment the agent started, for the account that started it: captures it once approved and credits it.
 * Safe to call any number of times; the budget is credited once per capture.
 */
export async function finishAgentPayment(deps: AgentPaymentDeps, accountId: string, orderId: string): Promise<AgentPaymentResult> {
  const [row] = await deps.db
    .select()
    .from(agentPayments)
    .where(and(eq(agentPayments.orderId, orderId), eq(agentPayments.accountId, accountId)))
    .limit(1);
  if (!row) throw new FundingError(404, "No such payment for this machine.");
  const now = deps.now?.() ?? new Date();
  const budget = () => balanceCents(deps.db, accountId);
  const cancel = async (): Promise<AgentPaymentResult> => {
    await deps.db.update(agentPayments).set({ status: "cancelled" }).where(eq(agentPayments.orderId, orderId));
    return { status: "cancelled", budgetCents: await budget() };
  };
  if (row.status === "cancelled") return { status: "cancelled", budgetCents: await budget() };

  let order: PaypalOrder;
  try {
    order = await deps.orders.getOrder(orderId);
  } catch (e) {
    if (e instanceof PayPalError && e.status === 404) return cancel();
    throw e;
  }
  if (order.status === "APPROVED") {
    try {
      order = await deps.orders.captureOrder(orderId);
    } catch (e) {
      if (!(e instanceof PayPalError)) throw e;
      order = await deps.orders.getOrder(orderId);
      if (order.status !== "COMPLETED") throw e;
    }
  }
  if (order.status === "COMPLETED") {
    await creditCaptures(deps.db, accountId, order, now);
    if (row.status !== "captured") await deps.db.update(agentPayments).set({ status: "captured", capturedAt: now }).where(eq(agentPayments.orderId, orderId));
    return { status: "added", addedCents: orderNetCents(order), budgetCents: await budget() };
  }
  if (order.status === "VOIDED") return cancel();
  return { status: "waiting", budgetCents: await budget() };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run apps/web/test/agent-payments.test.ts apps/web/test/topups.test.ts apps/web/test/db.test.ts --maxWorkers=2`
Expected: PASS (10 new tests; the top-up and migration tests still pass).

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/db/schema.ts apps/web/drizzle apps/web/lib/funding/agent-payments.ts apps/web/test/agent-payments.test.ts
git commit -m "Take payments the agent starts, within limits, crediting once"
```

---

### Task 3: The routes, the wiring and the return page

**Files:**
- Modify: `apps/web/lib/receipts/service.ts` (`Deps.agentOrders`), `apps/web/lib/deps.ts`, `apps/web/lib/funding/route.ts`
- Create: `apps/web/app/api/agent/payments/route.ts`, `apps/web/app/api/agent/payments/[id]/route.ts`, `apps/web/app/agent/paid/page.tsx`
- Test: `apps/web/test/agent-routes.test.ts`

**Interfaces:**
- Consumes: `AgentOrders`, `createAgentOrders`, `isSandboxBase` (Task 1); `startAgentPayment`, `finishAgentPayment`, `AgentPaymentDeps` (Task 2); `withAccount`, `json` (`lib/http.ts`); `publicOrigin(req)` (`lib/maintainers/http.ts`).
- Produces:
  - `POST /api/agent/payments` `{ cents: number }` -> 200 `{ orderId, approveUrl, cents }` | 400 | 401 | 429 | 502 | 503
  - `POST /api/agent/payments/:id` -> 200 `AgentPaymentResult` | 401 | 404 | 429 | 502 | 503
  - `withAgentPayments(req, fn: (deps: AgentPaymentDeps, accountId: string) => Promise<Response>): Promise<Response>` in `lib/funding/route.ts`
  - Page `/agent/paid` (and `/agent/paid?cancelled=1`)

- [ ] **Step 1: Write the failing tests**

`apps/web/test/agent-routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { createRateLimiter } from "../lib/limits";
import { PayPalError } from "../lib/paypal/client";
import { FakeAgentOrders } from "../lib/paypal/fake";
import type { Deps } from "../lib/receipts/service";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
const { POST: start } = await import("../app/api/agent/payments/route");
const { POST: finish } = await import("../app/api/agent/payments/[id]/route");

let orders: FakeAgentOrders;
let token: string;
beforeEach(async () => {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  orders = new FakeAgentOrders();
  h.deps = { db, http: async () => ({ status: 404, body: null }), model: null, agentOrders: orders };
  token = (await createDevice(db, null)).token;
  process.env.PUBLIC_URL = "https://up.test";
});
afterEach(() => {
  delete process.env.PUBLIC_URL;
});

const post = (url: string, body?: unknown, auth = true) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const finishFor = (id: string) => finish(post(`http://local/api/agent/payments/${id}`), { params: Promise.resolve({ id }) });

describe("agent payment routes", () => {
  it("start a payment for the machine's account, returning to this server's /agent/paid", async () => {
    const res = await start(post("http://local/api/agent/payments", { cents: 1000 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orderId: "ORDER-1", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1", cents: 1000 });
    expect(orders.urls.get("ORDER-1")).toEqual({ returnUrl: "https://up.test/agent/paid", cancelUrl: "https://up.test/agent/paid?cancelled=1" });
  });

  it("finish it: waiting before approval, added after", async () => {
    await start(post("http://local/api/agent/payments", { cents: 1000 }));
    expect(await (await finishFor("ORDER-1")).json()).toEqual({ status: "waiting", budgetCents: 0 });
    orders.pp.approveOrder("ORDER-1", "PAYER-A");
    expect(await (await finishFor("ORDER-1")).json()).toEqual({ status: "added", addedCents: 916, budgetCents: 916 });
  });

  it("refuse callers without a token, bad bodies, and unknown payments", async () => {
    expect((await start(post("http://local/api/agent/payments", { cents: 1000 }, false))).status).toBe(401);
    expect((await start(post("http://local/api/agent/payments", { dollars: 10 }))).status).toBe(400);
    expect((await start(post("http://local/api/agent/payments", { cents: 99 }))).status).toBe(400);
    expect((await finishFor("ORDER-NOPE")).status).toBe(404);
  });

  it("answer 503 when the server can't take agent payments, and 502 when PayPal fails", async () => {
    orders.pp.failNext("createOrder", new PayPalError(503, "SERVICE_UNAVAILABLE", "down", null));
    const failed = await start(post("http://local/api/agent/payments", { cents: 1000 }));
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toBe("PayPal couldn't start the payment. Try again in a minute.");
    h.deps = { ...h.deps, agentOrders: null };
    expect((await start(post("http://local/api/agent/payments", { cents: 1000 }))).status).toBe(503);
  });

  it("share the per-account request limit", async () => {
    h.deps = { ...h.deps, submitLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) };
    expect((await start(post("http://local/api/agent/payments", { cents: 1000 }))).status).toBe(200);
    expect((await start(post("http://local/api/agent/payments", { cents: 1000 }))).status).toBe(429);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/web/test/agent-routes.test.ts --maxWorkers=2`
Expected: FAIL, "Cannot find module '../app/api/agent/payments/route'".

- [ ] **Step 3: Wire the dependency**

In `apps/web/lib/receipts/service.ts`, inside `interface Deps` after `paypalIdentity`:

```ts
  /** PayPal's Agent Toolkit, for payments a developer's coding agent starts; null without PayPal credentials or off the sandbox. */
  agentOrders?: AgentOrders | null;
```

and add `import type { AgentOrders } from "../paypal/agent-toolkit";` to its imports.

In `apps/web/lib/deps.ts`, add `import { createAgentOrders, isSandboxBase } from "./paypal/agent-toolkit";` and, after `paypalIdentity`:

```ts
      agentOrders:
        process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && isSandboxBase(paypalApiBase(process.env.PAYPAL_API_BASE))
          ? createAgentOrders({
              clientId: process.env.PAYPAL_CLIENT_ID,
              clientSecret: process.env.PAYPAL_CLIENT_SECRET,
              apiBase: paypalApiBase(process.env.PAYPAL_API_BASE),
            })
          : null,
```

In `apps/web/lib/funding/route.ts`, add `import type { AgentPaymentDeps } from "./agent-payments";` and:

```ts
/** withAccount for payments the agent starts: needs the Agent Toolkit, shares the per-account request limit. */
export async function withAgentPayments(req: Request, fn: (deps: AgentPaymentDeps, accountId: string) => Promise<Response>): Promise<Response> {
  return withAccount(req, async (deps, accountId) => {
    if (!deps.agentOrders) return json({ error: "Payments from the agent aren't set up on this server yet" }, 503);
    if (deps.submitLimiter && !deps.submitLimiter.take(accountId)) return json({ error: "Too many requests this hour. Try again later." }, 429);
    try {
      return await fn({ db: deps.db, orders: deps.agentOrders }, accountId);
    } catch (e) {
      if (e instanceof FundingError) return json({ error: e.message }, e.status);
      if (e instanceof PayPalError) return json({ error: "PayPal couldn't complete that. Try again in a minute." }, 502);
      throw e;
    }
  });
}
```

- [ ] **Step 4: Write the routes**

`apps/web/app/api/agent/payments/route.ts`:

```ts
import { z } from "zod";
import { startAgentPayment } from "../../../../lib/funding/agent-payments";
import { withAgentPayments } from "../../../../lib/funding/route";
import { json } from "../../../../lib/http";
import { publicOrigin } from "../../../../lib/maintainers/http";
import { PayPalError } from "../../../../lib/paypal/client";

export const runtime = "nodejs";

const Body = z.object({ cents: z.number() });

export async function POST(req: Request): Promise<Response> {
  return withAgentPayments(req, async (deps, accountId) => {
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) return json({ error: "Say how much to add, in cents" }, 400);
    const origin = publicOrigin(req);
    try {
      return json(await startAgentPayment(deps, accountId, body.data.cents, { returnUrl: `${origin}/agent/paid`, cancelUrl: `${origin}/agent/paid?cancelled=1` }));
    } catch (e) {
      if (e instanceof PayPalError) return json({ error: "PayPal couldn't start the payment. Try again in a minute." }, 502);
      throw e;
    }
  });
}
```

`apps/web/app/api/agent/payments/[id]/route.ts`:

```ts
import { finishAgentPayment } from "../../../../../lib/funding/agent-payments";
import { withAgentPayments } from "../../../../../lib/funding/route";
import { json } from "../../../../../lib/http";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return withAgentPayments(req, async (deps, accountId) => {
    const { id } = await ctx.params;
    return json(await finishAgentPayment(deps, accountId, id));
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run apps/web/test/agent-routes.test.ts apps/web/test/api.test.ts --maxWorkers=2`
Expected: PASS (5 new tests; the existing API tests still pass).

- [ ] **Step 6: Write the return page**

`apps/web/app/agent/paid/page.tsx` (a static message page, checked in the Task 5 live run rather than by a unit test):

```tsx
import { CircleCheck, CircleX } from "lucide-react";
import type { Metadata } from "next";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Upstream payment" };

export default async function AgentPaid({ searchParams }: { searchParams: Promise<{ cancelled?: string }> }) {
  const cancelled = (await searchParams).cancelled === "1";
  return (
    <main className="mx-auto max-w-xl px-4 pt-16 pb-24">
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            {cancelled ? <CircleX className="size-5 text-muted-foreground" /> : <CircleCheck className="size-5 text-primary" />}
            {cancelled ? "You cancelled this payment" : "Payment approved"}
          </CardTitle>
          <CardDescription className="leading-relaxed">
            {cancelled
              ? "Nothing was charged. Ask your agent again whenever you want to add money."
              : "Go back to your coding agent and tell it you're done. It finishes the payment and tells you what was added to your budget."}
          </CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}
```

Run: `pnpm --filter web exec tsc --noEmit -p .`
Expected: no output (types check).

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/receipts/service.ts apps/web/lib/deps.ts apps/web/lib/funding/route.ts apps/web/app/api/agent apps/web/app/agent apps/web/test/agent-routes.test.ts
git commit -m "Add the agent payment routes and the PayPal return page"
```

---

### Task 4: The plugin tools and /upstream:fund

**Files:**
- Modify: `packages/cli/src/api.ts`, `packages/cli/src/mcp.ts`
- Create: `packages/cli/plugin/commands/fund.md`
- Test: `packages/cli/test/mcp.test.ts`

**Interfaces:**
- Consumes: the Task 3 routes; `GET /api/me` (`{ balanceCents, givenCents, subscription: { tier, status } | null, ... }`).
- Produces:
  - `api.addMoney(cents: number): Promise<AgentPaymentStart>`, `api.paymentStatus(orderId: string): Promise<AgentPaymentResult>`, `api.me(): Promise<BudgetView>`
  - `budgetTool(deps)`, `addMoneyTool(deps, { dollars })`, `paymentStatusTool(deps, { orderId })` in `src/mcp.ts`
  - MCP tools `upstream_budget`, `upstream_add_money`, `upstream_payment_status`; command `/upstream:fund <dollars>`

- [ ] **Step 1: Write the failing tests**

Add to `packages/cli/test/mcp.test.ts` (extend the imports to `import { addMoneyTool, approveTool, budgetTool, paymentStatusTool, receiptTool } from "../src/mcp";`):

```ts
describe("paying from the agent", () => {
  const sent: number[] = [];
  const statuses: Record<string, unknown> = {
    "ORDER-1": { status: "waiting", budgetCents: 434 },
    "ORDER-2": { status: "added", addedCents: 916, budgetCents: 1350 },
    "ORDER-3": { status: "cancelled", budgetCents: 434 },
  };
  const payApi = {
    addMoney: async (cents: number) => {
      sent.push(cents);
      return { orderId: "ORDER-9", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-9", cents };
    },
    paymentStatus: async (id: string) => {
      if (!statuses[id]) throw new Error("No such payment for this machine.");
      return statuses[id];
    },
    me: async () => ({ balanceCents: 1350, givenCents: 120, subscription: { tier: "starter", status: "ACTIVE" } }),
  } as unknown as Api;

  it("upstream_add_money sends exact cents and shows the PayPal link, saying nothing is charged until approved", async () => {
    const res = await addMoneyTool({ api: payApi }, { dollars: 9.99 });
    await addMoneyTool({ api: payApi }, { dollars: 10 });
    expect(sent).toEqual([999, 1000]);
    expect(res.content[0]!.text).toContain("https://www.sandbox.paypal.com/checkoutnow?token=ORDER-9");
    expect(res.content[0]!.text).toContain("$9.99");
    expect(res.content[0]!.text).toContain("Nothing is charged until you approve it");
    expect(res.content[0]!.text).toContain("ORDER-9");
  });

  it("upstream_payment_status words each outcome plainly", async () => {
    expect((await paymentStatusTool({ api: payApi }, { orderId: "ORDER-1" })).content[0]!.text).toContain("still waiting for you to approve");
    expect((await paymentStatusTool({ api: payApi }, { orderId: "ORDER-2" })).content[0]!.text).toBe(
      "Added $9.16 to your Upstream budget, after PayPal's fee. Your budget is now $13.50.",
    );
    expect((await paymentStatusTool({ api: payApi }, { orderId: "ORDER-3" })).content[0]!.text).toContain("Nothing was charged");
    const missing = await paymentStatusTool({ api: payApi }, { orderId: "ORDER-NOPE" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toBe("Upstream couldn't check the payment: No such payment for this machine.");
  });

  it("upstream_budget shows the budget, what's set aside, and the monthly plan", async () => {
    expect((await budgetTool({ api: payApi })).content[0]!.text).toBe(
      "Your Upstream budget: $13.50. Set aside for maintainers so far: $1.20. You give $5 a month.",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/cli/test/mcp.test.ts --maxWorkers=2`
Expected: FAIL, "addMoneyTool is not a function" (or a missing export error).

- [ ] **Step 3: Add the API calls**

In `packages/cli/src/api.ts`, above `createApi`:

```ts
export interface AgentPaymentStart {
  orderId: string;
  approveUrl: string;
  cents: number;
}
export type AgentPaymentResult = { status: "added"; addedCents: number; budgetCents: number } | { status: "waiting" | "cancelled"; budgetCents: number };
export interface BudgetView {
  balanceCents: number;
  givenCents: number;
  subscription: { tier: string; status: string } | null;
}
```

and inside the returned object:

```ts
    addMoney: (cents: number) => call<AgentPaymentStart>("POST", "/api/agent/payments", { cents }),
    paymentStatus: (orderId: string) => call<AgentPaymentResult>("POST", `/api/agent/payments/${encodeURIComponent(orderId)}`),
    me: () => call<BudgetView>("GET", "/api/me"),
```

- [ ] **Step 4: Add the tools**

In `packages/cli/src/mcp.ts`, after `approveTool`:

```ts
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const PLAN: Record<string, string> = { starter: "$5 a month", builder: "$15 a month", team: "$50 a month" };

export async function budgetTool(deps: Pick<McpDeps, "api">): Promise<ToolResult> {
  try {
    const me = await deps.api.me();
    const plan = me.subscription?.status === "ACTIVE" ? `You give ${PLAN[me.subscription.tier] ?? me.subscription.tier}.` : "No monthly plan.";
    return ok(`Your Upstream budget: ${usd(me.balanceCents)}. Set aside for maintainers so far: ${usd(me.givenCents)}. ${plan}`);
  } catch (e) {
    return err(`Upstream couldn't read your budget: ${reason(e)}`);
  }
}

export async function addMoneyTool(deps: Pick<McpDeps, "api">, args: { dollars: number }): Promise<ToolResult> {
  try {
    const p = await deps.api.addMoney(Math.round(args.dollars * 100));
    return ok(
      [
        `Open this link and approve the ${usd(p.cents)} payment in PayPal:`,
        p.approveUrl,
        "",
        `Nothing is charged until you approve it there. When you have, tell me and I'll finish it (payment ${p.orderId}).`,
      ].join("\n"),
    );
  } catch (e) {
    return err(`Upstream couldn't start the payment: ${reason(e)}`);
  }
}

export async function paymentStatusTool(deps: Pick<McpDeps, "api">, args: { orderId: string }): Promise<ToolResult> {
  try {
    const r = await deps.api.paymentStatus(args.orderId);
    if (r.status === "added") return ok(`Added ${usd(r.addedCents)} to your Upstream budget, after PayPal's fee. Your budget is now ${usd(r.budgetCents)}.`);
    if (r.status === "waiting") return ok("PayPal is still waiting for you to approve this payment. Open the link, approve it, then ask me to check again.");
    return ok("This payment was cancelled or expired in PayPal. Nothing was charged.");
  } catch (e) {
    return err(`Upstream couldn't check the payment: ${reason(e)}`);
  }
}
```

and in `buildServer`, after `upstream_approve`:

```ts
  server.registerTool(
    "upstream_budget",
    {
      description: "Show how much is in the user's Upstream budget, what has been set aside for open-source maintainers, and their monthly plan.",
      inputSchema: z.object({}),
    },
    () => budgetTool(deps),
  );
  server.registerTool(
    "upstream_add_money",
    {
      description:
        "Start a PayPal payment that adds money to the user's Upstream budget. Only call this when the user has asked to add a specific amount; never on your own initiative, and never change the amount without asking. Show the user the PayPal link it returns: nothing is charged until they approve it there.",
      inputSchema: z.object({ dollars: z.number().min(1).max(500) }),
    },
    (args) => addMoneyTool(deps, args),
  );
  server.registerTool(
    "upstream_payment_status",
    {
      description:
        "Finish an Upstream payment after the user says they approved it in PayPal: captures it and reports what was added. Only call it for a payment started with upstream_add_money.",
      inputSchema: z.object({ orderId: z.string().min(1) }),
    },
    (args) => paymentStatusTool(deps, args),
  );
```

- [ ] **Step 5: Add `/upstream:fund`**

`packages/cli/plugin/commands/fund.md`:

```markdown
---
description: Add money to your Upstream budget through PayPal
argument-hint: <dollars>
allowed-tools: ["mcp__plugin_upstream_upstream__upstream_add_money", "mcp__plugin_upstream_upstream__upstream_payment_status", "mcp__plugin_upstream_upstream__upstream_budget"]
---

The user wants to add $ARGUMENTS dollars to their Upstream budget.

1. If $ARGUMENTS isn't an amount between 1 and 500 dollars, ask how much, and stop.
2. Call `upstream_add_money` with that amount. Show the user the PayPal link exactly as returned, and say nothing is charged until they approve it.
3. Wait until the user says they've approved it. Then call `upstream_payment_status` with the payment id, and show its answer.
4. If PayPal is still waiting, say so and stop. Never start another payment unless the user asks.
```

- [ ] **Step 6: Run the tests and rebuild the plugin bundle**

Run: `npx vitest run packages/cli --maxWorkers=2 && pnpm --filter upstream-pay build`
Expected: PASS (28 CLI tests: 25 existing + 3 new), then "Build success".

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/api.ts packages/cli/src/mcp.ts packages/cli/plugin/commands/fund.md packages/cli/test/mcp.test.ts
git commit -m "Let the agent add money to the budget through PayPal"
```

---

### Task 5: Full suite, deploy, live sandbox run, docs

**Files:**
- Create: `docs/e2e-agent-payments.md`
- Modify: `README.md` (a "Pay from your agent" section), `packages/cli/package.json`, `packages/cli/src/main.ts`, `packages/cli/plugin/.claude-plugin/plugin.json` (version 0.2.0)

- [ ] **Step 1: Run the whole suite**

Run: `npx vitest run --maxWorkers=2 > /tmp/agent-full.log 2>&1; tail -5 /tmp/agent-full.log`
Expected: every test passes (about 370) with the Postgres-only test skipped as before.

- [ ] **Step 2: Push, and wait for Render's deploy**

Run: `git push -q origin main`, then poll `render deploys list srv-db7q3mdg1s2s73beth1g -o json --confirm` until the newest deploy is `live`.
Expected: `live` for the new commit. Then `curl -s -o /dev/null -w "%{http_code}" -X POST https://upstream-0s2y.onrender.com/api/agent/payments` answers 401 (the route exists and wants a token).

- [ ] **Step 3: The live sandbox run**

Link a throwaway machine and write a tiny caller for the new API calls (it never prints the token):

```bash
S=/private/tmp/claude-501/-Users-arunbrahma-Desktop-AltGAN-codepad/f82c2c00-b184-4c74-b057-c515963e09ec/scratchpad/agentrun
rm -rf $S && mkdir -p $S
UPSTREAM_CONFIG_DIR=$S node packages/cli/plugin/dist/upstream.mjs init --label agent-payments-check
cat > $S/run.mts <<'EOF'
import { readFileSync } from "node:fs";
import { createApi } from "/Users/arunbrahma/Desktop/AltGAN/codepad/hackathons/upstream/packages/cli/src/api.ts";
const cfg = JSON.parse(readFileSync(`${process.argv[2]}/config.json`, "utf8"));
const api = createApi(cfg.apiUrl, cfg.token);
const [cmd, arg] = process.argv.slice(3);
const out = cmd === "add" ? await api.addMoney(Number(arg)) : cmd === "status" ? await api.paymentStatus(arg!) : await api.me();
console.log(JSON.stringify(out));
EOF
node --import tsx $S/run.mts $S add 1000
```

Expected: `{"orderId":"...","approveUrl":"https://www.sandbox.paypal.com/checkoutnow?token=...","cents":1000}`.

Then:
1. Open `approveUrl` in a private browser window with browser-harness (a fresh browser context), sign in as the sandbox buyer from `devpost/sandbox-buyer.txt`, and approve. Expected: PayPal returns to `https://upstream-0s2y.onrender.com/agent/paid`, which reads "Payment approved".
2. `node --import tsx $S/run.mts $S status <orderId>` -> `{"status":"added","addedCents":916,...}` (about $9.16 after PayPal's fee).
3. `node --import tsx $S/run.mts $S me` -> `balanceCents` up by the same amount.
4. `node --import tsx $S/run.mts $S status <orderId>` again -> the same answer, and the budget unchanged (credited once).
5. Close the private window.

Record the run, with the order id, amounts and timings, in `docs/e2e-agent-payments.md`.

- [ ] **Step 4: README and version**

Add to `README.md`, after "Use it from Claude Code":

```markdown
## Pay from your agent

Ask your coding agent to "add $10 to my Upstream budget", or run `/upstream:fund 10`. The agent starts a PayPal payment and shows you the link; you approve it in PayPal, and the agent finishes it and tells you what was added. Upstream's server creates and captures the order with PayPal's Agent Toolkit, allowed only to create, read and capture orders, on the sandbox. Your agent can't move money without your approval in PayPal, a payment is $1 to $500, and your agent can add at most $100 a day.
```

Bump `upstream-pay` to `0.2.0` in `packages/cli/package.json`, `packages/cli/src/main.ts` (`.version("0.2.0")`) and `plugin/.claude-plugin/plugin.json`, rebuild with `pnpm --filter upstream-pay build`.

- [ ] **Step 5: Commit and push**

```bash
git add README.md docs/e2e-agent-payments.md packages/cli/package.json packages/cli/src/main.ts packages/cli/plugin/.claude-plugin/plugin.json
git commit -m "Record the live agent payment run and release the plugin as 0.2.0"
git push -q origin main
```

- [ ] **Step 6: Ask Arun before publishing to npm**

Publishing `upstream-pay@0.2.0` needs Arun's security key. Ask him; on his OK, run the same pseudo-terminal publish used for 0.1.0 (`script -q /dev/null npm publish --access public --auth-type=web` in `packages/cli`, open the approval link for him), then confirm with `npm view upstream-pay version` -> `0.2.0`.
