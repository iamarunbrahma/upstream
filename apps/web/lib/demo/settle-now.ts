import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { receipts } from "../db/schema";
import { formatUsd } from "../format";
import { balanceCents } from "../funding/ledger";
import type { RunReport } from "../funding/run";

/** Why "Settle now" has nothing to do for this funder yet, in plain words; null when it can run. */
export async function settleNowBlocker(db: Db, accountId: string): Promise<string | null> {
  if ((await balanceCents(db, accountId)) <= 0) return "Add money to your budget first.";
  const [open] = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.accountId, accountId), eq(receipts.status, "approved"), isNull(receipts.settlementId)))
    .limit(1);
  return open ? null : "Approve a receipt first. Settling splits your budget across the receipts you approved.";
}

const maintainers = (n: number) => `${n} ${n === 1 ? "maintainer" : "maintainers"} who joined Upstream`;

/**
 * What "Settle now" did with this visitor's own budget, in plain words. The rest of the run (payout checks, money
 * returned to other developers, other batches) belongs to the server and other funders, so it isn't described.
 */
export function describeSettleNow(run: RunReport): string[] {
  if (run.settledFunders === 0) {
    return [
      run.waitingFunders > 0
        ? "GitHub or a package registry is busy, so your budget wasn't settled yet. Please press Settle now again in a minute."
        : "Nothing new to settle.",
    ];
  }
  if (run.setAsideCents === 0) return ["None of these packages has a maintainer Upstream can pay yet, so your budget stays as it is."];
  const out = [`Set aside ${formatUsd(run.setAsideCents)} of your budget for open-source maintainers.`];
  if (run.payoutLines > 0) {
    const mine = run.sent.find((s) => s.settlementId === run.settlementId);
    out.push(
      mine && mine.outcome !== "failed"
        ? `${formatUsd(run.queuedCents)} of it is on its way through PayPal Payouts to ${maintainers(run.payoutLines)}.`
        : `${formatUsd(run.queuedCents)} of it is ready for ${maintainers(run.payoutLines)}, but PayPal couldn't take the payout right now. It goes out on the next run.`,
    );
  }
  return out;
}
