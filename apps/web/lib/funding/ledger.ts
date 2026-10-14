import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals, fundingEvents } from "../db/schema";
import type { Money } from "../paypal/api";
import { toCents } from "../paypal/money";

export interface FundingInput {
  accountId: string;
  source: "subscription" | "topup";
  /** PayPal's sale id (subscriptions) or capture id (top-ups): the idempotency key. */
  paypalId: string;
  amountCents: number;
  payerId: string | null;
  occurredAt: Date;
  raw: unknown;
}

/** Records money in. Recording the same PayPal payment again is a no-op that returns false. */
export async function recordFunding(db: Db, f: FundingInput): Promise<boolean> {
  if (!Number.isInteger(f.amountCents) || f.amountCents <= 0) return false;
  const rows = await db
    .insert(fundingEvents)
    .values({ ...f, raw: (f.raw ?? null) as object })
    .onConflictDoNothing({ target: fundingEvents.paypalId })
    .returning({ id: fundingEvents.paypalId });
  return rows.length > 0;
}

/** Money put in, less refunds and reversals (which are stored as negative amounts). */
export async function fundedCents(db: Db, accountId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${fundingEvents.amountCents}), 0)` })
    .from(fundingEvents)
    .where(eq(fundingEvents.accountId, accountId));
  return Number(row?.total ?? 0);
}

/** What settlements set aside from this funder for maintainers, paid or not yet. Returned money doesn't count. */
export async function givenCents(db: Db, accountId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${accruals.cents}), 0)` })
    .from(accruals)
    .where(and(eq(accruals.funderId, accountId), ne(accruals.status, "returned")));
  return Number(row?.total ?? 0);
}

/** What the funder can still give: money put in, less what settlements set aside. */
export async function balanceCents(db: Db, accountId: string): Promise<number> {
  return (await fundedCents(db, accountId)) - (await givenCents(db, accountId));
}

/** A PayPal amount in cents, preferring the net amount after PayPal's fee. Anything that isn't USD counts as 0. */
export function netCents(net?: Money, gross?: Money): number {
  const m = net ?? gross;
  if (!m || m.currency_code !== "USD") return 0;
  return toCents(m.value);
}
