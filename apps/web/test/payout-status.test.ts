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
    expect(await reconcilePayouts(w.deps)).toMatchObject({ updated: 1 });
    expect(await w.owed(funder, "paid")).toEqual({ carol: 1000 });
    expect(await line()).toMatchObject({ status: "SUCCESS", feeCents: 25 });
    expect(await reconcilePayouts(w.deps)).toMatchObject({ updated: 0 });
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

  it("on a payout webhook, asks PayPal for the line's current status instead of trusting the event", async () => {
    await settle(w.deps);
    w.paypal.loseNextAnswer("createPayoutBatch");
    await payOut(w.deps);
    await payOut(w.deps);
    // As if PayPal's "already exists" answer had come without its link to the batch.
    await w.db.update(settlements).set({ payoutBatchId: null });
    const now = w.paypal.setPayoutItemStatus((await line()).id, "SUCCESS");
    const stale = { ...now, transaction_status: "BLOCKED" };
    expect(await webhook("E1", "PAYMENT.PAYOUTS-ITEM.BLOCKED", stale)).toEqual({ status: 200, outcome: "payout line updated" });
    expect(await webhook("E1", "PAYMENT.PAYOUTS-ITEM.BLOCKED", stale)).toEqual({ status: 200, outcome: "duplicate" });
    expect(await w.owed(funder, "paid")).toEqual({ carol: 1000 });
    const [s] = await w.db.select().from(settlements);
    expect(s!.payoutBatchId).toBe(now.payout_batch_id);
  });

  it("ignores payout events for lines PayPal doesn't know, or that belong to another batch", async () => {
    await settle(w.deps);
    await payOut(w.deps);
    const real = w.paypal.setPayoutItemStatus((await line()).id, "SUCCESS");
    expect((await webhook("E1", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", { ...real, payout_item_id: "NOTANITEM" })).outcome).toBe("unknown payout line");
    expect((await webhook("E2", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", { transaction_status: "SUCCESS" })).outcome).toBe("ignored");
    await w.db.update(settlements).set({ payoutBatchId: "BATCH-OTHER" });
    expect((await webhook("E3", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", real)).outcome).toBe("unknown payout line");
    expect(await w.owed(funder, "paid")).toEqual({});
  });

  it("never takes back money PayPal has paid, whatever it says later", async () => {
    await settle(w.deps);
    await payOut(w.deps);
    const paid = w.paypal.setPayoutItemStatus((await line()).id, "SUCCESS");
    await reconcilePayouts(w.deps);
    w.paypal.setPayoutItemStatus((await line()).id, "FAILED");
    await webhook("E1", "PAYMENT.PAYOUTS-ITEM.FAILED", { ...paid, transaction_status: "FAILED" });
    expect(await w.owed(funder, "paid")).toEqual({ carol: 1000 });
    await settle(w.deps);
    await payOut(w.deps);
    expect(w.paypal.payoutBatches.size).toBe(1);
  });

  it("gives the money back to the funder when PayPal blocks a payment, or the maintainer sends it back", async () => {
    await settle(w.deps);
    await payOut(w.deps);
    w.paypal.setPayoutItemStatus((await line()).id, "BLOCKED");
    await reconcilePayouts(w.deps);
    expect(await w.owed(funder, "returned")).toEqual({ carol: 1000 });
    expect(await balanceCents(w.db, funder)).toBe(1000);
    const [a] = await w.db.select().from(accruals);
    expect(a!.returnReason).toBe("bounced");
    await settle(w.deps);
    await payOut(w.deps);
    expect(w.paypal.payoutBatches.size).toBe(1);

    const other = await w.funder(500);
    await w.receipt(other, { b: 10_000 });
    await settle(w.deps);
    await payOut(w.deps);
    const sent = (await w.db.select().from(payoutItems)).find((l) => l.status === "PENDING")!;
    const paid = w.paypal.setPayoutItemStatus(sent.id, "SUCCESS");
    await webhook("E9", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", paid);
    expect(await w.owed(other, "paid")).toEqual({ carol: 500 });
    w.paypal.setPayoutItemStatus(sent.id, "REFUNDED");
    await webhook("E10", "PAYMENT.PAYOUTS-ITEM.REFUNDED", paid);
    expect(await w.owed(other, "returned")).toEqual({ carol: 500 });
  });
});
