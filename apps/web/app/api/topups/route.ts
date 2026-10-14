import { z } from "zod";
import { withFunding } from "../../../lib/funding/route";
import { startTopup } from "../../../lib/funding/topups";
import { json } from "../../../lib/http";

export const runtime = "nodejs";

const Body = z.object({ cents: z.number() });

export async function POST(req: Request): Promise<Response> {
  return withFunding(req, async (deps, accountId) => {
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) return json({ error: "Say how much to add, in cents" }, 400);
    return json({ orderId: await startTopup(deps, accountId, body.data.cents) });
  });
}
