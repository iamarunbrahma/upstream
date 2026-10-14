import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals, maintainers, payoutItems, receiptItems } from "../db/schema";
import { FIRST_PAYOUT_HOLD_MS, holdWords } from "../funding/payouts";

export interface MaintainerSummary {
  login: string;
  /** firstPayoutFrom: the day the hold after linking PayPal ends (YYYY-MM-DD, UTC). wait: that hold, in words. */
  paypal: { linked: boolean; firstPayoutFrom: string | null; wait: string };
  /** waiting: set aside, not on a payout yet. onItsWay: on a payout PayPal hasn't confirmed. paid: confirmed. */
  cents: { waiting: number; onItsWay: number; paid: number };
  months: Array<{ month: string; setAsideCents: number }>;
  payouts: Array<{ date: string; cents: number; status: string }>;
  /** How agents used each package, counted over every receipt that names it (no funder is identified). */
  packages: Array<{ ecosystem: "npm" | "pypi"; name: string; cents: number; roles: Record<string, number> }>;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * What a maintainer is owed and has been paid: only money and payouts of their own GitHub account, whatever
 * login they were filed under. Nothing is matched by login, since a login can change hands. Money given back is left out.
 */
export async function maintainerSummary(db: Db, who: { login: string; githubId: number }, holdMs = FIRST_PAYOUT_HOLD_MS): Promise<MaintainerSummary> {
  const { login, githubId } = who;
  const [me] = await db.select({ payerId: maintainers.paypalPayerId, claimedAt: maintainers.claimedAt }).from(maintainers).where(eq(maintainers.githubId, githubId)).limit(1);
  const mine = and(eq(accruals.githubId, githubId), ne(accruals.status, "returned"));

  const byStatus = await db
    .select({ status: accruals.status, cents: sql<string>`sum(${accruals.cents})` })
    .from(accruals)
    .where(mine)
    .groupBy(accruals.status);
  const total = (s: string) => Number(byStatus.find((r) => r.status === s)?.cents ?? 0);

  const month = sql<string>`to_char(${accruals.createdAt} at time zone 'UTC', 'YYYY-MM')`;
  const months = await db
    .select({ month, cents: sql<string>`sum(${accruals.cents})` })
    .from(accruals)
    .where(mine)
    .groupBy(month)
    .orderBy(desc(month));

  const payouts = await db
    .select({ at: payoutItems.updatedAt, cents: payoutItems.cents, status: payoutItems.status })
    .from(payoutItems)
    .where(eq(payoutItems.githubId, githubId))
    .orderBy(desc(payoutItems.updatedAt))
    .limit(12);

  const pkgCents = sql<string>`sum(${accruals.cents})`;
  const pkgs = await db
    .select({ ecosystem: accruals.ecosystem, name: accruals.name, cents: pkgCents })
    .from(accruals)
    .where(mine)
    .groupBy(accruals.ecosystem, accruals.name)
    .orderBy(desc(pkgCents), accruals.name);
  const roles =
    pkgs.length === 0
      ? []
      : await db
          .select({ ecosystem: receiptItems.ecosystem, name: receiptItems.name, role: receiptItems.role, n: sql<string>`count(*)` })
          .from(receiptItems)
          .where(inArray(receiptItems.name, pkgs.map((p) => p.name)))
          .groupBy(receiptItems.ecosystem, receiptItems.name, receiptItems.role);

  return {
    login,
    paypal: {
      linked: Boolean(me?.payerId),
      firstPayoutFrom: me?.payerId && me.claimedAt ? day(new Date(me.claimedAt.getTime() + holdMs)) : null,
      wait: holdWords(holdMs),
    },
    cents: { waiting: total("held"), onItsWay: total("queued"), paid: total("paid") },
    months: months.map((m) => ({ month: m.month, setAsideCents: Number(m.cents) })),
    payouts: payouts.map((p) => ({ date: day(p.at), cents: p.cents, status: p.status })),
    packages: pkgs.map((p) => ({
      ecosystem: p.ecosystem,
      name: p.name,
      cents: Number(p.cents),
      roles: Object.fromEntries(roles.filter((r) => r.ecosystem === p.ecosystem && r.name === p.name).map((r) => [r.role, Number(r.n)])),
    })),
  };
}
