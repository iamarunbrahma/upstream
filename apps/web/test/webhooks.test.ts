import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { agentPayments, fundingEvents, subscriptions } from "../lib/db/schema";
import { startAgentPayment } from "../lib/funding/agent-payments";
import { fundedCents } from "../lib/funding/ledger";
import { startSubscription, type FundingDeps } from "../lib/funding/subscriptions";
import { startTopup } from "../lib/funding/topups";
import { handleWebhook } from "../lib/funding/webhooks";
import { PayPalError } from "../lib/paypal/client";
import { FakeAgentOrders, FakePayPal } from "../lib/paypal/fake";

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
    const sale = pp.subscriptions.get(id)!.transactions[0]!.id;
    expect(await send(body("E1", "PAYMENT.SALE.COMPLETED", { id: sale, billing_agreement_id: id }))).toEqual({ status: 200, outcome: "reconciled" });
    expect(await send(body("E2", "PAYMENT.SALE.COMPLETED", { id: sale, billing_agreement_id: id }))).toEqual({ status: 200, outcome: "reconciled" });
    expect(await send(body("E2", "PAYMENT.SALE.COMPLETED", { id: sale, billing_agreement_id: id }))).toEqual({ status: 200, outcome: "duplicate" });
    expect(await fundedCents(deps.db, accountId)).toBe(453);
  });

  it("asks PayPal to send a payment event again while PayPal doesn't list that payment yet", async () => {
    const { accountId, id } = await activeSubscription();
    const late = body("E1", "PAYMENT.SALE.COMPLETED", { id: "SALE-LATE", billing_agreement_id: id });
    expect(await send(late)).toEqual({ status: 503, outcome: "payment not listed yet" });
    pp.addSubscriptionPayment(id, "SALE-LATE", 453);
    expect(await send(late)).toEqual({ status: 200, outcome: "reconciled" });
    expect(await fundedCents(deps.db, accountId)).toBe(906);
  });

  it("updates the subscription status on billing events", async () => {
    const { id } = await activeSubscription();
    pp.subscriptions.get(id)!.status = "CANCELLED";
    await send(body("E1", "BILLING.SUBSCRIPTION.CANCELLED", { id }));
    const [row] = await deps.db.select().from(subscriptions).where(eq(subscriptions.id, id));
    expect(row!.status).toBe("CANCELLED");
  });

  /** A top-up PayPal captured while our own capture call never got its answer back: only the webhook says so. */
  async function capturedTopup(payerId: string) {
    const { accountId } = await createDevice(deps.db, null);
    const orderId = await startTopup(deps, accountId, 1000);
    pp.approveOrder(orderId, payerId);
    const capture = (await pp.captureOrder(orderId)).purchase_units![0]!.payments!.captures![0]!;
    return { accountId, orderId, event: { ...capture, supplementary_data: { related_ids: { order_id: orderId } } } };
  }

  it("credits a completed capture from PayPal's order, with who paid, once", async () => {
    const { accountId, event } = await capturedTopup("PAYER-B");
    expect((await send(body("E1", "PAYMENT.CAPTURE.COMPLETED", event))).outcome).toBe("credited");
    expect((await send(body("E2", "PAYMENT.CAPTURE.COMPLETED", event))).outcome).toBe("already credited");
    expect(await fundedCents(deps.db, accountId)).toBe(916);
    const [row] = await deps.db.select().from(fundingEvents).where(eq(fundingEvents.paypalId, event.id));
    expect(row!.payerId).toBe("PAYER-B");
  });

  it("credits an agent payment's capture that only the webhook announced, for the account that started it, once", async () => {
    const { accountId } = await createDevice(deps.db, null);
    const urls = { returnUrl: "https://up.test/agent/paid", cancelUrl: "https://up.test/api/agent/cancelled" };
    const { orderId } = await startAgentPayment({ db: deps.db, orders: new FakeAgentOrders(pp) }, accountId, 1000, urls);
    pp.approveOrder(orderId, "PAYER-C");
    const capture = (await pp.captureOrder(orderId)).purchase_units![0]!.payments!.captures![0]!;
    const event = { id: capture.id, status: "COMPLETED", amount: capture.amount, supplementary_data: { related_ids: { order_id: orderId } } };
    expect((await send(body("E1", "PAYMENT.CAPTURE.COMPLETED", event))).outcome).toBe("credited");
    expect((await send(body("E2", "PAYMENT.CAPTURE.COMPLETED", event))).outcome).toBe("already credited");
    expect(await fundedCents(deps.db, accountId)).toBe(916);
    const [row] = await deps.db.select().from(agentPayments).where(eq(agentPayments.orderId, orderId));
    expect(row!.status).toBe("captured");
    const unknown = { ...event, id: "CAP-X", supplementary_data: { related_ids: { order_id: "ORDER-NOT-OURS" } } };
    expect((await send(body("E3", "PAYMENT.CAPTURE.COMPLETED", unknown))).outcome).toBe("ignored");
  });

  it("credits nothing when a capture event names an account that didn't make the order", async () => {
    const { accountId, event } = await capturedTopup("PAYER-B");
    const other = await createDevice(deps.db, null);
    expect((await send(body("E1", "PAYMENT.CAPTURE.COMPLETED", { ...event, custom_id: other.accountId }))).outcome).toBe("unknown order");
    expect(await fundedCents(deps.db, other.accountId)).toBe(0);
    expect(await fundedCents(deps.db, accountId)).toBe(0);
  });

  it("ignores events about accounts or subscriptions it doesn't know", async () => {
    expect((await send(body("E1", "PAYMENT.CAPTURE.COMPLETED", { id: "CAP-2", status: "COMPLETED", custom_id: "8a1c2b3d-0000-4000-8000-000000000000", amount: { currency_code: "USD", value: "5.00" }, supplementary_data: { related_ids: { order_id: "ORDER-X" } } }))).outcome).toBe("unknown account");
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
