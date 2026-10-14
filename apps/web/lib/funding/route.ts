import { json, withAccount } from "../http";
import { PayPalError } from "../paypal/client";
import type { AgentPaymentDeps } from "./agent-payments";
import { FundingError, type FundingDeps } from "./subscriptions";

/** withAccount for money routes: needs PayPal configured, and turns failures into clear answers. */
export async function withFunding(req: Request, fn: (deps: FundingDeps, accountId: string) => Promise<Response>): Promise<Response> {
  return withAccount(req, async (deps, accountId) => {
    if (!deps.paypal) return json({ error: "Payments aren't set up on this server yet" }, 503);
    try {
      return await fn({ db: deps.db, paypal: deps.paypal, planIds: deps.planIds ?? {} }, accountId);
    } catch (e) {
      if (e instanceof FundingError) return json({ error: e.message }, e.status);
      if (e instanceof PayPalError) return json({ error: "PayPal couldn't complete that. Please try again.", code: e.code }, 502);
      throw e;
    }
  });
}

/** withAccount for payments the agent starts: needs the Agent Toolkit, shares the per-account request limit. */
export async function withAgentPayments(req: Request, fn: (deps: AgentPaymentDeps, accountId: string) => Promise<Response>): Promise<Response> {
  return withAccount(req, async (deps, accountId) => {
    if (!deps.agentOrders) return json({ error: "Payments from the agent aren't set up on this server yet" }, 503);
    if (deps.submitLimiter && !deps.submitLimiter.take(accountId)) return json({ error: "Too many requests this hour. Try again later." }, 429);
    try {
      return await fn({ db: deps.db, orders: deps.agentOrders }, accountId);
    } catch (e) {
      if (e instanceof FundingError) return json({ error: e.message }, e.status);
      if (e instanceof PayPalError) return json({ error: "PayPal couldn't complete that. Try again in a minute." }, 502);
      throw e;
    }
  });
}
