import type { PayPalApi } from "../paypal/api";
import { formatUsd } from "../format";
import type { Deps } from "../receipts/service";
import { lookupPackage } from "../resolver/cache";
import { recipientsFor, type GithubGet } from "../resolver/recipients";
import { reconcilePayouts } from "./payout-status";
import { payOut, type PayoutDeps, type SendResult } from "./payouts";
import { settle, type SettleDeps, type SettleSummary } from "./settle";

export type RunDeps = SettleDeps & PayoutDeps;

export interface PayoutRunReport {
  reconciledLines: number;
  /** Sent batches PayPal couldn't be asked about this time; they're checked on the next run. */
  uncheckedBatches: number;
  sent: SendResult[];
}

export interface RunReport extends SettleSummary, PayoutRunReport {}

/** Settlement deps from the app's: Plan 1's cached registry lookup for repos, and cached GitHub lookups for people. */
export function settlementDeps(deps: Deps & { paypal: PayPalApi }, gh: GithubGet, now?: () => Date): RunDeps {
  const clock = () => now?.() ?? new Date();
  return {
    db: deps.db,
    paypal: deps.paypal,
    now: clock,
    repoFor: async (ecosystem, name) => {
      const pkg = await lookupPackage(deps.db, ecosystem, name, deps.http, clock());
      return pkg === "later" ? "later" : pkg.repo;
    },
    recipients: (repo) => recipientsFor(deps.db, gh, repo, clock()),
  };
}

/** Catch up on payout statuses and send waiting payouts, without settling: for a daily schedule. */
export async function runPayouts(deps: RunDeps): Promise<PayoutRunReport> {
  const checked = await reconcilePayouts(deps);
  return { reconciledLines: checked.updated, uncheckedBatches: checked.unreachable, sent: await payOut(deps) };
}

/** The whole job: catch up on payout statuses with PayPal, settle, then send payouts. */
export async function runSettlement(deps: RunDeps): Promise<RunReport> {
  const checked = await reconcilePayouts(deps);
  const summary = await settle(deps);
  return { ...summary, reconciledLines: checked.updated, uncheckedBatches: checked.unreachable, sent: await payOut(deps) };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a run did, in plain words, for the job's log and the "Settle now" button. */
export function describeRun(run: RunReport | PayoutRunReport): string[] {
  const settled = "settledFunders" in run;
  const r: RunReport = settled
    ? run
    : { ...run, settlementId: "", expiredReceipts: 0, settledFunders: 0, waitingFunders: 0, setAsideCents: 0, returnedCents: 0, payoutLines: 0, queuedCents: 0 };
  const out: string[] = [];
  if (r.uncheckedBatches > 0) {
    out.push(`Couldn't reach PayPal to check ${plural(r.uncheckedBatches, "payout batch", "payout batches")}. ${r.uncheckedBatches === 1 ? "It" : "They"} will be checked on the next run.`);
  }
  if (r.reconciledLines > 0) out.push(`Checked ${plural(r.reconciledLines, "payout line", "payout lines")} with PayPal.`);
  const before = out.length;
  if (r.expiredReceipts > 0) out.push(`Dropped ${plural(r.expiredReceipts, "receipt", "receipts")} nobody approved within 14 days.`);
  if (r.settledFunders > 0) {
    out.push(`Settled ${plural(r.settledFunders, "developer's budget", "developers' budgets")}: ${formatUsd(r.setAsideCents)} set aside for open-source maintainers.`);
  }
  if (r.waitingFunders > 0) {
    out.push(`${plural(r.waitingFunders, "developer", "developers")} will be settled on a later run (GitHub was busy, or the budget is empty).`);
  }
  if (r.returnedCents > 0) {
    out.push(`Gave ${formatUsd(r.returnedCents)} back to developers' budgets (unclaimed for 90 days, refunded, or it would have paid the developer themselves).`);
  }
  if (r.payoutLines > 0) out.push(`Put ${formatUsd(r.queuedCents)} on ${plural(r.payoutLines, "payout line", "payout lines")}.`);
  for (const s of r.sent) {
    if (s.outcome === "sent") out.push("PayPal took the payout batch.");
    else if (s.outcome === "sent-before") out.push("PayPal already had a payout batch from an earlier try. Its updates will fill in the details.");
    else if (s.outcome === "needs-check") {
      out.push(
        `Payout batch ${s.settlementId} may already have gone out, and it's too old to send again safely. Look for it in PayPal, then run \`pnpm --filter web resolve-payout-check ${s.settlementId} resend\` if it isn't there, or \`... give-back\` to return the money to the developers.`,
      );
    }
    else out.push(`PayPal couldn't take a payout batch (${s.error}). It will be sent on the next run.`);
  }
  if (out.length === before) out.push(settled ? "Nothing new to settle." : "Nothing new to pay out.");
  return out;
}
