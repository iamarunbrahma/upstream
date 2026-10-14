// The settlement job, for a scheduled run (Render cron) against Postgres. With PGlite, use POST /api/settle
// instead: only one process may open a PGlite database, and the dev server already has it.
// Monthly: `pnpm --filter web settle`. Daily: `pnpm --filter web settle --payouts-only` checks and sends payouts.
// With Render Workflows set up (RENDER_API_KEY, RENDER_WORKFLOW_SLUG), each run is a workflow task with its own retries and history.
import { getDeps } from "../lib/deps";
import { describeRun } from "../lib/funding/run";
import { payoutsJob, settleJob } from "../lib/jobs/run";

const deps = await getDeps();
if (!deps.paypal) {
  console.error("PayPal isn't set up (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET), so nothing can be paid out.");
  process.exit(1);
}
const report = process.argv.includes("--payouts-only") ? await payoutsJob(deps) : await settleJob(deps);
for (const line of describeRun(report)) console.log(line);
process.exit(0);
