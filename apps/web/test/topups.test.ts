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
