import { getDeps } from "../../../../lib/deps";
import { handleWebhook } from "../../../../lib/funding/webhooks";
import { json } from "../../../../lib/http";

export const runtime = "nodejs";

/** PayPal calls this; it is not user-authenticated, so nothing happens without a verified signature. */
export async function POST(req: Request): Promise<Response> {
  const deps = await getDeps();
  if (!deps.paypal) return json({ error: "Payments aren't set up on this server yet" }, 503);
  const result = await handleWebhook(
    { db: deps.db, paypal: deps.paypal, planIds: deps.planIds ?? {}, webhookId: deps.webhookId ?? null },
    req.headers,
    await req.text(),
  );
  return json({ outcome: result.outcome }, result.status);
}
