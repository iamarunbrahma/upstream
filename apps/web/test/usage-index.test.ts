import { describe, expect, it } from "vitest";
import { aggregateUsage, indexRows, type UsageIndex } from "../lib/index/usage";
import { settlementWorld } from "./settle-fixtures";
import { runSettlement } from "../lib/funding/run";

const share = (name: string, weightBp: number) => ({ ecosystem: "npm" as const, name, weightBp });

describe("aggregateUsage", () => {
  it("averages each package's share over every session, keeping packages seen in enough sessions", () => {
    const sessions = [[share("a", 6000), share("b", 4000)], [share("a", 10_000)], [share("c", 10_000)], [share("b", 10_000)], []];
    expect(aggregateUsage(sessions, { minSessions: 2, top: 10 })).toEqual({
      sessions: 4,
      packages: [
        { ecosystem: "npm", name: "a", sessions: 2, shareBp: 4000 },
        { ecosystem: "npm", name: "b", sessions: 2, shareBp: 3500 },
      ],
    });
  });

  it("keeps the top packages only", () => {
    const sessions = [[share("a", 5000), share("b", 3000), share("c", 2000)], [share("a", 5000), share("b", 3000), share("c", 2000)]];
    expect(aggregateUsage(sessions, { minSessions: 1, top: 2 }).packages.map((p) => p.name)).toEqual(["a", "b"]);
  });
});

describe("indexRows", () => {
  it("sets each package's share of agent work against its share of what Upstream has set aside", async () => {
    const w = await settlementWorld();
    const f = await w.funder(1000);
    await w.receipt(f, { a: 3000, z: 7000 });
    w.lookups["npm:z"] = { source: "funding", recipients: [{ login: "carol", githubId: 103, shareBp: 10_000 }] };
    await runSettlement(w.deps);
    const usage: UsageIndex = {
      generatedAt: "2026-10-14",
      sessions: 120,
      packages: [
        { ecosystem: "npm", name: "a", sessions: 80, shareBp: 2500 },
        { ecosystem: "npm", name: "b", sessions: 50, shareBp: 1500 },
      ],
    };
    expect(await indexRows(w.db, usage)).toEqual({
      sessions: 120,
      generatedAt: "2026-10-14",
      fundedCents: 1000,
      rows: [
        { ecosystem: "npm", name: "a", sessions: 80, usageBp: 2500, fundedCents: 300, fundingBp: 3000 },
        { ecosystem: "npm", name: "b", sessions: 50, usageBp: 1500, fundedCents: 0, fundingBp: 0 },
      ],
    });
  });
});
