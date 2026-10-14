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
