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
    expect(await ok.json()).toEqual({ status: "ACTIVE", credited: 453, balanceCents: 453 });
    expect((await postSubscription(post("/api/subscriptions", owner.token, { tier: "gold" }))).status).toBe(400);
  });
});
