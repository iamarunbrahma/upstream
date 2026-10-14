import type { Ecosystem } from "@upstream/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals, maintainers, receiptItems, receipts } from "../db/schema";
import { balanceCents } from "./ledger";
import { splitCents } from "./split";

export interface ProjectedShare {
  ecosystem: Ecosystem;
  name: string;
  cents: number;
}

/**
 * What settling today would set aside per package: the whole budget, split by the summed weights of the approved
 * receipts not settled yet, in the same order and rounding as the settlement. Largest first.
 */
export async function projectSplit(db: Db, accountId: string): Promise<ProjectedShare[]> {
  const budget = await balanceCents(db, accountId);
  if (budget <= 0) return [];
  const rows = await db
    .select({ ecosystem: receiptItems.ecosystem, name: receiptItems.name, bp: sql<string>`sum(${receiptItems.weightBp})` })
    .from(receiptItems)
    .innerJoin(receipts, eq(receipts.id, receiptItems.receiptId))
    .where(and(eq(receipts.accountId, accountId), eq(receipts.status, "approved"), isNull(receipts.settlementId)))
    .groupBy(receiptItems.ecosystem, receiptItems.name);
  const pkgs = rows.map((r) => ({ ecosystem: r.ecosystem, name: r.name, bp: Number(r.bp) }));
  pkgs.sort((a, b) => `${a.ecosystem}:${a.name}`.localeCompare(`${b.ecosystem}:${b.name}`));
  const cents = splitCents(budget, pkgs.map((p) => p.bp));
  return pkgs
    .map((p, i) => ({ ecosystem: p.ecosystem, name: p.name, cents: cents[i]! }))
    .filter((p) => p.cents > 0)
    .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
}

/**
 * waiting: the maintainer hasn't linked PayPal yet. held: they have, and it goes out on a coming payout.
 * on-its-way: on a payout PayPal hasn't confirmed. paid: PayPal confirmed it. returned: back in the budget.
 */
export type GivenState = "waiting" | "held" | "on-its-way" | "paid" | "returned";

export interface GivenLine {
  login: string;
  ecosystem: Ecosystem;
  name: string;
  cents: number;
  state: GivenState;
}

/** Where this funder's money went, per maintainer and package. Largest first. */
export async function givenLines(db: Db, accountId: string): Promise<GivenLine[]> {
  const rows = await db
    .select({
      login: accruals.login,
      ecosystem: accruals.ecosystem,
      name: accruals.name,
      status: accruals.status,
      // Matched by GitHub account only, like every payout: a login can change hands.
      linked: sql<boolean>`bool_or(${maintainers.paypalPayerId} is not null)`,
      cents: sql<string>`sum(${accruals.cents})`,
    })
    .from(accruals)
    .leftJoin(maintainers, sql`${accruals.githubId} is not null and ${maintainers.githubId} = ${accruals.githubId}`)
    .where(eq(accruals.funderId, accountId))
    .groupBy(accruals.login, accruals.ecosystem, accruals.name, accruals.status);
  const stateOf = (status: string, linked: boolean): GivenState =>
    status === "held" ? (linked ? "held" : "waiting") : status === "queued" ? "on-its-way" : (status as GivenState);
  const merged = new Map<string, GivenLine>();
  for (const r of rows) {
    const state = stateOf(r.status, Boolean(r.linked));
    const key = `${r.login}|${r.ecosystem}|${r.name}|${state}`;
    const line = merged.get(key) ?? { login: r.login, ecosystem: r.ecosystem, name: r.name, cents: 0, state };
    line.cents += Number(r.cents);
    merged.set(key, line);
  }
  return [...merged.values()].sort((a, b) => b.cents - a.cents || a.login.localeCompare(b.login) || a.name.localeCompare(b.name));
}
