import { z } from "zod";
import { startAgentPayment } from "../../../../lib/funding/agent-payments";
import { withAgentPayments } from "../../../../lib/funding/route";
import { json } from "../../../../lib/http";
import { publicOrigin } from "../../../../lib/maintainers/http";
import { PayPalError } from "../../../../lib/paypal/client";

export const runtime = "nodejs";

const Body = z.object({ cents: z.number() });

export async function POST(req: Request): Promise<Response> {
  return withAgentPayments(req, async (deps, accountId) => {
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) return json({ error: "Say how much to add, in cents" }, 400);
    const origin = publicOrigin(req);
    try {
      return json(await startAgentPayment(deps, accountId, body.data.cents, { returnUrl: `${origin}/agent/paid`, cancelUrl: `${origin}/api/agent/cancelled` }));
    } catch (e) {
      if (e instanceof PayPalError) return json({ error: "PayPal couldn't start the payment. Try again in a minute." }, 502);
      throw e;
    }
  });
}
