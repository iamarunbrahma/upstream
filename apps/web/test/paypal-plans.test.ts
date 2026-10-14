import { describe, expect, it } from "vitest";
import { FakePayPal } from "../lib/paypal/fake";
import { ensureCatalog, planIdsFromEnv, planName, TIERS } from "../lib/paypal/plans";

describe("ensureCatalog", () => {
  it("creates the product and one monthly plan per tier, and creates nothing the second time", async () => {
    const pp = new FakePayPal();
    const first = await ensureCatalog(pp);
    const second = await ensureCatalog(pp);
    expect(second).toEqual(first);
    expect(pp.calls.filter((c) => c === "createProduct")).toHaveLength(1);
    expect(pp.calls.filter((c) => c === "createPlan")).toHaveLength(3);
    expect([...pp.plans.values()].map((p) => [p.name, p.cents])).toEqual(TIERS.map((t) => [planName(t.cents), t.cents]));
    expect(first.envLines).toEqual([
      `PAYPAL_PLAN_STARTER=${first.planIds.starter}`,
      `PAYPAL_PLAN_BUILDER=${first.planIds.builder}`,
      `PAYPAL_PLAN_TEAM=${first.planIds.team}`,
    ]);
  });
});

describe("planIdsFromEnv", () => {
  it("reads only the tiers that are configured", () => {
    expect(planIdsFromEnv({ PAYPAL_PLAN_STARTER: "P-1", PAYPAL_PLAN_TEAM: "P-3" })).toEqual({ starter: "P-1", team: "P-3" });
  });
});
