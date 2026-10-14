import { eq, sql } from "drizzle-orm";
import type { Db } from "../lib/db/client";
import { beforeEach, describe, expect, it } from "vitest";
import { accruals, maintainers, payoutItems, settlements } from "../lib/db/schema";
import { balanceCents } from "../lib/funding/ledger";
import { FIRST_PAYOUT_HOLD_MS, payOut, queuePayouts, resolvePayoutCheck } from "../lib/funding/payouts";
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

/** Runs `before` just as the first query that queues money is about to run: the moment another process could act. */
function interleave(db: Db, before: () => Promise<void>): Db {
  let fired = false;
  const runFirst = <T extends object>(q: T): T =>
    new Proxy(q, {
      get(target, p) {
        const v = Reflect.get(target, p) as unknown;
        if (p === "then") return (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) => before().then(() => (target as unknown as Promise<unknown>).then(res, rej));
        return typeof v === "function" ? (...args: unknown[]) => runFirst((v as (...a: unknown[]) => object).apply(target, args)) : v;
      },
    });
  return new Proxy(db, {
    get(target, p) {
      const v = Reflect.get(target, p) as unknown;
      if (p !== "update") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      return (table: unknown) => {
        const q = target.update(table as typeof accruals);
        if (table !== accruals) return q;
        return new Proxy(q, {
          get(b, bp) {
            const bv = Reflect.get(b, bp) as unknown;
            if (bp !== "set") return typeof bv === "function" ? (bv as (...a: unknown[]) => unknown).bind(b) : bv;
            return (values: { status?: string }) => {
              const chain = b.set(values as never);
              if (values.status !== "queued" || fired) return chain;
              fired = true;
              return runFirst(chain);
            };
          },
        });
      };
    },
  });
}

describe("queuePayouts", () => {
  it("puts exactly the money it moves on a payout line, even if a bounced line frees more at that moment", async () => {
    const f = await w.funder(1500);
    await w.claim("carol", "PAYER-CAROL", 8);
    const [old] = await w.db.insert(settlements).values({}).returning();
    const [oldLine] = await w.db.insert(payoutItems).values({ settlementId: old!.id, login: "carol", payerId: "PAYER-CAROL", cents: 1000 }).returning();
    const owedTo = { funderId: f, login: "carol", ecosystem: "npm" as const, name: "b" };
    await w.db.insert(accruals).values([
      { ...owedTo, settlementId: old!.id, cents: 1000, status: "queued", payoutItemId: oldLine!.id },
      { ...owedTo, settlementId: old!.id, cents: 500, status: "held" },
    ]);
    const [run] = await w.db.insert(settlements).values({}).returning();
    // PayPal says the old line came back, and that is applied while this run is queuing.
    const bounced = () => w.db.update(accruals).set({ status: "held", payoutItemId: null }).where(eq(accruals.payoutItemId, oldLine!.id)).then(() => undefined);
    await queuePayouts(interleave(w.db, bounced), run!.id, new Date());
    const [line] = await w.db.select().from(payoutItems).where(eq(payoutItems.settlementId, run!.id));
    const [linked] = await w.db.select({ total: sql<number>`sum(${accruals.cents})::int` }).from(accruals).where(eq(accruals.payoutItemId, line!.id));
    expect(line!.cents).toBe(linked!.total);
  });
});

describe("paying the right person", () => {
  it("pays the GitHub account that earned the money, even after a rename and a reused name", async () => {
    const f = await w.funder(1000);
    w.lookups["npm:b"] = { source: "committers", recipients: [{ login: "bob", githubId: 5, shareBp: 10_000 }] };
    await w.receipt(f, { b: 10_000 });
    await settle(w.deps);
    const [a] = await w.db.select().from(accruals);
    expect(a).toMatchObject({ login: "bob", githubId: 5 });
    // Then Bob (account 5) renamed to "bobby"; Carol (account 6) took the free name "bob". Both linked PayPal.
    const linked = new Date(Date.now() - 30 * DAY);
    await w.db.insert(maintainers).values([
      { login: "bobby", githubId: 5, paypalPayerId: "PAYER-BOB", claimedAt: linked },
      { login: "bob", githubId: 6, paypalPayerId: "PAYER-CAROL", claimedAt: linked },
    ]);
    await settle(w.deps);
    await payOut(w.deps);
    expect(batches()[0]!.items.map((i) => [i.payout_item?.receiver, i.payout_item?.amount?.value])).toEqual([["PAYER-BOB", "10.00"]]);
  });
});

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

  it("doesn't start the resend clock when PayPal flatly refuses a batch, so a run a month later still sends it", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await w.claim("carol", "PAYER-CAROL", 8);
    await settle(w.deps);
    w.paypal.failNext("createPayoutBatch", new PayPalError(422, "INSUFFICIENT_FUNDS", "Sender has insufficient funds", null));
    expect((await payOut(w.deps))[0]).toMatchObject({ outcome: "failed" });
    w.at(30);
    expect((await payOut(w.deps))[0]).toMatchObject({ outcome: "sent" });
    expect(batches()).toHaveLength(1);
  });

  it("lets a person settle a batch that needs checking: resend it, or give the money back", async () => {
    const stuck = async () => {
      const f = await w.funder(1000);
      await w.receipt(f, { b: 10_000 });
      const { settlementId } = await settle(w.deps);
      w.paypal.failNext("createPayoutBatch", new PayPalError(504, "TIMEOUT", "PayPal took too long to answer", null));
      await payOut(w.deps);
      w.at(26);
      expect((await payOut(w.deps))[0]).toMatchObject({ outcome: "needs-check", settlementId });
      w.at(0);
      return { f, settlementId };
    };
    await w.claim("carol", "PAYER-CAROL", 8);
    const first = await stuck();
    expect(await resolvePayoutCheck(w.db, first.settlementId, "resend")).toBe(true);
    expect((await payOut(w.deps))[0]).toMatchObject({ outcome: "sent", settlementId: first.settlementId });

    const second = await stuck();
    expect(await resolvePayoutCheck(w.db, second.settlementId, "give-back")).toBe(true);
    expect(await w.owed(second.f, "returned")).toEqual({ carol: 1000 });
    expect(await balanceCents(w.db, second.f)).toBe(1000);
    expect(await payOut(w.deps)).toEqual([]);
    expect(await resolvePayoutCheck(w.db, second.settlementId, "resend")).toBe(false);
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
