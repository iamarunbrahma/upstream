import { balanceCents } from "../../../../../lib/funding/ledger";
import { withFunding } from "../../../../../lib/funding/route";
import { completeTopup } from "../../../../../lib/funding/topups";
import { json } from "../../../../../lib/http";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return withFunding(req, async (deps, accountId) => {
    const credited = await completeTopup(deps, accountId, id);
    return json({ credited, balanceCents: await balanceCents(deps.db, accountId) });
  });
}
