import { getDeps } from "../../../../lib/deps";
import { cancelAgentPayment } from "../../../../lib/funding/agent-payments";
import { publicOrigin } from "../../../../lib/maintainers/http";

export const runtime = "nodejs";

/** PayPal sends the developer here after Cancel, with the order id as `token`. Cancel it, then show the page. */
export async function GET(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token");
  const deps = await getDeps();
  if (token && deps.agentOrders) {
    await cancelAgentPayment({ db: deps.db, orders: deps.agentOrders }, token).catch(() => false);
  }
  return Response.redirect(`${publicOrigin(req)}/agent/paid?cancelled=1`, 303);
}
