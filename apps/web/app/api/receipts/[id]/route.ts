import { z } from "zod";
import { json, withAccount } from "../../../../lib/http";
import { getReceipt } from "../../../../lib/receipts/service";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return withAccount(req, async (deps, accountId) => {
    if (!z.uuid().safeParse(id).success) return json({ error: "not found" }, 404);
    const receipt = await getReceipt(deps, accountId, id);
    return receipt ? json({ receipt }) : json({ error: "not found" }, 404);
  });
}
