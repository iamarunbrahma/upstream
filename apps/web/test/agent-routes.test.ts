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
const { GET: cancelled } = await import("../app/api/agent/cancelled/route");

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
    expect(orders.urls.get("ORDER-1")).toEqual({ returnUrl: "https://up.test/agent/paid", cancelUrl: "https://up.test/api/agent/cancelled" });
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

  it("cancel a payment when PayPal sends the developer back from Cancel, then show the cancelled page", async () => {
    await start(post("http://local/api/agent/payments", { cents: 1000 }));
    const res = await cancelled(new Request("http://local/api/agent/cancelled?token=ORDER-1"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://up.test/agent/paid?cancelled=1");
    expect(await (await finishFor("ORDER-1")).json()).toEqual({ status: "cancelled", budgetCents: 0 });
    expect((await cancelled(new Request("http://local/api/agent/cancelled"))).status).toBe(303);
  });
});
