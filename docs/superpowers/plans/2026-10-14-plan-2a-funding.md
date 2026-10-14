# Upstream Plan 2a: Funding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A funder opens their dashboard from the CLI, subscribes ($5 / $15 / $50 a month) or tops up once through PayPal, and watches their Upstream budget fill from real PayPal sandbox payments. They can also turn on "auto-approve receipts while funded". No money goes out in this plan; Payouts come in Plan 2b.

**Architecture:**
- **PayPal client:** a small module that owns OAuth token caching and request IDs, with typed wrappers for Catalog, Plans, Subscriptions, Orders and Webhook verification.
- **Ledger:** money in is recorded in a `funding_events` table, keyed by PayPal's own transaction or capture id, so recording twice is harmless.
- **Reconcile instead of trusting events:** the server rebuilds the truth from PayPal's API, reading the subscription and its transactions. It does this when the buyer approves and whenever a verified webhook arrives, so local development works with no public URL.
- **Web login:** the dashboard uses a session cookie, obtained through a one-time login link the CLI fetches with its device token.

**Tech Stack:** Plan 1's stack, plus `@paypal/react-paypal-js` 10.6.0 (the `./sdk-v6` entry, React 19) and the PayPal REST v1/v2 APIs (sandbox).

**Spec:** `docs/superpowers/specs/2026-10-14-upstream-design.md`. This plan implements:
- section 2 steps 2 and 4 (funding and the auto-approve rule)
- section 7 "Funding" and the spending rule
- section 10 "PayPal" error handling

Allocation, settlement, Payouts and maintainers are Plan 2b. Polished UI is Plan 3.

**Verified 14 Oct 2026:** every task was applied in a scratch worktree of `main`:
- 176 tests pass across 30 files, the workspace typechecks, and `next build` lists `/dashboard`, `/connect` and the 12 API routes.
- Against the **live sandbox**, `ensureCatalog` created the product and three plans and returned the same ids on a second run.
- `createSubscription`, `getSubscription`, `createOrder` and `getOrder` round-trip `custom_id`.
- Capturing an unapproved order returns `422 ORDER_NOT_APPROVED`.

Two fixes from that run are already in the tasks:
- PayPal **404s** the transaction list of a not-yet-approved subscription, so reconcile skips or tolerates it (Task 5, mirrored in the fake).
- Plan 1's CLI test fake gained `loginLink` (Task 4).

**Builds on:** Plan 1 on `main`. The ledger is `docs/superpowers/plans/2026-10-14-plan-1-ledger.md`. Its rulings that matter here:
- The sandbox app lives on the **US** business account.
- Log in with PayPal has no localhost return URL. That's not needed in 2a.
- The judge is `gemini-2.5-flash-lite`.
- Rate limiters: `createRateLimiter`, plus `submitLimiter`/`deviceLimiter` in `Deps`.

## Global Constraints

- All of Plan 1's Global Constraints still apply (versions, ESM, strict TS, single-line commits, no attribution, plain user copy, no em dashes).
- **New dependency, exactly:** `@paypal/react-paypal-js@10.6.0` in `apps/web`. Nothing else.
- **Money:** USD only, stored as integer cents. Never use floats for money. Convert PayPal's decimal strings with `toCents("4.53") === 453`.
- **What counts as budget:** the **net** amount after PayPal's fee (`net_amount` / `seller_receivable_breakdown.net_amount`), falling back to gross only when PayPal omits net.
- **Idempotency:** every funding event is unique on `paypal_id` (sale or capture id). Every POST to PayPal sends a `PayPal-Request-Id`.
- **Ownership:** a subscription or order belongs to the account in its `custom_id`. A request that tries to reconcile or capture another account's object is refused.
- **Webhooks:** accepted only after `POST /v1/notifications/verify-webhook-signature` returns `SUCCESS` for `PAYPAL_WEBHOOK_ID`. Without `PAYPAL_WEBHOOK_ID` the endpoint answers 503 and does nothing.
- **Cookie-auth mutations** (POST/PATCH with the session cookie, no Bearer token) require an `Origin` header matching the request host. The session cookie is `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` in production.
- **Secrets** (`PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`) stay server-side. Only `NEXT_PUBLIC_PAYPAL_CLIENT_ID` reaches the browser.
- **Top-up bounds:** $1.00 to $500.00 (100 to 50000 cents).

## Review Focus

1. **A webhook or reconcile that runs twice, or concurrently, for the same PayPal payment.** It must record the money exactly once. A second `PAYMENT.SALE.COMPLETED` with a new event id but the same sale id must not double the budget. The test lives in Task 5 (reconcile) and Task 7 (webhook).
2. **One account touching another account's PayPal objects.** Account B calling reconcile on A's subscription id, or capturing A's order id, must be refused, and no money may be credited to B. The test lives in Tasks 5 and 6.
3. **A forged or replayed webhook**: a bad signature, missing headers, or a valid event whose resource belongs to no known account. The response is 400 or 200-ignored, and nothing is credited. The test lives in Task 7.
4. **A login link used twice, or after it expired**: the second use and any use after 10 minutes are refused. A session cookie on a cross-site POST must not work. The test lives in Task 4.
5. **PayPal returning an error or timing out mid-flow** (a 5xx on capture, a 422 `ORDER_ALREADY_CAPTURED`). The user gets a clear message, nothing half-recorded, and a retry that is safe. `ORDER_ALREADY_CAPTURED` is treated as "fetch the order and record its capture". The test lives in Task 6.

## File Structure

```
apps/web/
  lib/paypal/
    money.ts            toCents / fromCents (string <-> integer cents)
    client.ts           createPayPal(): token cache, request ids, PayPalError
    api.ts              typed wrappers: products, plans, subscriptions, orders, webhooks
    fake.ts             in-memory FakePayPal used by tests (implements PayPalApi)
    plans.ts            TIERS and plan-id config from env
  scripts/paypal-setup.ts          idempotent product + 3 plans, prints/writes env lines
  lib/db/schema.ts                 + web_sessions, login_codes, subscriptions, funding_events, webhook_events, account_settings
  drizzle/0001_*.sql               generated, additive only
  lib/web-auth.ts                  login codes, sessions, cookie helpers, same-origin check
  lib/http.ts                      withAccount(): Bearer OR session cookie (+ same-origin for cookie mutations)
  lib/funding/ledger.ts            recordFunding (idempotent), fundedCents
  lib/funding/subscriptions.ts     startSubscription, reconcileSubscription
  lib/funding/topups.ts            startTopup, completeTopup
  lib/funding/webhooks.ts          handleWebhook (verify, dedupe, dispatch)
  lib/funding/settings.ts          getSettings, setAutoApprove
  lib/receipts/service.ts          + auto-approve after judging
  app/api/login-links/route.ts     POST (Bearer)  -> { url }
  app/connect/route.ts             GET ?code=     -> cookie + redirect /dashboard
  app/api/me/route.ts              GET            -> funding summary for the dashboard
  app/api/subscriptions/route.ts               POST { tier } -> { subscriptionId }
  app/api/subscriptions/[id]/reconcile/route.ts POST -> summary
  app/api/topups/route.ts                      POST { cents } -> { orderId }
  app/api/topups/[id]/capture/route.ts         POST -> summary
  app/api/settings/route.ts                    PATCH { autoApprove }
  app/api/paypal/webhook/route.ts              POST (signature-verified)
  app/dashboard/page.tsx + app/dashboard/FundingPanel.tsx   minimal working UI (Plan 3 styles it)
  test/paypal-client.test.ts, test/funding.test.ts, test/webhooks.test.ts, test/web-auth.test.ts, test/funding-api.test.ts
packages/cli/src/commands.ts + main.ts      + `upstream dashboard`
```

---
### Task 1: PayPal client, typed API and an in-memory fake

**Files:**
- Modify: `apps/web/package.json` (add `"@paypal/react-paypal-js": "10.6.0"` to `dependencies`)
- Create: `apps/web/lib/paypal/money.ts`, `apps/web/lib/paypal/client.ts`, `apps/web/lib/paypal/api.ts`, `apps/web/lib/paypal/fake.ts`
- Test: `apps/web/test/paypal-client.test.ts`

**Interfaces:**
- Produces:
  - `toCents(value: string): number`, `fromCents(cents: number): string`
  - `PayPalError { status: number; code: string; debugId: string | null }`
  - `createPayPalHttp(cfg): PayPalHttp`, `PayPalHttp.request<T>(method, path, body?, { requestId? })`, `SANDBOX_API`
  - `PayPalApi` (interface) and `createPayPalApi(http): PayPalApi`, with methods:
    - `findProductByName`, `createProduct`, `listPlans`, `createPlan`
    - `createSubscription`, `getSubscription`, `listSubscriptionTransactions`
    - `createOrder`, `getOrder`, `captureOrder`
    - `verifyWebhookSignature`
  - Types `Money`, `PaypalSubscription`, `PaypalSubscriptionTxn`, `PaypalCapture`, `PaypalOrder`
  - `FakePayPal implements PayPalApi`, with test helpers:
    - `approveSubscription(id, payerId)`, `addSubscriptionPayment(id, txnId, netCents, status?)`
    - `approveOrder(id, payerId)`, `failNext(method, error)`
    - `signatureValid: boolean`, `calls: string[]`

- [ ] **Step 1: Add the dependency**

In `apps/web/package.json`, add `"@paypal/react-paypal-js": "10.6.0"` to `dependencies` (keep the keys sorted). Then run `pnpm install`.
Expected: completes, adding `@paypal/react-paypal-js 10.6.0`.

- [ ] **Step 2: Write the failing test**

