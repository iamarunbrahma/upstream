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
