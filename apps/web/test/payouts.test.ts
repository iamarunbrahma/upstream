import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accruals, settlements } from "../lib/db/schema";
import { balanceCents } from "../lib/funding/ledger";
import { FIRST_PAYOUT_HOLD_MS, payOut } from "../lib/funding/payouts";
import { settle } from "../lib/funding/settle";
import { PayPalError } from "../lib/paypal/client";
import { DAY, settlementWorld } from "./settle-fixtures";

let w: Awaited<ReturnType<typeof settlementWorld>>;
beforeEach(async () => {
  w = await settlementWorld();
});
const run = async () => {
  const s = await settle(w.deps);
  return { ...s, sent: await payOut(w.deps) };
};
const batches = () => [...w.paypal.payoutBatches.values()];

describe("payOut", () => {
  it("pays each claimed maintainer on one line, in one PayPal batch named after the settlement", async () => {
    const f = await w.funder(1350);
    await w.receipt(f, { a: 6000, b: 4000 });
    await w.receipt(f, { a: 10_000 });
    await w.claim("alice", "PAYER-ALICE", 8);
    await w.claim("bob", "PAYER-BOB", 8);
    const r = await run();
    expect(r).toMatchObject({ payoutLines: 2, queuedCents: 1080 });
    expect(batches()).toHaveLength(1);
    expect(batches()[0]!.senderBatchId).toBe(r.settlementId);
    expect(batches()[0]!.items.map((i) => [i.payout_item?.receiver, i.payout_item?.amount?.value])).toEqual([
      ["PAYER-ALICE", "5.40"],
      ["PAYER-BOB", "5.40"],
    ]);
    expect(await w.owed(f, "queued")).toEqual({ alice: 540, bob: 540 });
    expect(await w.owed(f, "held")).toEqual({ carol: 270 });
    const [s] = await w.db.select().from(settlements).where(eq(settlements.id, r.settlementId));
    expect(s!.payoutBatchId).toBe(batches()[0]!.id);
  });

  it("sends a settlement's batch once, even when PayPal's answer was lost", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await w.claim("carol", "PAYER-CAROL", 8);
    await settle(w.deps);
    w.paypal.loseNextAnswer("createPayoutBatch");
    expect((await payOut(w.deps))[0]).toMatchObject({ outcome: "failed" });
    expect((await payOut(w.deps))[0]).toMatchObject({ outcome: "sent-before", batchId: batches()[0]!.id });
    expect(await payOut(w.deps)).toEqual([]);
    expect(batches()).toHaveLength(1);
    const [s] = await w.db.select().from(settlements);
    expect(s!.payoutBatchId).toBe(batches()[0]!.id);
  });

  it("won't resend a batch it may have sent more than 25 days ago, and asks for a check instead", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await w.claim("carol", "PAYER-CAROL", 8);
    await settle(w.deps);
    w.paypal.failNext("createPayoutBatch", new PayPalError(504, "TIMEOUT", "PayPal took too long to answer", null));
    expect((await payOut(w.deps))[0]).toMatchObject({ outcome: "failed" });
    w.at(26);
    expect((await payOut(w.deps))[0]).toMatchObject({ outcome: "needs-check" });
    expect(w.paypal.calls.filter((c) => c === "createPayoutBatch")).toHaveLength(1);
    expect(await payOut(w.deps)).toEqual([]);
    const [s] = await w.db.select().from(settlements);
    expect(s!.batchStatus).toBe("NEEDS_CHECK");
  });

  it("tries again on the next run when PayPal fails before taking the batch", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await w.claim("carol", "PAYER-CAROL", 8);
    await settle(w.deps);
    w.paypal.failNext("createPayoutBatch", new PayPalError(503, "SERVICE_UNAVAILABLE", "try later", null));
    expect((await payOut(w.deps))[0]).toMatchObject({ outcome: "failed" });
    expect(batches()).toHaveLength(0);
    expect((await payOut(w.deps))[0]).toMatchObject({ outcome: "sent" });
    expect(batches()).toHaveLength(1);
  });

  it("carries amounts under $1 over until they add up", async () => {
    const f = await w.funder(60);
    await w.receipt(f, { b: 10_000 });
    await w.claim("carol", "PAYER-CAROL", 8);
    expect(await run()).toMatchObject({ payoutLines: 0 });
    expect(await w.owed(f, "held")).toEqual({ carol: 60 });
    await w.fund(f, 50);
    await w.receipt(f, { b: 10_000 });
    expect(await run()).toMatchObject({ payoutLines: 1, queuedCents: 110 });
  });

  it("waits 7 days after a maintainer links PayPal before their first payout", async () => {
    expect(FIRST_PAYOUT_HOLD_MS).toBe(7 * DAY);
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await w.claim("carol", "PAYER-CAROL", 2);
    expect(await run()).toMatchObject({ payoutLines: 0 });
    w.at(5);
    expect(await run()).toMatchObject({ payoutLines: 1, queuedCents: 1000 });
  });

  it("never pays a funder's money to the funder's own PayPal account", async () => {
    const f = await w.funder(1000, "PAYER-SAME");
    await w.receipt(f, { a: 10_000 });
    await w.claim("alice", "PAYER-SAME", 8);
    await w.claim("bob", "PAYER-BOB", 8);
    const r = await run();
    expect(r).toMatchObject({ payoutLines: 1, queuedCents: 500, returnedCents: 500 });
    expect(await w.owed(f, "returned")).toEqual({ alice: 500 });
    expect(await balanceCents(w.db, f)).toBe(500);
    const [back] = await w.db.select().from(accruals).where(eq(accruals.login, "alice"));
    expect(back!.returnReason).toBe("same-person");
  });

  it("gives unclaimed money back to the funder after 90 days, to be given again", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await run();
    w.at(89);
    expect(await run()).toMatchObject({ returnedCents: 0 });
    w.at(91);
    expect(await run()).toMatchObject({ returnedCents: 1000 });
    expect(await w.owed(f, "returned")).toEqual({ carol: 1000 });
    expect(await balanceCents(w.db, f)).toBe(1000);
    await w.receipt(f, { a: 10_000 });
    await run();
    expect(await w.owed(f, "held")).toEqual({ alice: 500, bob: 500 });
  });

  it("still pays a maintainer who claimed in time but is in the hold when the 90 days end", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await run();
    w.at(89);
    await w.claim("carol", "PAYER-CAROL", 0);
    w.at(91);
    expect(await run()).toMatchObject({ returnedCents: 0, payoutLines: 0 });
    w.at(97);
    expect(await run()).toMatchObject({ payoutLines: 1, queuedCents: 1000 });
  });
});
