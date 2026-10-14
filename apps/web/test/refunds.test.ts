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
