import { demoEnabled, isDemoAccount } from "../../../../lib/demo/accounts";
import { describeSettleNow, settleNowBlocker } from "../../../../lib/demo/settle-now";
import { json, withAccount } from "../../../../lib/http";
import { settleJob } from "../../../../lib/jobs/run";

export const runtime = "nodejs";

/** "Settle now" on the sandbox demo: settles this demo account's budget only, then sends what's ready to PayPal. */
export async function POST(req: Request): Promise<Response> {
  if (!demoEnabled()) return json({ error: "not found" }, 404);
  return withAccount(req, async (deps, accountId) => {
    if (!(await isDemoAccount(deps.db, accountId))) return json({ error: "Settle now is only for demo accounts." }, 403);
    if (!deps.paypal) return json({ error: "Payments aren't set up on this server yet." }, 503);
    if (deps.demoSettleLimiter && !deps.demoSettleLimiter.take(accountId)) {
      return json({ error: "That's a lot of settling. Please wait a few minutes." }, 429);
    }
    const blocker = await settleNowBlocker(deps.db, accountId);
    if (blocker) return json({ error: blocker }, 409);
    const report = await settleJob(deps, { funderId: accountId });
    return json(describeSettleNow(report));
  });
}
