import { describe, expect, it } from "vitest";
import { groupGiven } from "../lib/funding/given-groups";
import type { GivenLine } from "../lib/funding/view";

const line = (login: string, name: string, cents: number, state: GivenLine["state"]): GivenLine => ({ login, ecosystem: "npm", name, cents, state });

describe("groupGiven", () => {
  it("groups by package, counts each person once and only confirmed payouts as paid, and leaves returned money out", () => {
    const g = groupGiven([
      line("carol", "zod", 200, "waiting"),
      line("arun", "upstream-pay", 100, "paid"),
      line("arun", "upstream-pay", 50, "on-its-way"),
      line("carol", "zod", 70, "returned"),
      line("bob", "zod", 30, "held"),
    ]);
    expect(g.groups.map((p) => ({ name: p.name, cents: p.cents, logins: p.logins, paid: p.paid, onItsWay: p.onItsWay }))).toEqual([
      { name: "zod", cents: 230, logins: ["carol", "bob"], paid: 0, onItsWay: 0 },
      { name: "upstream-pay", cents: 150, logins: ["arun"], paid: 1, onItsWay: 1 },
    ]);
    expect(g).toMatchObject({ people: 3, packages: 2, waitingCents: 200, totalCents: 380 });
  });

  it("treats money on its way as not paid yet", () => {
    const g = groupGiven([line("arun", "upstream-pay", 40, "on-its-way")]);
    expect(g.groups[0]).toMatchObject({ paid: 0, onItsWay: 1, logins: ["arun"] });
  });
});