`apps/web/test/paypal-client.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createPayPalApi } from "../lib/paypal/api";
import { createPayPalHttp, PayPalError } from "../lib/paypal/client";
import { fromCents, toCents } from "../lib/paypal/money";

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

const token = { status: 200, body: { access_token: "tok-1", expires_in: 3600 } };
const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);

describe("money", () => {
  it("converts PayPal decimal strings to integer cents and back", () => {
    expect(toCents("4.53")).toBe(453);
    expect(toCents("10")).toBe(1000);
    expect(toCents("0.5")).toBe(50);
    expect(fromCents(453)).toBe("4.53");
    expect(fromCents(5)).toBe("0.05");
    expect(() => toCents("-1.00")).toThrow();
    expect(() => toCents("1.234")).toThrow();
    expect(() => fromCents(1.5)).toThrow();
  });
});

describe("createPayPalHttp", () => {
  it("logs in once, reuses the token, and sends a request id on POST", async () => {
    const f = fakeFetch([token, { status: 200, body: { id: "A" } }, { status: 200, body: { id: "B" } }]);
    const http = createPayPalHttp({ clientId: "id", clientSecret: "secret", baseUrl: "https://api.test", fetchImpl: f.impl });
    await http.request("GET", "/v1/a");
    await http.request("POST", "/v1/b", { x: 1 }, { requestId: "req-42" });
    expect(f.calls.map((c) => c.url)).toEqual(["https://api.test/v1/oauth2/token", "https://api.test/v1/a", "https://api.test/v1/b"]);
    expect(header(f.calls[0]!, "authorization")).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
    expect(header(f.calls[1]!, "authorization")).toBe("Bearer tok-1");
    expect(header(f.calls[1]!, "paypal-request-id")).toBeNull();
    expect(header(f.calls[2]!, "paypal-request-id")).toBe("req-42");
  });

  it("logs in again after the token expires", async () => {
    let t = 0;
    const f = fakeFetch([token, { status: 200, body: {} }, { status: 200, body: { access_token: "tok-2", expires_in: 3600 } }, { status: 200, body: {} }]);
    const http = createPayPalHttp({ clientId: "id", clientSecret: "s", baseUrl: "https://api.test", fetchImpl: f.impl, now: () => t });
    await http.request("GET", "/v1/a");
    t = 3600_000;
    await http.request("GET", "/v1/a");
    expect(header(f.calls[3]!, "authorization")).toBe("Bearer tok-2");
  });

  it("raises PayPalError with the issue code PayPal reports", async () => {
    const f = fakeFetch([token, { status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "Order already captured", debug_id: "dbg1", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } }]);
    const http = createPayPalHttp({ clientId: "id", clientSecret: "s", baseUrl: "https://api.test", fetchImpl: f.impl });
    const err = await http.request("POST", "/v2/checkout/orders/X/capture", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ status: 422, code: "ORDER_ALREADY_CAPTURED", debugId: "dbg1" });
  });

  it("fails clearly when PayPal login is refused", async () => {
    const f = fakeFetch([{ status: 401, body: { error: "invalid_client", error_description: "Client Authentication failed" } }]);
    const http = createPayPalHttp({ clientId: "id", clientSecret: "bad", baseUrl: "https://api.test", fetchImpl: f.impl });
    await expect(http.request("GET", "/v1/a")).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_FAILURE" });
  });
});

describe("createPayPalApi", () => {
  it("builds the subscription, order and webhook-verification requests PayPal expects", async () => {
    const f = fakeFetch([
      token,
      { status: 201, body: { id: "I-SUB", status: "APPROVAL_PENDING", plan_id: "P-1" } },
      { status: 201, body: { id: "ORDER1", status: "CREATED" } },
      { status: 200, body: { verification_status: "SUCCESS" } },
      { status: 200, body: { transactions: [{ id: "S1", status: "COMPLETED" }] } },
    ]);
    const api = createPayPalApi(createPayPalHttp({ clientId: "id", clientSecret: "s", baseUrl: "https://api.test", fetchImpl: f.impl }));
    await api.createSubscription("P-1", "acct-1");
    await api.createOrder(1000, "acct-1", "Top-up");
    const ok = await api.verifyWebhookSignature({
      headers: { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://c", "paypal-transmission-id": "t1", "paypal-transmission-sig": "sig", "paypal-transmission-time": "2026-10-14T00:00:00Z" },
      webhookId: "WH-1",
      event: { id: "E1" },
    });
    const txns = await api.listSubscriptionTransactions("I-SUB", "2026-10-01T00:00:00.000Z", "2026-10-14T00:00:00.000Z");
    expect(ok).toBe(true);
    expect(txns).toEqual([{ id: "S1", status: "COMPLETED" }]);
    const bodies = f.calls.slice(1).map((c) => (c.init.body ? JSON.parse(String(c.init.body)) : null));
    expect(bodies[0]).toMatchObject({ plan_id: "P-1", custom_id: "acct-1" });
    expect(bodies[1]).toMatchObject({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" }, custom_id: "acct-1" }] });
    expect(bodies[2]).toMatchObject({ auth_algo: "SHA256withRSA", transmission_id: "t1", webhook_id: "WH-1", webhook_event: { id: "E1" } });
    expect(f.calls[4]!.url).toBe("https://api.test/v1/billing/subscriptions/I-SUB/transactions?start_time=2026-10-01T00%3A00%3A00.000Z&end_time=2026-10-14T00%3A00%3A00.000Z");
  });

  it("treats missing webhook headers as a failed verification without calling PayPal", async () => {
    const f = fakeFetch([]);
    const api = createPayPalApi(createPayPalHttp({ clientId: "id", clientSecret: "s", baseUrl: "https://api.test", fetchImpl: f.impl }));
    expect(await api.verifyWebhookSignature({ headers: { "paypal-auth-algo": null }, webhookId: "WH-1", event: {} })).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test apps/web/test/paypal-client.test.ts`
Expected: FAIL, because `../lib/paypal/api`, `../lib/paypal/client` and `../lib/paypal/money` can't be resolved.

- [ ] **Step 4: Write `apps/web/lib/paypal/money.ts`**

```ts
/** "4.53" -> 453. Only plain non-negative decimals with at most two places are accepted. */
export function toCents(value: string): number {
  const m = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`not a money amount: ${value}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** 453 -> "4.53". */
export function fromCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`not a whole number of cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
```

- [ ] **Step 5: Write `apps/web/lib/paypal/client.ts`**

```ts
import { randomUUID } from "node:crypto";

export const SANDBOX_API = "https://api-m.sandbox.paypal.com";

export class PayPalError extends Error {
  constructor(
    public readonly status: number,
    /** PayPal's issue code, e.g. ORDER_ALREADY_CAPTURED, or its error name. */
    public readonly code: string,
    message: string,
    public readonly debugId: string | null,
  ) {
    super(message);
  }
}

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface PayPalHttp {
  request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, opts?: { requestId?: string }): Promise<T>;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { message: text.slice(0, 200) };
  }
}

/** PayPal REST client: caches the OAuth token until a minute before expiry and sends a request id on every write. */
export function createPayPalHttp(cfg: PayPalConfig): PayPalHttp {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const now = cfg.now ?? Date.now;
  const timeout = () => AbortSignal.timeout(cfg.timeoutMs ?? 20000);
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && now() < token.expiresAt) return token.value;
    const res = await fetchImpl(`${cfg.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: timeout(),
    });
    const data = await readJson(res);
    if (!res.ok || typeof data.access_token !== "string") {
      throw new PayPalError(res.status, "AUTHENTICATION_FAILURE", String(data.error_description ?? "PayPal login failed"), null);
    }
    const ttl = typeof data.expires_in === "number" ? data.expires_in : 0;
    token = { value: data.access_token, expiresAt: now() + Math.max(0, ttl - 60) * 1000 };
    return token.value;
  }

  return {
    async request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, opts?: { requestId?: string }): Promise<T> {
      const headers: Record<string, string> = {
        authorization: `Bearer ${await accessToken()}`,
        "content-type": "application/json",
        prefer: "return=representation",
      };
      if (method !== "GET") headers["paypal-request-id"] = opts?.requestId ?? randomUUID();
      const res = await fetchImpl(`${cfg.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeout(),
      });
      if (res.status === 401) token = null; // expired or revoked: log in again next time
      const data = await readJson(res);
      if (!res.ok) {
        const details = Array.isArray(data.details) ? (data.details as Array<{ issue?: string }>) : [];
        throw new PayPalError(
          res.status,
          details[0]?.issue ?? String(data.name ?? "PAYPAL_ERROR"),
          String(data.message ?? `PayPal returned ${res.status}`),
          typeof data.debug_id === "string" ? data.debug_id : null,
        );
      }
      return data as T;
    },
  };
}
```

- [ ] **Step 6: Write `apps/web/lib/paypal/api.ts`**

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
  };
}
```

- [ ] **Step 7: Write `apps/web/lib/paypal/fake.ts`**

```ts
import type { PayPalApi, PaypalOrder, PaypalSubscription, PaypalSubscriptionTxn, WebhookVerification } from "./api";
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
  private failures = new Map<string, Error>();
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
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm test apps/web/test/paypal-client.test.ts`
Expected: PASS, 7 tests.

Run: `pnpm exec tsc -p apps/web`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/lib/paypal apps/web/test/paypal-client.test.ts
git commit -m "Add PayPal REST client, typed API and an in-memory fake"
```

---

### Task 2: Tiers, catalog setup and the sandbox setup script

**Files:**
- Create: `apps/web/lib/paypal/plans.ts`, `apps/web/scripts/paypal-setup.ts`
- Modify: `apps/web/package.json` (script `"paypal:setup": "node --env-file=.env.local --import tsx scripts/paypal-setup.ts"`)
- Test: `apps/web/test/paypal-plans.test.ts`

**Interfaces:**
- Consumes (Task 1): `PayPalApi`, `FakePayPal`, `fromCents`, `createPayPalApi`, `createPayPalHttp`, `SANDBOX_API`
- Produces:
  - `TIERS` (`{ key, cents, label }[]` for starter 500, builder 1500, team 5000), `TierKey`, `TIER_KEYS`
  - `PRODUCT_NAME`, `planName(cents)`, `planIdsFromEnv(env?)`
  - `ensureCatalog(api): Promise<{ productId; planIds: Record<TierKey, string>; envLines: string[] }>`
  - Env: `PAYPAL_PLAN_STARTER`, `PAYPAL_PLAN_BUILDER`, `PAYPAL_PLAN_TEAM`

- [ ] **Step 1: Write the failing test**

`apps/web/test/paypal-plans.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { FakePayPal } from "../lib/paypal/fake";
import { ensureCatalog, planIdsFromEnv, planName, TIERS } from "../lib/paypal/plans";

describe("ensureCatalog", () => {
  it("creates the product and one monthly plan per tier, and creates nothing the second time", async () => {
    const pp = new FakePayPal();
    const first = await ensureCatalog(pp);
    const second = await ensureCatalog(pp);
    expect(second).toEqual(first);
    expect(pp.calls.filter((c) => c === "createProduct")).toHaveLength(1);
    expect(pp.calls.filter((c) => c === "createPlan")).toHaveLength(3);
    expect([...pp.plans.values()].map((p) => [p.name, p.cents])).toEqual(TIERS.map((t) => [planName(t.cents), t.cents]));
    expect(first.envLines).toEqual([
      `PAYPAL_PLAN_STARTER=${first.planIds.starter}`,
      `PAYPAL_PLAN_BUILDER=${first.planIds.builder}`,
      `PAYPAL_PLAN_TEAM=${first.planIds.team}`,
    ]);
  });
});

describe("planIdsFromEnv", () => {
  it("reads only the tiers that are configured", () => {
    expect(planIdsFromEnv({ PAYPAL_PLAN_STARTER: "P-1", PAYPAL_PLAN_TEAM: "P-3" })).toEqual({ starter: "P-1", team: "P-3" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test apps/web/test/paypal-plans.test.ts`
Expected: FAIL, because `../lib/paypal/plans` can't be resolved.

- [ ] **Step 3: Write `apps/web/lib/paypal/plans.ts`**

```ts
import type { PayPalApi } from "./api";
import { fromCents } from "./money";

export const TIERS = [
  { key: "starter", cents: 500, label: "$5 a month" },
  { key: "builder", cents: 1500, label: "$15 a month" },
  { key: "team", cents: 5000, label: "$50 a month" },
] as const;

export type TierKey = (typeof TIERS)[number]["key"];
export const TIER_KEYS = TIERS.map((t) => t.key) as [TierKey, ...TierKey[]];

export const PRODUCT_NAME = "Upstream open-source budget";
export const planName = (cents: number) => `Upstream ${fromCents(cents)} USD a month`;

const ENV_NAMES: Record<TierKey, string> = {
  starter: "PAYPAL_PLAN_STARTER",
  builder: "PAYPAL_PLAN_BUILDER",
  team: "PAYPAL_PLAN_TEAM",
};

export function planIdsFromEnv(env: Record<string, string | undefined> = process.env): Partial<Record<TierKey, string>> {
  const out: Partial<Record<TierKey, string>> = {};
  for (const t of TIERS) {
    const v = env[ENV_NAMES[t.key]];
    if (v) out[t.key] = v;
  }
  return out;
}

/** Creates the product and one active monthly plan per tier when they're missing. Safe to run again. */
export async function ensureCatalog(api: PayPalApi): Promise<{ productId: string; planIds: Record<TierKey, string>; envLines: string[] }> {
  const product =
    (await api.findProductByName(PRODUCT_NAME)) ??
    (await api.createProduct(PRODUCT_NAME, "A monthly budget your AI coding agent pays to the open source it uses"));
  const existing = await api.listPlans(product.id);
  const planIds = {} as Record<TierKey, string>;
  for (const t of TIERS) {
    const found = existing.find((p) => p.name === planName(t.cents) && p.status === "ACTIVE");
    planIds[t.key] = found ? found.id : (await api.createPlan(product.id, planName(t.cents), t.cents)).id;
  }
  return { productId: product.id, planIds, envLines: TIERS.map((t) => `${ENV_NAMES[t.key]}=${planIds[t.key]}`) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test apps/web/test/paypal-plans.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the setup script and run it against the sandbox**

`apps/web/scripts/paypal-setup.ts`:
```ts
import { readFileSync, writeFileSync } from "node:fs";
import { createPayPalApi } from "../lib/paypal/api";
import { createPayPalHttp, SANDBOX_API } from "../lib/paypal/client";
import { ensureCatalog } from "../lib/paypal/plans";

