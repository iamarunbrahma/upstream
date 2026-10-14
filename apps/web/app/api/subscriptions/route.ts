import { z } from "zod";
import { withFunding } from "../../../lib/funding/route";
import { startSubscription } from "../../../lib/funding/subscriptions";
import { json } from "../../../lib/http";
import { TIER_KEYS } from "../../../lib/paypal/plans";

export const runtime = "nodejs";

const Body = z.object({ tier: z.enum(TIER_KEYS) });

export async function POST(req: Request): Promise<Response> {
  return withFunding(req, async (deps, accountId) => {
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) return json({ error: "Pick a plan: starter, builder or team" }, 400);
    return json({ subscriptionId: await startSubscription(deps, accountId, body.data.tier) });
  });
}
