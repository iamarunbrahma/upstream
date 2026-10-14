import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { subscriptions } from "../db/schema";
import type { PayPalApi, PaypalSubscriptionTxn } from "../paypal/api";
import { PayPalError } from "../paypal/client";
import type { TierKey } from "../paypal/plans";
import { netCents, recordFunding } from "./ledger";

export interface FundingDeps {
  db: Db;
  paypal: PayPalApi;
  planIds: Partial<Record<TierKey, string>>;
  now?: () => Date;
}

export class FundingError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function startSubscription(deps: FundingDeps, accountId: string, tier: TierKey): Promise<string> {
  const planId = deps.planIds[tier];
  if (!planId) throw new FundingError(503, "Subscriptions aren't set up on this server yet");
  const sub = await deps.paypal.createSubscription(planId, accountId);
  await deps.db.insert(subscriptions).values({ id: sub.id, accountId, tier, status: sub.status }).onConflictDoNothing();
  return sub.id;
}

/**
 * Brings one subscription up to date from PayPal: its status, its payer, and every completed payment so far.
 * Safe to run any number of times, even concurrently. Returns null when the subscription isn't ours, or isn't
 * `onlyFor`'s, and then credits nothing.
 */
export async function reconcileSubscription(
  deps: FundingDeps,
  subscriptionId: string,
  onlyFor?: string,
): Promise<{ accountId: string; credited: number; status: string } | null> {
  const [row] = await deps.db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).limit(1);
  if (!row || (onlyFor !== undefined && row.accountId !== onlyFor)) return null;
  const sub = await deps.paypal.getSubscription(subscriptionId);
  if (sub.custom_id !== row.accountId) return null;
  const now = deps.now?.() ?? new Date();
  const payerId = sub.subscriber?.payer_id ?? row.payerId;
  await deps.db.update(subscriptions).set({ status: sub.status, payerId, updatedAt: now }).where(eq(subscriptions.id, subscriptionId));

  const started = Math.min(row.createdAt.getTime(), Date.parse(sub.start_time ?? "") || Number.POSITIVE_INFINITY);
  const from = new Date(started - 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(now.getTime() + 60 * 1000).toISOString();
  // PayPal 404s the transaction list until the buyer has approved and billing has started.
  let txns: PaypalSubscriptionTxn[] = [];
  if (sub.status !== "APPROVAL_PENDING" && sub.status !== "APPROVED") {
    try {
      txns = await deps.paypal.listSubscriptionTransactions(subscriptionId, from, to);
    } catch (e) {
      if (!(e instanceof PayPalError && e.status === 404)) throw e;
    }
  }
  let credited = 0;
  for (const t of txns) {
    if (t.status !== "COMPLETED") continue;
    const cents = netCents(t.amount_with_breakdown?.net_amount, t.amount_with_breakdown?.gross_amount);
    const fresh = await recordFunding(deps.db, {
      accountId: row.accountId,
      source: "subscription",
      paypalId: t.id,
      amountCents: cents,
      payerId: payerId ?? null,
      occurredAt: t.time ? new Date(t.time) : now,
      raw: t,
    });
    if (fresh) credited += cents;
  }
  return { accountId: row.accountId, credited, status: sub.status };
}