const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in apps/web/.env.local first.");
  process.exit(1);
}
const api = createPayPalApi(createPayPalHttp({ clientId, clientSecret, baseUrl: process.env.PAYPAL_API_BASE ?? SANDBOX_API }));
const { productId, envLines } = await ensureCatalog(api);
const lines = [...envLines, `NEXT_PUBLIC_PAYPAL_CLIENT_ID=${clientId}`];
console.log(`product ${productId}`);
for (const line of envLines) console.log(line);

if (process.argv.includes("--write")) {
  const path = new URL("../.env.local", import.meta.url);
  let text = readFileSync(path, "utf8");
  for (const line of lines) {
    const key = line.slice(0, line.indexOf("="));
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(path, text);
  console.log("written to apps/web/.env.local");
}
```

Add `"paypal:setup": "node --env-file=.env.local --import tsx scripts/paypal-setup.ts"` to the `apps/web/package.json` scripts.

Run: `pnpm --filter web paypal:setup -- --write`
Expected:
- `product PROD-...` and three `PAYPAL_PLAN_*=P-...` lines
- `written to apps/web/.env.local`, which now also has `NEXT_PUBLIC_PAYPAL_CLIENT_ID`

Run it again.
Expected: the same ids. No new product or plans appear in the sandbox dashboard.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/paypal/plans.ts apps/web/scripts/paypal-setup.ts apps/web/package.json apps/web/test/paypal-plans.test.ts
git commit -m "Create the PayPal product and monthly plans idempotently"
```

---

### Task 3: Funding tables

**Files:**
- Modify: `apps/web/lib/db/schema.ts`
- Generated: `apps/web/drizzle/0001_*.sql`, `apps/web/drizzle/meta/*`
- Test: `apps/web/test/funding-schema.test.ts`

**Interfaces:**
- Consumes (Task 2): `TIER_KEYS`
- Produces the tables:
  - `webSessions` (`idHash`, `accountId`, `expiresAt`)
  - `loginCodes` (`codeHash`, `accountId`, `expiresAt`, `usedAt`)
  - `subscriptions` (`id` = PayPal subscription id, `accountId`, `tier`, `status`, `payerId`)
  - `fundingEvents` (`paypalId` PK, `accountId`, `source`, `amountCents`, `payerId`, `occurredAt`, `raw`)
  - `webhookEvents` (`id` = PayPal event id, `eventType`, `outcome`)
  - `accountSettings` (`accountId` PK, `autoApprove`)

- [ ] **Step 1: Write the failing test**

`apps/web/test/funding-schema.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { accountSettings, fundingEvents, loginCodes, subscriptions, webhookEvents, webSessions } from "../lib/db/schema";

describe("funding tables", () => {
  it("are created by migrations and enforce one row per PayPal id", async () => {
    const db = createPgliteDb();
    await migrateDb(db, "pglite");
    const { accountId } = await createDevice(db, null);
    const later = new Date(Date.now() + 60_000);
    await db.insert(webSessions).values({ idHash: "s", accountId, expiresAt: later });
    await db.insert(loginCodes).values({ codeHash: "c", accountId, expiresAt: later });
    await db.insert(subscriptions).values({ id: "I-1", accountId, tier: "starter", status: "APPROVAL_PENDING" });
    await db.insert(webhookEvents).values({ id: "WH-1", eventType: "X", outcome: "ignored" });
    await db.insert(accountSettings).values({ accountId });
    const event = { paypalId: "SALE-1", accountId, source: "subscription" as const, amountCents: 453, occurredAt: new Date() };
    await db.insert(fundingEvents).values(event);
    await expect(db.insert(fundingEvents).values(event)).rejects.toThrow();
    const [settings] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, accountId));
    expect(settings!.autoApprove).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test apps/web/test/funding-schema.test.ts`
Expected: FAIL, because the new tables aren't exported from `../lib/db/schema`.

- [ ] **Step 3: Add the tables to `apps/web/lib/db/schema.ts`**

Change the `drizzle-orm/pg-core` import to include `boolean`, and add `import { TIER_KEYS } from "../paypal/plans";`. Then append:
```ts
const tz = { withTimezone: true } as const;

export const webSessions = pgTable("web_sessions", {
  idHash: text("id_hash").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", tz).notNull(),
});

export const loginCodes = pgTable("login_codes", {
  codeHash: text("code_hash").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", tz).notNull(),
  usedAt: timestamp("used_at", tz),
});

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    tier: text("tier", { enum: TIER_KEYS }).notNull(),
    status: text("status").notNull(),
    payerId: text("payer_id"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
  },
  (t) => [index("subscriptions_account").on(t.accountId)],
);

export const fundingEvents = pgTable(
  "funding_events",
  {
    paypalId: text("paypal_id").primaryKey(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    source: text("source", { enum: ["subscription", "topup"] }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    payerId: text("payer_id"),
    occurredAt: timestamp("occurred_at", tz).notNull(),
    createdAt: createdAt(),
    raw: jsonb("raw"),
  },
  (t) => [index("funding_events_account").on(t.accountId)],
);

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  outcome: text("outcome").notNull(),
  receivedAt: timestamp("received_at", tz).notNull().defaultNow(),
});

export const accountSettings = pgTable("account_settings", {
  accountId: uuid("account_id").primaryKey().references(() => accounts.id),
  autoApprove: boolean("auto_approve").notNull().default(false),
  updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
});
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter web db:generate`
Expected: a new `apps/web/drizzle/0001_*.sql` containing only `CREATE TABLE` statements (and their indexes and foreign keys) for the six new tables. If it asks whether a table was renamed, stop. That means an existing table changed by mistake, and the schema edit needs another look.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test apps/web/test/funding-schema.test.ts apps/web/test/db.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/db/schema.ts apps/web/drizzle apps/web/test/funding-schema.test.ts
git commit -m "Add funding, session and settings tables"
```

---

### Task 4: Web login: one-time links, session cookie, `upstream dashboard`

**Files:**
- Create: `apps/web/lib/web-auth.ts`, `apps/web/app/api/login-links/route.ts`, `apps/web/app/connect/route.ts`
- Modify: `apps/web/lib/http.ts` (`withAccount` accepts a session cookie), `packages/cli/src/api.ts` (+ `loginLink`), `packages/cli/test/commands.test.ts` (fake gains `loginLink`), `packages/cli/src/commands.ts` (+ `dashboardCommand`), `packages/cli/src/main.ts` (+ `dashboard` command)
- Test: `apps/web/test/web-auth.test.ts`, `packages/cli/test/dashboard.test.ts`

**Interfaces:**
- Consumes: `hashToken`, `bearerToken`, `accountForToken` (Plan 1), the `loginCodes` and `webSessions` tables (Task 3)
- Produces:
  - `SESSION_COOKIE = "upstream_session"`, `LOGIN_CODE_TTL_MS` (10 min), `SESSION_TTL_MS` (30 days)
  - `createLoginCode(db, accountId, now?)`, `consumeLoginCode(db, code, now?) -> accountId | null` (single use)
  - `createSession(db, accountId, now?) -> cookie value`, `accountForSession(db, value, now?)`
  - `readCookie(req, name)`, `sessionCookie(value, secure)`, `sameOrigin(req)`
  - `withAccount` now accepts `Authorization: Bearer` **or** the session cookie, and refuses cookie-authenticated non-GET requests without a same-origin `Origin` header (403)
  - HTTP:
    - `POST /api/login-links` (Bearer only) returns 201 `{ url }`
    - `GET /connect?code=` returns a 303 to `/dashboard` with `Set-Cookie`, or 400 when the code is used or expired
  - CLI `api.loginLink()`, `dashboardCommand({ api, out, openUrl })`, and the command `upstream dashboard`

- [ ] **Step 1: Write the failing tests**

`apps/web/test/web-auth.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import type { Deps } from "../lib/receipts/service";
import {
  accountForSession, consumeLoginCode, createLoginCode, createSession, LOGIN_CODE_TTL_MS, readCookie, sameOrigin,
  SESSION_COOKIE, SESSION_TTL_MS,
} from "../lib/web-auth";
import { fakeRegistry, payload } from "./helpers";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
const { POST: postLoginLink } = await import("../app/api/login-links/route");
const { GET: connect } = await import("../app/connect/route");
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
    expect(await consumeLoginCode(h.deps.db, code, t0)).toBe(accountId);
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

  it("turns a CLI link into a session cookie that works once", async () => {
    const { token } = await createDevice(h.deps.db, null);
    const url = await linkFor(token);
    expect(url).toMatch(/^http:\/\/up\.test\/connect\?code=/);
    const first = await connect(new Request(url));
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/dashboard");
    const cookie = first.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[\\w-]+; HttpOnly; SameSite=Lax; Path=/`));
    expect((await connect(new Request(url))).status).toBe(400);

    const sessionHeader = { cookie: cookie.split(";")[0]! };
    expect((await listReceipts(new Request("http://up.test/api/receipts", { headers: sessionHeader }))).status).toBe(200);
  });

  it("refuses a login link without a device token", async () => {
    expect((await postLoginLink(new Request("http://up.test/api/login-links", { method: "POST" }))).status).toBe(401);
  });

  it("refuses cookie-authenticated writes from another site", async () => {
    const { token } = await createDevice(h.deps.db, null);
    const cookie = (await connect(new Request(await linkFor(token)))).headers.get("set-cookie")!.split(";")[0]!;
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
```

`packages/cli/test/dashboard.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { Api } from "../src/api";
import { ApiError } from "../src/api";
import { dashboardCommand } from "../src/commands";

describe("dashboardCommand", () => {
  it("prints the one-time link and opens it", async () => {
    const outs: string[] = [];
    const opened: string[] = [];
    const api = { loginLink: async () => ({ url: "http://up.test/connect?code=abc" }) } as unknown as Api;
    expect(await dashboardCommand({ api, out: (m) => outs.push(m), openUrl: (u) => opened.push(u) })).toBe(0);
    expect(opened).toEqual(["http://up.test/connect?code=abc"]);
    expect(outs[0]).toContain("http://up.test/connect?code=abc");
  });

  it("explains a failure and exits 1", async () => {
    const outs: string[] = [];
    const api = { loginLink: async () => { throw new ApiError(401, "unknown token"); } } as unknown as Api;
    expect(await dashboardCommand({ api, out: (m) => outs.push(m), openUrl: () => {} })).toBe(1);
    expect(outs[0]).toContain("unknown token");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test apps/web/test/web-auth.test.ts packages/cli/test/dashboard.test.ts`
Expected: FAIL, because `../lib/web-auth`, the two new routes and `dashboardCommand` don't exist yet.

- [ ] **Step 3: Write `apps/web/lib/web-auth.ts`**

```ts
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashToken } from "./auth";
import type { Db } from "./db/client";
import { loginCodes, webSessions } from "./db/schema";

export const SESSION_COOKIE = "upstream_session";
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const secret = () => randomBytes(32).toString("base64url");
const later = (now: Date, ms: number) => new Date(now.getTime() + ms);

export async function createLoginCode(db: Db, accountId: string, now: Date = new Date()): Promise<string> {
  const code = secret();
  await db.insert(loginCodes).values({ codeHash: hashToken(code), accountId, expiresAt: later(now, LOGIN_CODE_TTL_MS) });
  return code;
}

/** Single use: the first call within 10 minutes returns the account; every later call returns null. */
export async function consumeLoginCode(db: Db, code: string, now: Date = new Date()): Promise<string | null> {
  const [row] = await db
    .update(loginCodes)
    .set({ usedAt: now })
    .where(and(eq(loginCodes.codeHash, hashToken(code)), isNull(loginCodes.usedAt), gt(loginCodes.expiresAt, now)))
    .returning({ accountId: loginCodes.accountId });
  return row?.accountId ?? null;
}

export async function createSession(db: Db, accountId: string, now: Date = new Date()): Promise<string> {
  const value = secret();
  await db.insert(webSessions).values({ idHash: hashToken(value), accountId, expiresAt: later(now, SESSION_TTL_MS) });
  return value;
}

export async function accountForSession(db: Db, value: string, now: Date = new Date()): Promise<string | null> {
  const [row] = await db
    .select({ accountId: webSessions.accountId })
    .from(webSessions)
    .where(and(eq(webSessions.idHash, hashToken(value)), gt(webSessions.expiresAt, now)))
    .limit(1);
  return row?.accountId ?? null;
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

export function sessionCookie(value: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`;
}

/** True when a browser request comes from this site's own pages (guards cookie-authenticated writes). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("host") ?? new URL(req.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Update `withAccount` in `apps/web/lib/http.ts`**

Replace the `withAccount` function and add the imports:
```ts
import { readCookie, SESSION_COOKIE, accountForSession, sameOrigin } from "./web-auth";

/** Runs `fn` with the caller's account: a device Bearer token (CLI) or the dashboard session cookie. */
export async function withAccount(req: Request, fn: (deps: Deps, accountId: string) => Promise<Response>): Promise<Response> {
  const token = bearerToken(req);
  const session = token ? null : readCookie(req, SESSION_COOKIE);
  if (!token && !session) return json({ error: "missing token" }, 401);
  if (session && req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
    return json({ error: "cross-site request refused" }, 403);
  }
  const deps = await getDeps();
  const accountId = token ? await accountForToken(deps.db, token) : await accountForSession(deps.db, session!);
  if (!accountId) return json({ error: token ? "unknown token" : "your dashboard session has expired" }, 401);
  return fn(deps, accountId);
}
```

- [ ] **Step 5: Write the two routes**

`apps/web/app/api/login-links/route.ts`:
```ts
import { bearerToken } from "../../../lib/auth";
import { json, withAccount } from "../../../lib/http";
import { createLoginCode } from "../../../lib/web-auth";

export const runtime = "nodejs";

/** The CLI trades its device token for a one-time dashboard link. */
export async function POST(req: Request): Promise<Response> {
  if (!bearerToken(req)) return json({ error: "missing token" }, 401);
  return withAccount(req, async (deps, accountId) => {
    const code = await createLoginCode(deps.db, accountId);
    const base = process.env.PUBLIC_URL ?? new URL(req.url).origin;
    return json({ url: `${base}/connect?code=${encodeURIComponent(code)}` }, 201);
  });
}
```

`apps/web/app/connect/route.ts`:
```ts
import { getDeps } from "../../lib/deps";
import { consumeLoginCode, createSession, sessionCookie } from "../../lib/web-auth";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const code = new URL(req.url).searchParams.get("code");
  const deps = await getDeps();
  const accountId = code ? await consumeLoginCode(deps.db, code) : null;
  if (!accountId) {
    return new Response("This link has expired or was already used. Run `upstream dashboard` again for a new one.", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const session = await createSession(deps.db, accountId);
  return new Response(null, {
    status: 303,
    headers: { location: "/dashboard", "set-cookie": sessionCookie(session, process.env.NODE_ENV === "production") },
  });
}
```

- [ ] **Step 6: Add the CLI pieces**

In `packages/cli/src/api.ts`, add to the returned object:
```ts
    loginLink: () => call<{ url: string }>("POST", "/api/login-links"),
```

In `packages/cli/test/commands.test.ts`, the `fakeApi` helper builds an `Api` by hand. Add the new method to it, or the `as Api` cast stops type-checking:
```ts
     get: async () => ({ receipt: view }), decide: async () => ({ receipt: view }),
     loginLink: async () => ({ url: "http://up.test/connect?code=x" }) }) as Api;
```
This replaces the line ending `decide: async () => ({ receipt: view }) }) as Api;`.

In `packages/cli/src/commands.ts`, append:
```ts
export async function dashboardCommand(deps: { api: Api; out: (m: string) => void; openUrl: (url: string) => void }): Promise<number> {
  try {
    const { url } = await deps.api.loginLink();
    deps.out(`Opening your Upstream dashboard:\n  ${url}\n(The link works once and expires in 10 minutes.)`);
    deps.openUrl(url);
    return 0;
  } catch (e) {
    deps.out(`Upstream: ${reason(e)}`);
    return 1;
  }
}
```

In `packages/cli/src/main.ts`, add `import { spawn } from "node:child_process";`, import `dashboardCommand`, and register:
```ts
program
  .command("dashboard")
  .description("Open your Upstream dashboard in the browser (budget, subscription, receipts)")
  .action(async () => {
    const config = loadConfig();
    process.exitCode = await dashboardCommand({
      api: createApi(config.apiUrl, config.token),
      out: (m) => console.log(m),
      openUrl: (url) => {
        try {
          spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
        } catch {
          // Opening a browser is a convenience; the link is already printed.
        }
      },
    });
  });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test apps/web/test/web-auth.test.ts packages/cli/test/dashboard.test.ts apps/web/test/api.test.ts`
Expected: PASS. The earlier `api.test.ts` still passes, because Bearer auth is unchanged.

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/web-auth.ts apps/web/lib/http.ts apps/web/app/api/login-links apps/web/app/connect packages/cli apps/web/test/web-auth.test.ts
git commit -m "Add one-time dashboard links and session cookies"
```

