import type { Ecosystem } from "@upstream/core";
import type { GivenLine } from "./view";

export interface GivenGroup {
  ecosystem: Ecosystem;
  name: string;
  /** Set aside for this package's maintainers, leaving out what went back to the budget. */
  cents: number;
  /** Each GitHub account once, in the order they first appear. */
  logins: string[];
  /** Accounts PayPal has confirmed paying, and accounts with a payout PayPal hasn't confirmed yet. */
  paid: number;
  onItsWay: number;
  lines: GivenLine[];
}

/** "Where your money went", per package: for the dashboard, with no database access, so it runs in the browser. */
export function groupGiven(lines: GivenLine[]): { groups: GivenGroup[]; people: number; packages: number; waitingCents: number; totalCents: number } {
  const groups = new Map<string, GivenGroup>();
  for (const l of lines) {
    const key = `${l.ecosystem}:${l.name}`;
    const g = groups.get(key) ?? { ecosystem: l.ecosystem, name: l.name, cents: 0, logins: [], paid: 0, onItsWay: 0, lines: [] };
    g.lines.push(l);
    if (l.state !== "returned") g.cents += l.cents;
    if (!g.logins.includes(l.login)) g.logins.push(l.login);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    g.paid = new Set(g.lines.filter((l) => l.state === "paid").map((l) => l.login)).size;
    g.onItsWay = new Set(g.lines.filter((l) => l.state === "on-its-way").map((l) => l.login)).size;
  }
  const sorted = [...groups.values()].sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
  return {
    groups: sorted,
    people: new Set(lines.map((l) => l.login)).size,
    packages: sorted.length,
    waitingCents: lines.filter((l) => l.state === "waiting").reduce((sum, l) => sum + l.cents, 0),
    totalCents: sorted.reduce((sum, g) => sum + g.cents, 0),
  };
}
