import { z } from "zod";
import { setAutoApprove } from "../../../lib/funding/settings";
import { json, withAccount } from "../../../lib/http";

export const runtime = "nodejs";

const Body = z.object({ autoApprove: z.boolean() });

export async function PATCH(req: Request): Promise<Response> {
  return withAccount(req, async (deps, accountId) => {
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) return json({ error: "autoApprove must be true or false" }, 400);
    return json(await setAutoApprove(deps.db, accountId, body.data.autoApprove));
  });
}
