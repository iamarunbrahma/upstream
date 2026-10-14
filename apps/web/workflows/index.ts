// Upstream's Render Workflows service: registers its three tasks, and Render's task server runs them.
// Start command: `pnpm --filter web workflows`. The web app and the cron jobs start runs with RENDER_API_KEY.
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { getDeps } from "../lib/deps";
import type { SettleOptions } from "../lib/funding/settle";
import { payoutsHere, settleHere } from "../lib/jobs/run";
import { judgeReceipt } from "../lib/judge/judge";
import type { JudgeRow } from "../lib/judge/types";

/** The AI judge for one receipt. It retries and falls back by itself, so Render retries only crashes. */
task({ name: "judge", timeoutSeconds: 120, retry: { maxRetries: 1, waitDurationMs: 2000, backoffScaling: 2 } }, async (_ctx: TaskContext, title: string | null, rows: JudgeRow[]) =>
  judgeReceipt(title, rows, (await getDeps()).model),
);

/** A settlement: everyone (the monthly cron) or one funder (the demo's Settle now). Safe to retry: nothing is spent twice. */
task({ name: "settle", timeoutSeconds: 900, retry: { maxRetries: 2, waitDurationMs: 30_000, backoffScaling: 2 } }, async (_ctx: TaskContext, opts: SettleOptions = {}) =>
  settleHere(await getDeps(), opts),
);

/** The daily payout check: catch up on statuses with PayPal, then send waiting payouts. */
task({ name: "payouts", timeoutSeconds: 900, retry: { maxRetries: 2, waitDurationMs: 30_000, backoffScaling: 2 } }, async () => payoutsHere(await getDeps()));