---

### Task 5: Ledger and subscriptions (start, reconcile from PayPal)

**Files:**
- Create: `apps/web/lib/funding/ledger.ts`, `apps/web/lib/funding/subscriptions.ts`, `apps/web/lib/funding/route.ts`
- Create: `apps/web/app/api/subscriptions/route.ts`, `apps/web/app/api/subscriptions/[id]/reconcile/route.ts`
- Modify: `apps/web/lib/receipts/service.ts` (optional `paypal`, `planIds` and `webhookId` in `Deps`), `apps/web/lib/deps.ts` (build them from env)
- Test: `apps/web/test/funding.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `PayPalApi`, `PayPalError`, `Money`, `toCents`, `FakePayPal`
  - Task 2: `TierKey`, `TIER_KEYS`, `planIdsFromEnv`
  - Task 3: `subscriptions`, `fundingEvents`
  - Task 4: `withAccount`
- Produces:
  - `FundingDeps { db; paypal: PayPalApi; planIds; now? }`, `FundingError { status }`
  - `recordFunding(db, input): Promise<boolean>` (false when PayPal's id is already recorded), `fundedCents(db, accountId): Promise<number>`, `netCents(net?, gross?)`
  - `startSubscription(deps, accountId, tier): Promise<string>`
  - `reconcileSubscription(deps, id, onlyFor?): Promise<{ accountId; credited; status } | null>`
  - `withFunding(req, fn)`, which wraps `withAccount` and maps `FundingError` to its status, `PayPalError` to 502, and a missing PayPal setup to 503
  - `Deps` gains optional `paypal?: PayPalApi | null`, `planIds?`, `webhookId?: string | null`
  - HTTP:
    - `POST /api/subscriptions { tier }` returns `{ subscriptionId }`
    - `POST /api/subscriptions/:id/reconcile` returns `{ status, credited, fundedCents }`, or 404 when the subscription isn't the caller's

- [ ] **Step 1: Write the failing test**

`apps/web/test/funding.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { fundedCents } from "../lib/funding/ledger";
import { reconcileSubscription, startSubscription, type FundingDeps } from "../lib/funding/subscriptions";
import { PayPalError } from "../lib/paypal/client";
import { FakePayPal } from "../lib/paypal/fake";
import type { Deps } from "../lib/receipts/service";
import { fakeRegistry } from "./helpers";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
const { POST: postSubscription } = await import("../app/api/subscriptions/route");
const { POST: postReconcile } = await import("../app/api/subscriptions/[id]/reconcile/route");

let pp: FakePayPal;
let deps: FundingDeps;

beforeEach(async () => {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  pp = new FakePayPal();
  deps = { db, paypal: pp, planIds: { starter: "P-START", builder: "P-BUILD" } };
  h.deps = { db, http: fakeRegistry, model: null, paypal: pp, planIds: deps.planIds };
});

const account = async () => (await createDevice(deps.db, null)).accountId;

describe("subscriptions", () => {
  it("creates a PayPal subscription tagged with the account", async () => {
    const a = await account();
    const id = await startSubscription(deps, a, "starter");
    expect(pp.subscriptions.get(id)).toMatchObject({ plan_id: "P-START", custom_id: a, status: "APPROVAL_PENDING" });
  });

  it("refuses a tier with no PayPal plan configured", async () => {
    await expect(startSubscription(deps, await account(), "team")).rejects.toMatchObject({ status: 503 });
  });

  it("credits each completed payment once, using the amount after PayPal's fee", async () => {
    const a = await account();
    const id = await startSubscription(deps, a, "starter");
    pp.approveSubscription(id, "PAYER-A", 453);
    expect(await reconcileSubscription(deps, id)).toEqual({ accountId: a, credited: 453, status: "ACTIVE" });
    expect(await reconcileSubscription(deps, id)).toEqual({ accountId: a, credited: 0, status: "ACTIVE" });
    pp.addSubscriptionPayment(id, "SALE-NEXT", 453);
    pp.addSubscriptionPayment(id, "SALE-PENDING", 453, "PENDING");
    expect((await reconcileSubscription(deps, id))!.credited).toBe(453);
    expect(await fundedCents(deps.db, a)).toBe(906);
  });

  it("credits nothing, and doesn't fail, before the buyer approves or while PayPal has no transactions yet", async () => {
    const a = await account();
    const id = await startSubscription(deps, a, "starter");
    expect(await reconcileSubscription(deps, id)).toEqual({ accountId: a, credited: 0, status: "APPROVAL_PENDING" });
    pp.approveSubscription(id, "PAYER-A", 453);
    pp.failNext("listSubscriptionTransactions", new PayPalError(404, "INVALID_RESOURCE_ID", "The specified resource does not exist.", null));
    expect(await reconcileSubscription(deps, id)).toEqual({ accountId: a, credited: 0, status: "ACTIVE" });
    expect((await reconcileSubscription(deps, id))!.credited).toBe(453);
  });

  it("records a payment once even when two reconciles run at the same time", async () => {
    const a = await account();
    const id = await startSubscription(deps, a, "starter");
    pp.approveSubscription(id, "PAYER-A", 453);
    const [x, y] = await Promise.all([reconcileSubscription(deps, id), reconcileSubscription(deps, id)]);
    expect(x!.credited + y!.credited).toBe(453);
    expect(await fundedCents(deps.db, a)).toBe(453);
  });

  it("never lets another account reconcile, or claim, someone else's subscription", async () => {
    const a = await account();
    const b = await account();
    const id = await startSubscription(deps, a, "starter");
    pp.approveSubscription(id, "PAYER-A", 453);
    expect(await reconcileSubscription(deps, id, b)).toBeNull();
    expect(await fundedCents(deps.db, b)).toBe(0);
    expect(await fundedCents(deps.db, a)).toBe(0);
  });

  it("credits nothing when PayPal's record names a different account", async () => {
    const a = await account();
    const id = await startSubscription(deps, a, "starter");
    pp.approveSubscription(id, "PAYER-A", 453);
    pp.subscriptions.get(id)!.custom_id = "someone-else";
    expect(await reconcileSubscription(deps, id)).toBeNull();
    expect(await fundedCents(deps.db, a)).toBe(0);
  });
});

