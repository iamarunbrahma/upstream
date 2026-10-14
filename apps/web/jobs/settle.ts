// The settlement job, for a scheduled run (Render cron) against Postgres. With PGlite, use POST /api/settle
// instead: only one process may open a PGlite database, and the dev server already has it.
import { getDeps } from "../lib/deps";
import { describeRun, runSettlement, settlementDeps } from "../lib/funding/run";
import { createGithubGet } from "../lib/resolver/recipients";

const deps = await getDeps();
if (!deps.paypal) {
  console.error("PayPal isn't set up (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET), so nothing can be paid out.");
  process.exit(1);
}
const report = await runSettlement(settlementDeps({ ...deps, paypal: deps.paypal }, createGithubGet(process.env.GITHUB_TOKEN)));
for (const line of describeRun(report)) console.log(line);
process.exit(0);
