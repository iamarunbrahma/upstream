// Render budget guard, run every 3 hours by .github/workflows/render-guard.yml with the RENDER_API_KEY secret.
// It suspends Upstream's web service, crons and database once judging is over, once this month's bandwidth hits
// the cap, or if anything is moved to a pricier plan, so the bill stays inside the hackathon credit.
// It exits 1 when it suspends something or can't check, so GitHub emails the repo owner.
//   pnpm --filter web render-guard      (GUARD_END_DATE=YYYY-MM-DD and GUARD_BANDWIDTH_CAP_GB=30 tune it)
import { createRenderApi, guardConfigFromEnv, runGuard } from "../lib/ops/render-guard";

const key = process.env.RENDER_API_KEY;
if (!key) {
  console.log("No RENDER_API_KEY is set, so there's nothing to guard yet.");
  process.exit(0);
}
const cfg = guardConfigFromEnv(process.env);
const out = await runGuard(createRenderApi(key), cfg);
console.log(`This month's bandwidth: ${out.bandwidthGb.toFixed(2)} GB of the ${cfg.bandwidthCapGb} GB cap. Last day to run: ${cfg.endDate}.`);
if (!out.suspend) {
  console.log("Everything is inside the limits.");
  process.exit(0);
}
for (const reason of out.reasons) console.log(reason);
if (out.suspended.length === 0) {
  console.log("Everything was already suspended.");
  process.exit(0);
}
console.log(`Suspended: ${out.suspended.join(", ")}. Resume them in the Render dashboard if this was a mistake.`);
process.exit(1);
