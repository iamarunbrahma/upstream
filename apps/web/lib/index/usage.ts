import type { Ecosystem } from "@upstream/core";
import { ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals } from "../db/schema";

/** How much of the agents' work one package did, over real Claude Code sessions. */
export interface UsageEntry {
  ecosystem: Ecosystem;
  name: string;
  /** Sessions that used the package. */
  sessions: number;
  /** Its average share of a session's work, in basis points, over every session counted. */
  shareBp: number;
}

/** `lib/index/usage.json`, written by `pnpm --filter web usage-index --write`. */
export interface UsageIndex {
  generatedAt: string;
  /** Sessions that used at least one package. */
  sessions: number;
  packages: UsageEntry[];
}

/**
 * Each package's average share of the work over every session that used any package, from each session's
 * evidence-based shares. Packages seen in fewer than `minSessions` sessions are left out. Largest first.
 */
export function aggregateUsage(
  sessions: Array<Array<{ ecosystem: Ecosystem; name: string; weightBp: number }>>,
  opts: { minSessions: number; top: number },
): Omit<UsageIndex, "generatedAt"> {
  const counted = sessions.filter((s) => s.length > 0);
  const totals = new Map<string, { ecosystem: Ecosystem; name: string; sessions: number; bp: number }>();
  for (const s of counted) {
    for (const p of s) {
      const key = `${p.ecosystem}:${p.name}`;
      const t = totals.get(key) ?? { ecosystem: p.ecosystem, name: p.name, sessions: 0, bp: 0 };
      t.sessions += 1;
      t.bp += p.weightBp;
      totals.set(key, t);
    }
  }
  const packages = [...totals.values()]
    .filter((t) => t.sessions >= opts.minSessions)
    .map((t) => ({ ecosystem: t.ecosystem, name: t.name, sessions: t.sessions, shareBp: Math.round(t.bp / counted.length) }))
    .sort((a, b) => b.shareBp - a.shareBp || a.name.localeCompare(b.name))
    .slice(0, opts.top);
  return { sessions: counted.length, packages };
}

export interface IndexRow extends Omit<UsageEntry, "shareBp"> {
  usageBp: number;
  /** What Upstream has set aside for the package's maintainers so far, and its share of everything set aside. */
  fundedCents: number;
  fundingBp: number;
}

/** The "Agent Usage vs Funding" chart: the top packages by agent work, each with what Upstream has set aside for it. */
export async function indexRows(db: Db, usage: UsageIndex, top = 15): Promise<{ sessions: number; generatedAt: string; fundedCents: number; rows: IndexRow[] }> {
  const funded = await db
    .select({ ecosystem: accruals.ecosystem, name: accruals.name, cents: sql<string>`sum(${accruals.cents})` })
    .from(accruals)
    .where(ne(accruals.status, "returned"))
    .groupBy(accruals.ecosystem, accruals.name);
  const byKey = new Map(funded.map((f) => [`${f.ecosystem}:${f.name}`, Number(f.cents)]));
  const total = [...byKey.values()].reduce((a, b) => a + b, 0);
  const rows = usage.packages.slice(0, top).map((p) => {
    const cents = byKey.get(`${p.ecosystem}:${p.name}`) ?? 0;
    return { ecosystem: p.ecosystem, name: p.name, sessions: p.sessions, usageBp: p.shareBp, fundedCents: cents, fundingBp: total > 0 ? Math.round((cents * 10_000) / total) : 0 };
  });
  return { sessions: usage.sessions, generatedAt: usage.generatedAt, fundedCents: total, rows };
}
