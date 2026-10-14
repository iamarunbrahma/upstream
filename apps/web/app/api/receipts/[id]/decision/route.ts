import { z } from "zod";
import { json, withAccount } from "../../../../../lib/http";
import { decideReceipt } from "../../../../../lib/receipts/service";

export const runtime = "nodejs";

const Body = z.object({ action: z.enum(["approve", "skip"]) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return withAccount(req, async (deps, accountId) => {
    if (!z.uuid().safeParse(id).success) return json({ error: "not found" }, 404);
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) return json({ error: "action must be approve or skip" }, 400);
    const receipt = await decideReceipt(deps, accountId, id, body.data.action);
    return receipt ? json({ receipt }) : json({ error: "not found" }, 404);
  });
}
