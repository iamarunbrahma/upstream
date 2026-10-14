import { judgeReceipt } from "../judge/judge";
import type { JudgeResult, JudgeRow } from "../judge/types";
import { runPayouts, runSettlement, settlementDeps, type PayoutRunReport, type RunReport } from "../funding/run";
import type { SettleOptions } from "../funding/settle";
import type { Deps } from "../receipts/service";
import { createGithubGet } from "../resolver/recipients";
import { runTask } from "./workflows";

/**
 * The AI judge: a Render Workflows task when workflows are set up (with Render's retries and run history), or this
 * process. A failed workflow run falls back to this process. With no model allowed (the demo's daily judge budget
 * is spent), nothing is sent anywhere and the receipt is estimated without AI.
 */
export async function judgeWith(deps: Deps, title: string | null, rows: JudgeRow[]): Promise<JudgeResult> {
  if (deps.model && deps.workflows) {
    try {
      return await runTask<JudgeResult>(deps.workflows.client, deps.workflows.slug, "judge", [title, rows]);
    } catch {
      // The workflow couldn't answer; judge here instead.
    }
  }
  return judgeReceipt(title, rows, deps.model);
}

/** The settlement in this process, as the "settle" workflow task and the no-workflows path both run it. */
export function settleHere(deps: Deps, opts: SettleOptions = {}): Promise<RunReport> {
  if (!deps.paypal) throw new Error("PayPal isn't set up (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET), so nothing can be paid out.");
  return runSettlement(settlementDeps({ ...deps, paypal: deps.paypal }, createGithubGet(process.env.GITHUB_TOKEN)), opts);
}

/** The payout check and send in this process, as the "payouts" workflow task and the no-workflows path both run it. */
export function payoutsHere(deps: Deps): Promise<PayoutRunReport> {
  if (!deps.paypal) throw new Error("PayPal isn't set up (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET), so nothing can be paid out.");
  return runPayouts(settlementDeps({ ...deps, paypal: deps.paypal }, createGithubGet(process.env.GITHUB_TOKEN)));
}

/** A settlement (everyone, or one funder): the "settle" workflow task when workflows are set up, or this process. */
export function settleJob(deps: Deps, opts: SettleOptions = {}): Promise<RunReport> {
  return deps.workflows ? runTask<RunReport>(deps.workflows.client, deps.workflows.slug, "settle", [opts]) : settleHere(deps, opts);
}

/** The daily payout check and send: the "payouts" workflow task when workflows are set up, or this process. */
export function payoutsJob(deps: Deps): Promise<PayoutRunReport> {
  return deps.workflows ? runTask<PayoutRunReport>(deps.workflows.client, deps.workflows.slug, "payouts", []) : payoutsHere(deps);
}
