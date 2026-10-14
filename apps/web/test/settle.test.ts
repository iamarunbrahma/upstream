import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { receipts } from "../lib/db/schema";
import { balanceCents } from "../lib/funding/ledger";
import { MONTHLY_CAP_CENTS, settle } from "../lib/funding/settle";
import { decideReceipt, type Deps } from "../lib/receipts/service";
import { DAY, NOW, settlementWorld } from "./settle-fixtures";

let w: Awaited<ReturnType<typeof settlementWorld>>;
beforeEach(async () => {
  w = await settlementWorld();
});
const settledBy = async (id: string) => (await w.db.select({ s: receipts.settlementId }).from(receipts).where(eq(receipts.id, id)))[0]!.s;

describe("settle", () => {
  it("splits the whole budget across approved receipts, then across each package's maintainers, to the cent", async () => {
    const f = await w.funder(1350);
    const r1 = await w.receipt(f, { a: 6000, b: 4000 });
    const r2 = await w.receipt(f, { a: 10_000 });
    const run = await settle(w.deps);
    expect(await w.owed(f)).toEqual({ alice: 540, bob: 540, carol: 270 });
    expect(await balanceCents(w.db, f)).toBe(0);
    expect(await settledBy(r1)).toBe(run.settlementId);
    expect(await settledBy(r2)).toBe(run.settlementId);
    expect(run).toMatchObject({ settledFunders: 1, waitingFunders: 0, setAsideCents: 1350 });
  });

  it("settles each receipt once, even when it runs twice", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await settle(w.deps);
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({ carol: 1000 });
  });

  it("keeps a package's share in the budget when nobody can be paid for it", async () => {
    w.lookups["npm:orphan"] = null;
    w.lookups["npm:nobody"] = { source: "none", recipients: [] };
    const f = await w.funder(900);
    const r = await w.receipt(f, { b: 3400, orphan: 3300, nobody: 3300 });
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({ carol: 306 });
    expect(await balanceCents(w.db, f)).toBe(594);
    expect(await settledBy(r)).not.toBeNull();
  });

  it("waits for GitHub instead of guessing, and settles on a later run", async () => {
    w.lookups["npm:b"] = "later";
    const f = await w.funder(500);
    const r = await w.receipt(f, { a: 5000, b: 5000 });
    expect(await settle(w.deps)).toMatchObject({ settledFunders: 0, waitingFunders: 1 });
    expect(await w.owed(f)).toEqual({});
    expect(await settledBy(r)).toBeNull();
    w.lookups["npm:b"] = { source: "committers", recipients: [{ login: "carol", githubId: 103, shareBp: 10_000 }] };
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({ alice: 125, bob: 125, carol: 250 });
  });

  it("waits for the package registry instead of guessing when it can't be reached", async () => {
    w.registryDown.add("npm:b");
    const f = await w.funder(500);
    const r = await w.receipt(f, { a: 5000, b: 5000 });
    expect(await settle(w.deps)).toMatchObject({ settledFunders: 0, waitingFunders: 1 });
    expect(await settledBy(r)).toBeNull();
    w.registryDown.clear();
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({ alice: 125, bob: 125, carol: 250 });
  });

  it("keeps the share of a recipient GitHub gave no account id for in the budget", async () => {
    w.lookups["npm:b"] = { source: "committers", recipients: [{ login: "ghost", githubId: null, shareBp: 10_000 }] };
    const f = await w.funder(500);
    await w.receipt(f, { b: 10_000 });
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({});
    expect(await balanceCents(w.db, f)).toBe(500);
  });

  it("waits for money: approved receipts with an empty budget are settled once money arrives", async () => {
    const f = await w.funder(0);
    const r = await w.receipt(f, { b: 10_000 });
    await settle(w.deps);
    expect(await settledBy(r)).toBeNull();
    await w.fund(f, 700);
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({ carol: 700 });
  });

  it("never sets aside more than $100 a month from one funder for one maintainer", async () => {
    const f = await w.funder(30_000);
    await w.receipt(f, { b: 10_000 });
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({ carol: MONTHLY_CAP_CENTS });
    expect(await balanceCents(w.db, f)).toBe(20_000);

    await w.receipt(f, { b: 10_000 });
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({ carol: MONTHLY_CAP_CENTS });

    w.at(19); // 2 November: a new month
    await w.receipt(f, { b: 10_000 });
    await settle(w.deps);
    expect(await w.owed(f)).toEqual({ carol: 2 * MONTHLY_CAP_CENTS });
  });

  it("only spends each funder's own budget", async () => {
    const rich = await w.funder(1000);
    const poor = await w.funder(100);
    await w.receipt(rich, { b: 10_000 });
    await w.receipt(poor, { a: 10_000 });
    await settle(w.deps);
    expect(await w.owed(rich)).toEqual({ carol: 1000 });
    expect(await w.owed(poor)).toEqual({ alice: 50, bob: 50 });
  });

  it("drops receipts nobody approved within 14 days, and they can't be approved afterwards", async () => {
    const f = await w.funder(500);
    const stale = await w.receipt(f, { b: 10_000 }, "proposed", new Date(NOW.getTime() - 15 * DAY));
    const fresh = await w.receipt(f, { b: 10_000 }, "proposed", new Date(NOW.getTime() - 13 * DAY));
    expect((await settle(w.deps)).expiredReceipts).toBe(1);
    const status = async (id: string) => (await w.db.select({ s: receipts.status }).from(receipts).where(eq(receipts.id, id)))[0]!.s;
    expect(await status(stale)).toBe("expired");
    expect(await status(fresh)).toBe("proposed");
    const view = await decideReceipt({ db: w.db } as unknown as Deps, f, stale, "approve");
    expect(view?.status).toBe("expired");
    expect(await w.owed(f)).toEqual({});
  });
});
