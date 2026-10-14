import { beforeEach, describe, expect, it } from "vitest";
import { givenLines, projectSplit } from "../lib/funding/view";
import { runSettlement } from "../lib/funding/run";
import { settlementWorld } from "./settle-fixtures";

let w: Awaited<ReturnType<typeof settlementWorld>>;
beforeEach(async () => {
  w = await settlementWorld();
});

describe("projectSplit", () => {
  it("shows what settling today would set aside per package, to the cent, matching the settlement", async () => {
    const f = await w.funder(1350);
    await w.receipt(f, { a: 6000, b: 4000 });
    await w.receipt(f, { a: 10_000 });
    await w.receipt(f, { b: 10_000 }, "proposed");
    expect(await projectSplit(w.db, f)).toEqual([
      { ecosystem: "npm", name: "a", cents: 1080 },
      { ecosystem: "npm", name: "b", cents: 270 },
    ]);
    const run = await runSettlement(w.deps);
    expect(run.setAsideCents).toBe(1350);
    expect(await projectSplit(w.db, f)).toEqual([]);
  });

  it("is empty with an empty budget or nothing approved", async () => {
    const broke = await w.funder(0);
    await w.receipt(broke, { a: 10_000 });
    expect(await projectSplit(w.db, broke)).toEqual([]);
    expect(await projectSplit(w.db, await w.funder(500))).toEqual([]);
  });
});

describe("givenLines", () => {
  it("shows where the money went: waiting for a maintainer to join, on its way, then paid", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { a: 6000, b: 4000 });
    await w.claim("alice", "PAYER-ALICE", 8);
    await runSettlement(w.deps);
    expect(await givenLines(w.db, f)).toEqual([
      { login: "carol", ecosystem: "npm", name: "b", cents: 400, state: "waiting" },
      { login: "alice", ecosystem: "npm", name: "a", cents: 300, state: "on-its-way" },
      { login: "bob", ecosystem: "npm", name: "a", cents: 300, state: "waiting" },
    ]);
    const line = [...w.paypal.payoutBatches.values()][0]!.items[0]!;
    w.paypal.setPayoutItemStatus(line.payout_item!.sender_item_id!, "SUCCESS");
    await runSettlement(w.deps);
    expect((await givenLines(w.db, f)).find((l) => l.login === "alice")).toMatchObject({ state: "paid", cents: 300 });
  });

  it("says when a maintainer has joined but their payout hasn't gone out yet", async () => {
    const f = await w.funder(1000);
    await w.receipt(f, { b: 10_000 });
    await w.claim("carol", "PAYER-CAROL", 2);
    await runSettlement(w.deps);
    expect(await givenLines(w.db, f)).toEqual([{ login: "carol", ecosystem: "npm", name: "b", cents: 1000, state: "held" }]);
  });

  it("shows money given back to the budget", async () => {
    const f = await w.funder(1000, "PAYER-CAROL");
    await w.receipt(f, { b: 10_000 });
    await w.claim("carol", "PAYER-CAROL", 8);
    await runSettlement(w.deps);
    expect(await givenLines(w.db, f)).toEqual([{ login: "carol", ecosystem: "npm", name: "b", cents: 1000, state: "returned" }]);
  });
});
