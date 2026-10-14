import { getDeps } from "../../../../lib/deps";
import { firstPayoutHoldMs } from "../../../../lib/funding/payouts";
import { json } from "../../../../lib/http";
import { signedInMaintainer } from "../../../../lib/maintainers/http";
import { maintainerSummary } from "../../../../lib/maintainers/summary";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const deps = await getDeps();
  const me = await signedInMaintainer(req, deps.db);
  if (!me) return json({ error: "not signed in" }, 401);
  return json(await maintainerSummary(deps.db, me, firstPayoutHoldMs(process.env.FIRST_PAYOUT_HOLD_HOURS, process.env.PAYPAL_API_BASE)));
}
