import { finishAgentPayment } from "../../../../../lib/funding/agent-payments";
import { withAgentPayments } from "../../../../../lib/funding/route";
import { json } from "../../../../../lib/http";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return withAgentPayments(req, async (deps, accountId) => {
    const { id } = await ctx.params;
    return json(await finishAgentPayment(deps, accountId, id));
  });
}