describe("subscription routes", () => {
  it("starts and reconciles through the API, and 404s for another account", async () => {
    const owner = await createDevice(deps.db, null);
    const other = await createDevice(deps.db, null);
    const post = (url: string, token: string, body?: unknown) =>
      new Request(`http://up.test${url}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const res = await postSubscription(post("/api/subscriptions", owner.token, { tier: "starter" }));
    expect(res.status).toBe(200);
    const { subscriptionId } = (await res.json()) as { subscriptionId: string };
    pp.approveSubscription(subscriptionId, "PAYER-A", 453);
    const params = { params: Promise.resolve({ id: subscriptionId }) };
    expect((await postReconcile(post(`/api/subscriptions/${subscriptionId}/reconcile`, other.token), params)).status).toBe(404);
    const ok = await postReconcile(post(`/api/subscriptions/${subscriptionId}/reconcile`, owner.token), params);
    expect(await ok.json()).toEqual({ status: "ACTIVE", credited: 453, fundedCents: 453 });
    expect((await postSubscription(post("/api/subscriptions", owner.token, { tier: "gold" }))).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test apps/web/test/funding.test.ts`
Expected: FAIL, because `../lib/funding/ledger`, `../lib/funding/subscriptions` and the routes don't exist yet.

- [ ] **Step 3: Write `apps/web/lib/funding/ledger.ts`**

```ts
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { fundingEvents } from "../db/schema";
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

export async function fundedCents(db: Db, accountId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${fundingEvents.amountCents}), 0)` })
    .from(fundingEvents)
    .where(eq(fundingEvents.accountId, accountId));
  return Number(row?.total ?? 0);
}

/** A PayPal amount in cents, preferring the net amount after PayPal's fee. Anything that isn't USD counts as 0. */
export function netCents(net?: Money, gross?: Money): number {
  const m = net ?? gross;
  if (!m || m.currency_code !== "USD") return 0;
  return toCents(m.value);
}
```

- [ ] **Step 4: Write `apps/web/lib/funding/subscriptions.ts`**

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { subscriptions } from "../db/schema";
import type { PayPalApi, PaypalSubscriptionTxn } from "../paypal/api";
import { PayPalError } from "../paypal/client";
import type { TierKey } from "../paypal/plans";
import { netCents, recordFunding } from "./ledger";

export interface FundingDeps {
  db: Db;
  paypal: PayPalApi;
  planIds: Partial<Record<TierKey, string>>;
  now?: () => Date;
}

export class FundingError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function startSubscription(deps: FundingDeps, accountId: string, tier: TierKey): Promise<string> {
  const planId = deps.planIds[tier];
  if (!planId) throw new FundingError(503, "Subscriptions aren't set up on this server yet");
  const sub = await deps.paypal.createSubscription(planId, accountId);
  await deps.db.insert(subscriptions).values({ id: sub.id, accountId, tier, status: sub.status }).onConflictDoNothing();
  return sub.id;
}

/**
 * Brings one subscription up to date from PayPal: its status, its payer, and every completed payment so far.
 * Safe to run any number of times, even concurrently. Returns null when the subscription isn't ours, or isn't
 * `onlyFor`'s, and then credits nothing.
 */
export async function reconcileSubscription(
  deps: FundingDeps,
  subscriptionId: string,
  onlyFor?: string,
): Promise<{ accountId: string; credited: number; status: string } | null> {
  const [row] = await deps.db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).limit(1);
  if (!row || (onlyFor !== undefined && row.accountId !== onlyFor)) return null;
  const sub = await deps.paypal.getSubscription(subscriptionId);
  if (sub.custom_id !== row.accountId) return null;
  const now = deps.now?.() ?? new Date();
  const payerId = sub.subscriber?.payer_id ?? row.payerId;
  await deps.db.update(subscriptions).set({ status: sub.status, payerId, updatedAt: now }).where(eq(subscriptions.id, subscriptionId));

  const started = Math.min(row.createdAt.getTime(), Date.parse(sub.start_time ?? "") || Number.POSITIVE_INFINITY);
  const from = new Date(started - 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(now.getTime() + 60 * 1000).toISOString();
  // PayPal 404s the transaction list until the buyer has approved and billing has started.
  let txns: PaypalSubscriptionTxn[] = [];
  if (sub.status !== "APPROVAL_PENDING" && sub.status !== "APPROVED") {
    try {
      txns = await deps.paypal.listSubscriptionTransactions(subscriptionId, from, to);
    } catch (e) {
      if (!(e instanceof PayPalError && e.status === 404)) throw e;
    }
  }
  let credited = 0;
  for (const t of txns) {
    if (t.status !== "COMPLETED") continue;
    const cents = netCents(t.amount_with_breakdown?.net_amount, t.amount_with_breakdown?.gross_amount);
    const fresh = await recordFunding(deps.db, {
      accountId: row.accountId,
      source: "subscription",
      paypalId: t.id,
      amountCents: cents,
      payerId: payerId ?? null,
      occurredAt: t.time ? new Date(t.time) : now,
      raw: t,
    });
    if (fresh) credited += cents;
  }
  return { accountId: row.accountId, credited, status: sub.status };
}
```

- [ ] **Step 5: Extend `Deps` and `getDeps`**

In `apps/web/lib/receipts/service.ts`, add `import type { PayPalApi } from "../paypal/api";` and `import type { TierKey } from "../paypal/plans";`, and add to `interface Deps`:
```ts
  /** PayPal REST client; null when the server has no PayPal credentials. */
  paypal?: PayPalApi | null;
  planIds?: Partial<Record<TierKey, string>>;
  /** The id PayPal gave our webhook, needed to verify webhook signatures. */
  webhookId?: string | null;
```

In `apps/web/lib/deps.ts`, add the imports `createPayPalApi` (`./paypal/api`), `createPayPalHttp` and `SANDBOX_API` (`./paypal/client`), and `planIdsFromEnv` (`./paypal/plans`). Then add to the returned object:
```ts
      paypal:
        process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET
          ? createPayPalApi(
              createPayPalHttp({
                clientId: process.env.PAYPAL_CLIENT_ID,
                clientSecret: process.env.PAYPAL_CLIENT_SECRET,
                baseUrl: process.env.PAYPAL_API_BASE ?? SANDBOX_API,
              }),
            )
          : null,
      planIds: planIdsFromEnv(),
      webhookId: process.env.PAYPAL_WEBHOOK_ID ?? null,
```

- [ ] **Step 6: Write `apps/web/lib/funding/route.ts` and the routes**

`apps/web/lib/funding/route.ts`:
```ts
import { json, withAccount } from "../http";
import { PayPalError } from "../paypal/client";
import { FundingError, type FundingDeps } from "./subscriptions";

/** withAccount for money routes: needs PayPal configured, and turns failures into clear answers. */
export async function withFunding(req: Request, fn: (deps: FundingDeps, accountId: string) => Promise<Response>): Promise<Response> {
  return withAccount(req, async (deps, accountId) => {
    if (!deps.paypal) return json({ error: "Payments aren't set up on this server yet" }, 503);
    try {
      return await fn({ db: deps.db, paypal: deps.paypal, planIds: deps.planIds ?? {} }, accountId);
    } catch (e) {
      if (e instanceof FundingError) return json({ error: e.message }, e.status);
      if (e instanceof PayPalError) return json({ error: "PayPal couldn't complete that. Please try again.", code: e.code }, 502);
      throw e;
    }
  });
}
```

`apps/web/app/api/subscriptions/route.ts`:
```ts
import { z } from "zod";
import { withFunding } from "../../../lib/funding/route";
import { startSubscription } from "../../../lib/funding/subscriptions";
import { json } from "../../../lib/http";
import { TIER_KEYS } from "../../../lib/paypal/plans";

export const runtime = "nodejs";

const Body = z.object({ tier: z.enum(TIER_KEYS) });

export async function POST(req: Request): Promise<Response> {
  return withFunding(req, async (deps, accountId) => {
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) return json({ error: "Pick a plan: starter, builder or team" }, 400);
    return json({ subscriptionId: await startSubscription(deps, accountId, body.data.tier) });
  });
}
```

`apps/web/app/api/subscriptions/[id]/reconcile/route.ts`:
```ts
import { fundedCents } from "../../../../../lib/funding/ledger";
import { withFunding } from "../../../../../lib/funding/route";
import { reconcileSubscription } from "../../../../../lib/funding/subscriptions";
import { json } from "../../../../../lib/http";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return withFunding(req, async (deps, accountId) => {
    const result = await reconcileSubscription(deps, id, accountId);
    if (!result) return json({ error: "subscription not found" }, 404);
    return json({ status: result.status, credited: result.credited, fundedCents: await fundedCents(deps.db, accountId) });
  });
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm test apps/web/test/funding.test.ts`
Expected: PASS, 8 tests.

Run: `pnpm test && pnpm typecheck`
Expected: the whole suite passes and there are no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/funding apps/web/app/api/subscriptions apps/web/lib/receipts/service.ts apps/web/lib/deps.ts apps/web/test/funding.test.ts
git commit -m "Record subscription payments from PayPal, once per sale"
```

---

### Task 6: One-time top-ups (Orders v2)

**Files:**
- Create: `apps/web/lib/funding/topups.ts`, `apps/web/app/api/topups/route.ts`, `apps/web/app/api/topups/[id]/capture/route.ts`
- Test: `apps/web/test/topups.test.ts`

**Interfaces:**
- Consumes:
  - Task 5: `FundingDeps`, `FundingError`, `recordFunding`, `netCents`, `fundedCents`, `withFunding`
  - Task 1: `PaypalOrder`, `PayPalError`, `FakePayPal`
- Produces:
  - `TOPUP_MIN_CENTS = 100`, `TOPUP_MAX_CENTS = 50000`
  - `startTopup(deps, accountId, cents): Promise<orderId>`
  - `completeTopup(deps, accountId, orderId): Promise<creditedCents>`. It checks ownership **before** capturing. `ORDER_ALREADY_CAPTURED` means "read the order and credit its capture". `ORDER_NOT_APPROVED` gives a 409.
  - `creditCaptures(db, accountId, order, now?)`
  - HTTP:
    - `POST /api/topups { cents }` returns `{ orderId }`
    - `POST /api/topups/:id/capture` returns `{ credited, fundedCents }`

- [ ] **Step 1: Write the failing test**

`apps/web/test/topups.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { fundedCents } from "../lib/funding/ledger";
import type { FundingDeps } from "../lib/funding/subscriptions";
import { completeTopup, startTopup } from "../lib/funding/topups";
import { PayPalError } from "../lib/paypal/client";
import { FakePayPal } from "../lib/paypal/fake";

let pp: FakePayPal;
let deps: FundingDeps;
beforeEach(async () => {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  pp = new FakePayPal();
  deps = { db, paypal: pp, planIds: {} };
});
const account = async () => (await createDevice(deps.db, null)).accountId;
// The fake takes 3.49% + $0.49 like PayPal: a $10.00 top-up nets $9.16.
const NET_OF_1000 = 916;

describe("top-ups", () => {
  it("captures an approved top-up and credits the amount after PayPal's fee, once", async () => {
    const a = await account();
    const orderId = await startTopup(deps, a, 1000);
    pp.approveOrder(orderId, "PAYER-A");
    expect(await completeTopup(deps, a, orderId)).toBe(NET_OF_1000);
    expect(await completeTopup(deps, a, orderId)).toBe(0);
    expect(await fundedCents(deps.db, a)).toBe(NET_OF_1000);
  });

  it("keeps top-ups between $1 and $500", async () => {
    const a = await account();
    await expect(startTopup(deps, a, 99)).rejects.toMatchObject({ status: 400 });
    await expect(startTopup(deps, a, 50_001)).rejects.toMatchObject({ status: 400 });
    await expect(startTopup(deps, a, 10.5)).rejects.toMatchObject({ status: 400 });
  });

  it("never captures or credits another account's order", async () => {
    const a = await account();
    const b = await account();
    const orderId = await startTopup(deps, a, 1000);
    pp.approveOrder(orderId, "PAYER-A");
    await expect(completeTopup(deps, b, orderId)).rejects.toMatchObject({ status: 404 });
    expect(pp.calls).not.toContain("captureOrder");
    expect(pp.orders.get(orderId)!.status).toBe("APPROVED");
    expect(await fundedCents(deps.db, b)).toBe(0);
  });

  it("is safe to retry after PayPal fails mid-capture", async () => {
    const a = await account();
    const orderId = await startTopup(deps, a, 1000);
    pp.approveOrder(orderId, "PAYER-A");
    pp.failNext("captureOrder", new PayPalError(503, "SERVICE_UNAVAILABLE", "try later", null));
    await expect(completeTopup(deps, a, orderId)).rejects.toBeInstanceOf(PayPalError);
    expect(await fundedCents(deps.db, a)).toBe(0);
    expect(await completeTopup(deps, a, orderId)).toBe(NET_OF_1000);
  });

  it("credits the capture when another request already captured the order", async () => {
    const a = await account();
    const orderId = await startTopup(deps, a, 1000);
    pp.approveOrder(orderId, "PAYER-A");
    const realCapture = pp.captureOrder.bind(pp);
    pp.captureOrder = async (id: string) => {
      await realCapture(id);
      throw new PayPalError(422, "ORDER_ALREADY_CAPTURED", "Order already captured", null);
    };
    expect(await completeTopup(deps, a, orderId)).toBe(NET_OF_1000);
  });

  it("asks the buyer to approve first, and 404s for an order that doesn't exist", async () => {
    const a = await account();
    const orderId = await startTopup(deps, a, 1000);
    await expect(completeTopup(deps, a, orderId)).rejects.toMatchObject({ status: 409 });
    await expect(completeTopup(deps, a, "ORDER-NOPE")).rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test apps/web/test/topups.test.ts`
Expected: FAIL, because `../lib/funding/topups` can't be resolved.

- [ ] **Step 3: Write `apps/web/lib/funding/topups.ts`**

```ts
import type { Db } from "../db/client";
import type { PaypalOrder } from "../paypal/api";
import { PayPalError } from "../paypal/client";
import { netCents, recordFunding } from "./ledger";
import { FundingError, type FundingDeps } from "./subscriptions";

export const TOPUP_MIN_CENTS = 100;
export const TOPUP_MAX_CENTS = 50_000;

export async function startTopup(deps: FundingDeps, accountId: string, cents: number): Promise<string> {
  if (!Number.isInteger(cents) || cents < TOPUP_MIN_CENTS || cents > TOPUP_MAX_CENTS) {
    throw new FundingError(400, "Top-ups can be from $1 to $500");
  }
  return (await deps.paypal.createOrder(cents, accountId, "Upstream open-source budget top-up")).id;
}

/** Credits every completed capture on `order` to `accountId`, once per capture id. Returns the newly credited cents. */
export async function creditCaptures(db: Db, accountId: string, order: PaypalOrder, now: Date = new Date()): Promise<number> {
  let credited = 0;
  for (const unit of order.purchase_units ?? []) {
    for (const cap of unit.payments?.captures ?? []) {
      if (cap.status !== "COMPLETED") continue;
      const cents = netCents(cap.seller_receivable_breakdown?.net_amount, cap.amount);
      const fresh = await recordFunding(db, {
        accountId,
        source: "topup",
        paypalId: cap.id,
        amountCents: cents,
        payerId: order.payer?.payer_id ?? null,
        occurredAt: cap.create_time ? new Date(cap.create_time) : now,
        raw: cap,
      });
      if (fresh) credited += cents;
    }
  }
  return credited;
}

async function getOwnOrder(deps: FundingDeps, accountId: string, orderId: string): Promise<PaypalOrder> {
  let order: PaypalOrder;
  try {
    order = await deps.paypal.getOrder(orderId);
  } catch (e) {
    if (e instanceof PayPalError && e.status === 404) throw new FundingError(404, "order not found");
    throw e;
  }
  if (order.purchase_units?.[0]?.custom_id !== accountId) throw new FundingError(404, "order not found");
  return order;
}

/** Captures an approved top-up and credits it. Ownership is checked before capturing; retrying after any failure is safe. */
export async function completeTopup(deps: FundingDeps, accountId: string, orderId: string): Promise<number> {
  let order = await getOwnOrder(deps, accountId, orderId);
  if (order.status !== "COMPLETED") {
    try {
      order = await deps.paypal.captureOrder(orderId);
    } catch (e) {
      if (!(e instanceof PayPalError)) throw e;
      if (e.code === "ORDER_ALREADY_CAPTURED") order = await deps.paypal.getOrder(orderId);
      else if (e.code === "ORDER_NOT_APPROVED") throw new FundingError(409, "Approve the payment in the PayPal window first");
      else throw e;
    }
  }
  return creditCaptures(deps.db, accountId, order, deps.now?.());
}
```

- [ ] **Step 4: Write the routes**

`apps/web/app/api/topups/route.ts`:
```ts
import { z } from "zod";
import { withFunding } from "../../../lib/funding/route";
import { startTopup } from "../../../lib/funding/topups";
import { json } from "../../../lib/http";

export const runtime = "nodejs";

const Body = z.object({ cents: z.number() });

export async function POST(req: Request): Promise<Response> {
  return withFunding(req, async (deps, accountId) => {
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) return json({ error: "Say how much to add, in cents" }, 400);
    return json({ orderId: await startTopup(deps, accountId, body.data.cents) });
  });
}
```

`apps/web/app/api/topups/[id]/capture/route.ts`:
```ts
import { fundedCents } from "../../../../../lib/funding/ledger";
import { withFunding } from "../../../../../lib/funding/route";
import { completeTopup } from "../../../../../lib/funding/topups";
import { json } from "../../../../../lib/http";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return withFunding(req, async (deps, accountId) => {
    const credited = await completeTopup(deps, accountId, id);
    return json({ credited, fundedCents: await fundedCents(deps.db, accountId) });
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test apps/web/test/topups.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/funding/topups.ts apps/web/app/api/topups apps/web/test/topups.test.ts
git commit -m "Add PayPal top-ups with ownership checks and safe retries"
```

---

### Task 7: Verified webhooks

**Files:**
- Create: `apps/web/lib/funding/webhooks.ts`, `apps/web/app/api/paypal/webhook/route.ts`
- Test: `apps/web/test/webhooks.test.ts`

**Interfaces:**
- Consumes:
  - Task 5: `reconcileSubscription`, `recordFunding`, `netCents`, `FundingDeps`
  - Task 3: `webhookEvents`, `accounts`
  - Task 1: `FakePayPal`
- Produces:
  - `handleWebhook(deps & { webhookId }, headers, rawBody): Promise<{ status; outcome }>`
  - `POST /api/paypal/webhook`, which is unauthenticated and requires a verified signature
- What each event does:
  - `BILLING.SUBSCRIPTION.*` reconciles `resource.id`.
  - `PAYMENT.SALE.COMPLETED` reconciles `resource.billing_agreement_id`.
  - `PAYMENT.CAPTURE.COMPLETED` credits the capture to the account in `resource.custom_id`, if that account exists.
  - Everything else is ignored.
- The event id is stored **after** the work succeeds, so PayPal's retries after a failure are processed again. A replay of an already processed event id returns `duplicate`.

- [ ] **Step 1: Write the failing test**

`apps/web/test/webhooks.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { subscriptions } from "../lib/db/schema";
import { fundedCents } from "../lib/funding/ledger";
import { startSubscription, type FundingDeps } from "../lib/funding/subscriptions";
import { handleWebhook } from "../lib/funding/webhooks";
import { PayPalError } from "../lib/paypal/client";
import { FakePayPal } from "../lib/paypal/fake";

const SIGNED = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT",
  "paypal-transmission-id": "t-1",
  "paypal-transmission-sig": "sig",
  "paypal-transmission-time": "2026-10-14T10:00:00Z",
};
const body = (id: string, type: string, resource: Record<string, unknown>) => JSON.stringify({ id, event_type: type, resource });

let pp: FakePayPal;
let deps: FundingDeps & { webhookId: string | null };
beforeEach(async () => {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  pp = new FakePayPal();
  deps = { db, paypal: pp, planIds: { starter: "P-START" }, webhookId: "WH-1" };
});
const send = (raw: string, headers: Record<string, string> = SIGNED) => handleWebhook(deps, new Headers(headers), raw);

async function activeSubscription() {
  const { accountId } = await createDevice(deps.db, null);
  const id = await startSubscription(deps, accountId, "starter");
  pp.approveSubscription(id, "PAYER-A", 453);
  return { accountId, id };
}

describe("handleWebhook", () => {
  it("does nothing until a webhook id is configured", async () => {
    expect(await handleWebhook({ ...deps, webhookId: null }, new Headers(SIGNED), "{}")).toEqual({ status: 503, outcome: "webhooks not configured" });
  });

  it("rejects a forged or unsigned event and credits nothing", async () => {
    const { accountId, id } = await activeSubscription();
    pp.signatureValid = false;
    expect((await send(body("E1", "PAYMENT.SALE.COMPLETED", { billing_agreement_id: id }))).status).toBe(400);
    pp.signatureValid = true;
    expect((await send(body("E2", "PAYMENT.SALE.COMPLETED", { billing_agreement_id: id }), {})).status).toBe(400);
    expect((await send("not json")).status).toBe(400);
    expect(await fundedCents(deps.db, accountId)).toBe(0);
  });

  it("credits a subscription payment once, however many times PayPal tells us", async () => {
    const { accountId, id } = await activeSubscription();
    expect(await send(body("E1", "PAYMENT.SALE.COMPLETED", { id: "SALE-X", billing_agreement_id: id }))).toEqual({ status: 200, outcome: "reconciled" });
    expect(await send(body("E2", "PAYMENT.SALE.COMPLETED", { id: "SALE-X", billing_agreement_id: id }))).toEqual({ status: 200, outcome: "reconciled" });
    expect(await send(body("E2", "PAYMENT.SALE.COMPLETED", { id: "SALE-X", billing_agreement_id: id }))).toEqual({ status: 200, outcome: "duplicate" });
    expect(await fundedCents(deps.db, accountId)).toBe(453);
  });

  it("updates the subscription status on billing events", async () => {
    const { id } = await activeSubscription();
    pp.subscriptions.get(id)!.status = "CANCELLED";
    await send(body("E1", "BILLING.SUBSCRIPTION.CANCELLED", { id }));
    const [row] = await deps.db.select().from(subscriptions).where(eq(subscriptions.id, id));
    expect(row!.status).toBe("CANCELLED");
  });

  it("credits a completed capture to the account it was made for, once", async () => {
    const { accountId } = await createDevice(deps.db, null);
    const capture = {
      id: "CAP-1",
      status: "COMPLETED",
      custom_id: accountId,
      amount: { currency_code: "USD", value: "10.00" },
      seller_receivable_breakdown: { net_amount: { currency_code: "USD", value: "9.16" } },
    };
    expect((await send(body("E1", "PAYMENT.CAPTURE.COMPLETED", capture))).outcome).toBe("credited");
    expect((await send(body("E2", "PAYMENT.CAPTURE.COMPLETED", capture))).outcome).toBe("already credited");
    expect(await fundedCents(deps.db, accountId)).toBe(916);
  });

  it("ignores events about accounts or subscriptions it doesn't know", async () => {
    expect((await send(body("E1", "PAYMENT.CAPTURE.COMPLETED", { id: "CAP-2", status: "COMPLETED", custom_id: "8a1c2b3d-0000-4000-8000-000000000000", amount: { currency_code: "USD", value: "5.00" } }))).outcome).toBe("unknown account");
    expect((await send(body("E2", "PAYMENT.CAPTURE.COMPLETED", { id: "CAP-3", status: "COMPLETED", custom_id: "not-an-account" }))).outcome).toBe("ignored");
    expect((await send(body("E3", "PAYMENT.SALE.COMPLETED", { billing_agreement_id: "I-UNKNOWN" }))).outcome).toBe("unknown subscription");
    expect((await send(body("E4", "CUSTOMER.DISPUTE.CREATED", {}))).outcome).toBe("ignored");
  });

  it("processes an event again when PayPal retries after a failure", async () => {
    const { accountId, id } = await activeSubscription();
    pp.failNext("getSubscription", new PayPalError(503, "SERVICE_UNAVAILABLE", "try later", null));
    await expect(send(body("E1", "PAYMENT.SALE.COMPLETED", { billing_agreement_id: id }))).rejects.toBeInstanceOf(PayPalError);
    expect(await send(body("E1", "PAYMENT.SALE.COMPLETED", { billing_agreement_id: id }))).toEqual({ status: 200, outcome: "reconciled" });
    expect(await fundedCents(deps.db, accountId)).toBe(453);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test apps/web/test/webhooks.test.ts`
Expected: FAIL, because `../lib/funding/webhooks` can't be resolved.

- [ ] **Step 3: Write `apps/web/lib/funding/webhooks.ts`**

```ts
import { eq } from "drizzle-orm";
import { z } from "zod";
import { accounts, webhookEvents } from "../db/schema";
import { netCents, recordFunding } from "./ledger";
import { reconcileSubscription, type FundingDeps } from "./subscriptions";

const SIGNATURE_HEADERS = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];

const MoneyShape = z.object({ currency_code: z.string(), value: z.string() });
const CaptureShape = z.object({
  id: z.string(),
  status: z.literal("COMPLETED"),
  custom_id: z.uuid(),
  create_time: z.string().optional(),
  amount: MoneyShape.optional(),
  seller_receivable_breakdown: z.object({ net_amount: MoneyShape.optional() }).optional(),
});

export interface WebhookResult {
  status: number;
  outcome: string;
}

type WebhookDeps = FundingDeps & { webhookId: string | null };

/**
 * Verifies a PayPal webhook, then brings our records up to date from PayPal. The work is idempotent and the
 * event id is stored only after it succeeds, so PayPal's retries after a failure run again, and replays don't.
 */
export async function handleWebhook(deps: WebhookDeps, headers: Headers, rawBody: string): Promise<WebhookResult> {
  if (!deps.webhookId) return { status: 503, outcome: "webhooks not configured" };
  let event: { id?: unknown; event_type?: unknown; resource?: unknown };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return { status: 400, outcome: "not JSON" };
  }
  if (typeof event.id !== "string" || typeof event.event_type !== "string") return { status: 400, outcome: "not a PayPal event" };
  const verified = await deps.paypal.verifyWebhookSignature({
    headers: Object.fromEntries(SIGNATURE_HEADERS.map((k) => [k, headers.get(k)])),
    webhookId: deps.webhookId,
    event,
  });
  if (!verified) return { status: 400, outcome: "bad signature" };

  const [seen] = await deps.db.select({ id: webhookEvents.id }).from(webhookEvents).where(eq(webhookEvents.id, event.id)).limit(1);
  if (seen) return { status: 200, outcome: "duplicate" };
  const resource = event.resource && typeof event.resource === "object" ? (event.resource as Record<string, unknown>) : {};
  const outcome = await dispatch(deps, event.event_type, resource);
  await deps.db.insert(webhookEvents).values({ id: event.id, eventType: event.event_type, outcome }).onConflictDoNothing();
  return { status: 200, outcome };
}

async function dispatch(deps: WebhookDeps, type: string, r: Record<string, unknown>): Promise<string> {
  const reconcile = async (id: unknown) =>
    typeof id === "string" && (await reconcileSubscription(deps, id)) ? "reconciled" : "unknown subscription";
  if (type.startsWith("BILLING.SUBSCRIPTION.")) return reconcile(r.id);
  if (type === "PAYMENT.SALE.COMPLETED") return reconcile(r.billing_agreement_id);
  if (type === "PAYMENT.CAPTURE.COMPLETED") return creditCapture(deps, r);
  return "ignored";
}

async function creditCapture(deps: WebhookDeps, r: Record<string, unknown>): Promise<string> {
  const cap = CaptureShape.safeParse(r);
  if (!cap.success) return "ignored";
  const [account] = await deps.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, cap.data.custom_id)).limit(1);
  if (!account) return "unknown account";
  const fresh = await recordFunding(deps.db, {
    accountId: account.id,
    source: "topup",
    paypalId: cap.data.id,
    amountCents: netCents(cap.data.seller_receivable_breakdown?.net_amount, cap.data.amount),
    payerId: null,
    occurredAt: cap.data.create_time ? new Date(cap.data.create_time) : new Date(),
    raw: r,
  });
  return fresh ? "credited" : "already credited";
}
```

- [ ] **Step 4: Write `apps/web/app/api/paypal/webhook/route.ts`**

```ts
import { getDeps } from "../../../../lib/deps";
import { handleWebhook } from "../../../../lib/funding/webhooks";
import { json } from "../../../../lib/http";

export const runtime = "nodejs";

/** PayPal calls this; it is not user-authenticated, so nothing happens without a verified signature. */
export async function POST(req: Request): Promise<Response> {
  const deps = await getDeps();
  if (!deps.paypal) return json({ error: "Payments aren't set up on this server yet" }, 503);
  const result = await handleWebhook(
    { db: deps.db, paypal: deps.paypal, planIds: deps.planIds ?? {}, webhookId: deps.webhookId ?? null },
    req.headers,
    await req.text(),
  );
  return json({ outcome: result.outcome }, result.status);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test apps/web/test/webhooks.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/funding/webhooks.ts apps/web/app/api/paypal apps/web/test/webhooks.test.ts
git commit -m "Accept signature-verified PayPal webhooks and reconcile from them"
```

---

### Task 8: Settings, auto-approve and the dashboard summary

**Files:**
- Create: `apps/web/lib/funding/settings.ts`, `apps/web/app/api/me/route.ts`, `apps/web/app/api/settings/route.ts`
- Modify: `apps/web/lib/receipts/service.ts` (auto-approve after judging)
- Test: `apps/web/test/settings.test.ts`

**Interfaces:**
- Consumes:
  - Task 5: `fundedCents`, `recordFunding`
  - Task 3: `accountSettings`, `subscriptions`
  - Task 4: `withAccount` (Bearer or cookie)
  - Plan 1: `submitReceipt`, `decideReceipt`, `receipts`
- Produces:
  - `getSettings(db, accountId): Promise<{ autoApprove }>`, `setAutoApprove(db, accountId, value)`, `shouldAutoApprove(db, accountId)` (on **and** funded > 0)
  - `submitReceipt` approves the receipt automatically after judging when `shouldAutoApprove` is true. Plan 2b changes "funded" to "has unspent budget".
  - `GET /api/me` returns `{ fundedCents, subscription: { id, tier, status } | null, autoApprove, receipts: { proposed, approved, skipped }, paymentsReady }`
  - `PATCH /api/settings { autoApprove: boolean }` returns `{ autoApprove }`

- [ ] **Step 1: Write the failing test**

`apps/web/test/settings.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { recordFunding } from "../lib/funding/ledger";
import { getSettings, setAutoApprove } from "../lib/funding/settings";
import { submitReceipt, type Deps } from "../lib/receipts/service";
import { createSession, SESSION_COOKIE } from "../lib/web-auth";
import { fakeRegistry, payload } from "./helpers";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
const { GET: getMe } = await import("../app/api/me/route");
const { PATCH: patchSettings } = await import("../app/api/settings/route");

beforeEach(async () => {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  h.deps = { db, http: fakeRegistry, model: null };
});

const fund = (accountId: string, cents: number) =>
  recordFunding(h.deps.db, { accountId, source: "topup", paypalId: `CAP-${accountId}`, amountCents: cents, payerId: null, occurredAt: new Date(), raw: null });

describe("auto-approve", () => {
  it("leaves receipts waiting when it's off", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    await fund(accountId, 500);
    expect((await submitReceipt(h.deps, accountId, payload())).view.status).toBe("proposed");
  });

  it("waits while the budget is empty, even when it's on", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    await setAutoApprove(h.deps.db, accountId, true);
    expect((await submitReceipt(h.deps, accountId, payload())).view.status).toBe("proposed");
  });

  it("approves receipts by itself when it's on and there is money in the budget", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    await setAutoApprove(h.deps.db, accountId, true);
    await fund(accountId, 500);
    expect((await submitReceipt(h.deps, accountId, payload())).view.status).toBe("approved");
    expect(await getSettings(h.deps.db, accountId)).toEqual({ autoApprove: true });
  });
});

describe("dashboard API", () => {
  it("summarises the budget, subscription, setting and receipts", async () => {
    const { accountId, token } = await createDevice(h.deps.db, null);
    await fund(accountId, 916);
    await submitReceipt(h.deps, accountId, payload());
    const res = await getMe(new Request("http://up.test/api/me", { headers: { authorization: `Bearer ${token}` } }));
    expect(await res.json()).toEqual({
      fundedCents: 916,
      subscription: null,
      autoApprove: false,
      receipts: { proposed: 1, approved: 0, skipped: 0 },
      paymentsReady: false,
    });
  });

  it("changes the setting from the dashboard, but not from another site", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    const cookie = `${SESSION_COOKIE}=${await createSession(h.deps.db, accountId)}`;
    const patch = (origin: string) =>
      patchSettings(
        new Request("http://up.test/api/settings", {
          method: "PATCH",
          headers: { cookie, origin, host: "up.test", "content-type": "application/json" },
          body: JSON.stringify({ autoApprove: true }),
        }),
      );
    expect((await patch("https://evil.example")).status).toBe(403);
    expect(await getSettings(h.deps.db, accountId)).toEqual({ autoApprove: false });
    expect(await (await patch("http://up.test")).json()).toEqual({ autoApprove: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test apps/web/test/settings.test.ts`
Expected: FAIL, because `../lib/funding/settings` and the two routes don't exist yet.

- [ ] **Step 3: Write `apps/web/lib/funding/settings.ts`**

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { accountSettings } from "../db/schema";
import { fundedCents } from "./ledger";

export interface AccountSettings {
  autoApprove: boolean;
}

export async function getSettings(db: Db, accountId: string): Promise<AccountSettings> {
  const [row] = await db
    .select({ autoApprove: accountSettings.autoApprove })
    .from(accountSettings)
    .where(eq(accountSettings.accountId, accountId))
    .limit(1);
  return { autoApprove: row?.autoApprove ?? false };
}

export async function setAutoApprove(db: Db, accountId: string, autoApprove: boolean): Promise<AccountSettings> {
  await db
    .insert(accountSettings)
    .values({ accountId, autoApprove })
    .onConflictDoUpdate({ target: accountSettings.accountId, set: { autoApprove, updatedAt: new Date() } });
  return { autoApprove };
}

/** The spending rule: approve by itself only when the funder turned it on and there is money in the budget. */
export async function shouldAutoApprove(db: Db, accountId: string): Promise<boolean> {
  return (await getSettings(db, accountId)).autoApprove && (await fundedCents(db, accountId)) > 0;
}
```

- [ ] **Step 4: Auto-approve in `apps/web/lib/receipts/service.ts`**

Add `import { shouldAutoApprove } from "../funding/settings";`, and replace the last line of `submitReceipt`:
```ts
  return { view: (await loadView(deps.db, accountId, id))!, changed: true };
```
with:
```ts
  if (await shouldAutoApprove(deps.db, accountId)) await decideReceipt(deps, accountId, id, "approve");
  return { view: (await loadView(deps.db, accountId, id))!, changed: true };
```
`decideReceipt` is defined later in the same file. That's fine, because function declarations are hoisted.

- [ ] **Step 5: Write the routes**

`apps/web/app/api/me/route.ts`:
```ts
import { desc, eq, sql } from "drizzle-orm";
import { receipts, subscriptions } from "../../../lib/db/schema";
import { fundedCents } from "../../../lib/funding/ledger";
import { getSettings } from "../../../lib/funding/settings";
import { json, withAccount } from "../../../lib/http";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  return withAccount(req, async (deps, accountId) => {
    const [subscription] = await deps.db
      .select({ id: subscriptions.id, tier: subscriptions.tier, status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId))
      .orderBy(desc(subscriptions.updatedAt))
      .limit(1);
    const counts = await deps.db
      .select({ status: receipts.status, n: sql<string>`count(*)` })
      .from(receipts)
      .where(eq(receipts.accountId, accountId))
      .groupBy(receipts.status);
    return json({
      fundedCents: await fundedCents(deps.db, accountId),
      subscription: subscription ?? null,
      autoApprove: (await getSettings(deps.db, accountId)).autoApprove,
      receipts: { proposed: 0, approved: 0, skipped: 0, ...Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) },
      paymentsReady: Boolean(deps.paypal),
    });
  });
}
```

`apps/web/app/api/settings/route.ts`:
```ts
import { z } from "zod";
import { setAutoApprove } from "../../../lib/funding/settings";
import { json, withAccount } from "../../../lib/http";

export const runtime = "nodejs";

const Body = z.object({ autoApprove: z.boolean() });

export async function PATCH(req: Request): Promise<Response> {
  return withAccount(req, async (deps, accountId) => {
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) return json({ error: "autoApprove must be true or false" }, 400);
    return json(await setAutoApprove(deps.db, accountId, body.data.autoApprove));
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test apps/web/test/settings.test.ts apps/web/test/receipts.test.ts`
Expected: PASS. The Plan 1 receipt tests still pass, because auto-approve is off by default.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/funding/settings.ts apps/web/lib/receipts/service.ts apps/web/app/api/me apps/web/app/api/settings apps/web/test/settings.test.ts
git commit -m "Add the auto-approve rule and a dashboard summary"
```

---

### Task 9: A minimal working dashboard

UI glue that Plan 3 restyles. The logic lives in the tested API from Tasks 4-8. Here the only unit is a pure money formatter. The page itself is checked by `next build` and by the live sandbox run in Task 10.

**Files:**
- Create: `apps/web/lib/format.ts`, `apps/web/app/dashboard/page.tsx`, `apps/web/app/dashboard/FundingPanel.tsx`
- Test: `apps/web/test/format.test.ts`

**Interfaces:**
- Consumes:
  - HTTP: `/api/me`, `/api/subscriptions`, `/api/subscriptions/:id/reconcile`, `/api/topups`, `/api/topups/:id/capture`, `/api/settings`
  - `TIERS`, and `PayPalProvider`, `PayPalSubscriptionButton` and `PayPalOneTimePaymentButton` from `@paypal/react-paypal-js/sdk-v6`
- Produces: `formatUsd(cents): string` ("$4.53"), and the `/dashboard` page

- [ ] **Step 1: Write the failing test**

`apps/web/test/format.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatUsd } from "../lib/format";

describe("formatUsd", () => {
  it("shows dollars and cents", () => {
    expect(formatUsd(453)).toBe("$4.53");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(123456)).toBe("$1,234.56");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test apps/web/test/format.test.ts`
Expected: FAIL, because `../lib/format` can't be resolved.

- [ ] **Step 3: Write `apps/web/lib/format.ts`**

```ts
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsd(cents: number): string {
  return usd.format(cents / 100);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test apps/web/test/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the dashboard**

`apps/web/app/dashboard/page.tsx`:
```tsx
import { TIERS } from "../../lib/paypal/plans";
import { FundingPanel } from "./FundingPanel";

export const dynamic = "force-dynamic";

export default function Dashboard() {
  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1>Your Upstream budget</h1>
      <FundingPanel
        clientId={process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? ""}
        environment={process.env.NEXT_PUBLIC_PAYPAL_ENV === "production" ? "production" : "sandbox"}
        tiers={TIERS.map((t) => ({ key: t.key, label: t.label }))}
      />
    </main>
  );
}
```

`apps/web/app/dashboard/FundingPanel.tsx`:
```tsx
"use client";

import { PayPalOneTimePaymentButton, PayPalProvider, PayPalSubscriptionButton } from "@paypal/react-paypal-js/sdk-v6";
import { useCallback, useEffect, useState } from "react";
import { formatUsd } from "../../lib/format";

interface Me {
  fundedCents: number;
  subscription: { id: string; tier: string; status: string } | null;
  autoApprove: boolean;
  receipts: { proposed: number; approved: number; skipped: number };
  paymentsReady: boolean;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Something went wrong (${res.status})`);
  return data;
}

export function FundingPanel(props: { clientId: string; environment: "sandbox" | "production"; tiers: { key: string; label: string }[] }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [topupCents, setTopupCents] = useState(1000);

  const refresh = useCallback(async () => {
    try {
      setMe(await call<Me>("GET", "/api/me"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!me && error) {
    return (
      <p>
        {error}. Open your dashboard from the terminal with <code>upstream dashboard</code>.
      </p>
    );
  }
  if (!me) return <p>Loading your budget...</p>;

  const activeTier = me.subscription?.status === "ACTIVE" ? props.tiers.find((t) => t.key === me.subscription!.tier) : undefined;

  return (
    <div>
      <p style={{ fontSize: 32, margin: "8px 0" }}>
        {formatUsd(me.fundedCents)} <span style={{ fontSize: 16, color: "#555" }}>in your budget</span>
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}

      {!me.paymentsReady ? (
        <p>Payments aren&apos;t set up on this server yet.</p>
      ) : (
        <PayPalProvider clientId={props.clientId} environment={props.environment} components={["paypal-payments", "paypal-subscriptions"]} pageType="checkout">
          <h2>Monthly budget</h2>
          {activeTier ? (
            <p>You give {activeTier.label}. Thank you.</p>
          ) : (
            props.tiers.map((t) => (
              <div key={t.key} style={{ margin: "12px 0" }}>
                <p>{t.label}</p>
                <PayPalSubscriptionButton
                  createSubscription={async () => ({
                    subscriptionId: (await call<{ subscriptionId: string }>("POST", "/api/subscriptions", { tier: t.key })).subscriptionId,
                  })}
                  onApprove={async ({ subscriptionId }) => {
                    const r = await call<{ credited: number }>("POST", `/api/subscriptions/${subscriptionId}/reconcile`);
                    setNotice(r.credited > 0 ? `Thanks. ${formatUsd(r.credited)} was added to your budget.` : "Thanks. Your first payment will show up here in a few minutes.");
                    await refresh();
                  }}
                  onError={() => setError("PayPal couldn't start the subscription. Please try again.")}
                />
              </div>
            ))
          )}

          <h2>Add money once</h2>
          <select value={topupCents} onChange={(e) => setTopupCents(Number(e.target.value))} aria-label="Amount to add">
            {[500, 1000, 2500].map((c) => (
              <option key={c} value={c}>
                {formatUsd(c)}
              </option>
            ))}
          </select>
          <PayPalOneTimePaymentButton
            createOrder={async () => ({ orderId: (await call<{ orderId: string }>("POST", "/api/topups", { cents: topupCents })).orderId })}
            onApprove={async ({ orderId }) => {
              const r = await call<{ credited: number }>("POST", `/api/topups/${orderId}/capture`);
              setNotice(`Thanks. ${formatUsd(r.credited)} was added to your budget.`);
              await refresh();
            }}
            onError={() => setError("PayPal couldn't take the payment. Please try again.")}
          />
        </PayPalProvider>
      )}

      <h2>Receipts</h2>
      <label>
        <input
          type="checkbox"
          checked={me.autoApprove}
          onChange={async (e) => {
            await call("PATCH", "/api/settings", { autoApprove: e.target.checked });
            await refresh();
          }}
        />{" "}
        Approve my receipts automatically while I have money in my budget
      </label>
      <p>
        {me.receipts.proposed} waiting for you, {me.receipts.approved} approved.
      </p>
    </div>
  );
}
```

- [ ] **Step 6: Build**

Run: `pnpm --filter web build`
Expected: the build succeeds and lists `/dashboard`, `/connect` and the new `/api/*` routes. If TypeScript rejects an `onApprove` argument type from `@paypal/react-paypal-js`, read the exported type in `node_modules/@paypal/react-paypal-js/dist/types/v6/index.d.ts` and use its field names. Don't cast to `any`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/format.ts apps/web/app/dashboard apps/web/test/format.test.ts
git commit -m "Add a minimal dashboard with PayPal subscribe and top-up buttons"
```

---

### Task 10: Live run against the PayPal sandbox

No new code. This proves the Plan 2a goal with real sandbox money and records what happened.

**Files:**
- Create: `docs/e2e-plan-2a.md` (what ran and what came out; no secrets or ids)

**Needs:**
- Task 2's `PAYPAL_PLAN_*` and `NEXT_PUBLIC_PAYPAL_CLIENT_ID` lines in `apps/web/.env.local`.
- **A sandbox buyer approving in PayPal's popup.** The popup asks for a sandbox *personal* login. Before this task starts, ask Arun to either log in himself, or let Claude use the password of one of the US sandbox personal test accounts. Those are fake test accounts, but a password typed into a login form still needs his OK.

- [ ] **Step 1: Start the server and open the dashboard**

Run `pnpm --filter web dev`.
Run `node packages/cli/plugin/dist/upstream.mjs dashboard`, after rebuilding with `pnpm --filter upstream-pay build`.
Expected: it prints a `/connect?code=...` link and opens it. The browser lands on `/dashboard` showing "$0.00 in your budget", three monthly plans and a top-up button.

- [ ] **Step 2: Subscribe to the $5 plan**

Click the PayPal button under "$5 a month", log in as the sandbox buyer, and approve.
Expected:
- The popup closes.
- The page says either "Thanks. $4.xx was added to your budget." or "Thanks. Your first payment will show up here in a few minutes."
- If it's the second, click into the page after a few minutes. The reconcile runs again on the next approval, or call it yourself:
  ```
  curl -X POST localhost:3000/api/subscriptions/<id>/reconcile -H "authorization: Bearer <token>"
  ```
- Record the real transaction fields PayPal returned, from the `raw` column of `funding_events`. If `amount_with_breakdown.net_amount` is named differently, fix `PaypalSubscriptionTxn` and `reconcileSubscription` with a failing test first.

- [ ] **Step 3: Top up $10**

Pick $10.00, click the one-time PayPal button, and approve.
Expected: "Thanks. $9.xx was added to your budget." and the budget figure goes up by the same amount.

- [ ] **Step 4: Check that nothing is double-counted**

Run the top-up capture call again for the same order, and reconcile the subscription again.
Expected: `credited: 0` both times, and the same budget total.

- [ ] **Step 5: Auto-approve**

Tick "Approve my receipts automatically...". Then run:
```
node packages/cli/plugin/dist/upstream.mjs receipt --transcript packages/cli/test/fixtures/session.jsonl --cwd packages/cli
```
Expected: the printed receipt ends with `Approved.`

- [ ] **Step 6: Record and commit**

Write `docs/e2e-plan-2a.md` covering:
- the budget after each step
- the real PayPal response shapes, and whether any code had to change
- the time between approval and the first subscription payment
- anything surprising

Webhooks can't reach `localhost`. Their live check happens after the Render deploy in Plan 3, through the dashboard's Webhooks simulator; note that here.

```bash
git add docs/e2e-plan-2a.md
git commit -m "Record Plan 2a sandbox run"
```

---

## After Plan 2a

Write **Plan 2b (payouts)** against these interfaces:
- `fundedCents` becomes the funded total minus what has been allocated.
- Maintainers are resolved from FUNDING.yml or 90-day committers, then split.
- Claims go through GitHub OAuth plus Log in with PayPal. The hosted https callback has to be added in the dashboard first.
- Settlement uses largest-remainder maths, carries over anything under $1, and returns money unclaimed for 90 days.
- Payouts batches go to `PAYPAL_ID`, and the `PAYMENT.PAYOUTS-ITEM.*` webhooks track them.
- Self-dealing controls: no payout to a maintainer whose verified PayPal payer id matches a funding event's `payer_id` for that funder, a per-funder per-maintainer monthly cap, and a hold before the first payout.
- Refunds and reversals reduce the budget: negative ledger entries for `PAYMENT.SALE.REFUNDED`/`REVERSED` and `PAYMENT.CAPTURE.REFUNDED`/`REVERSED`, and a reconcile that notices a refunded sale. Without this, a funder could pay, have it paid out, then win a chargeback (final review of Plan 2a, I6).
