import { balanceCents } from "../../../../../lib/funding/ledger";
import { withFunding } from "../../../../../lib/funding/route";
import { reconcileSubscription } from "../../../../../lib/funding/subscriptions";
import { json } from "../../../../../lib/http";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return withFunding(req, async (deps, accountId) => {
    const result = await reconcileSubscription(deps, id, accountId);
    if (!result) return json({ error: "subscription not found" }, 404);
    return json({ status: result.status, credited: result.credited, balanceCents: await balanceCents(deps.db, accountId) });
  });
}
