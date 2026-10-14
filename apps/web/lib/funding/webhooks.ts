import { eq } from "drizzle-orm";
import { z } from "zod";
import { accounts, agentPayments, fundingEvents, webhookEvents } from "../db/schema";
import type { PaypalPayoutItem } from "../paypal/api";
import { PayPalError } from "../paypal/client";
import { refreshPayoutItem } from "./payout-status";
import { recordRefund, REFUND_EVENTS, REFUND_RETRY, REFUND_UNREADABLE } from "./refunds";
import { reconcileSubscription, type FundingDeps } from "./subscriptions";
import { creditCaptures } from "./topups";

const SIGNATURE_HEADERS = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];

const CaptureShape = z.object({
  id: z.string(),
  status: z.literal("COMPLETED"),
  custom_id: z.uuid(),
  supplementary_data: z.object({ related_ids: z.object({ order_id: z.string() }) }),
});

/** Captures of orders the developer's agent started carry no custom_id; agent_payments says whose they are. */
const AgentCaptureShape = z.object({
  id: z.string(),
  status: z.literal("COMPLETED"),
  supplementary_data: z.object({ related_ids: z.object({ order_id: z.string() }) }),
});

/** PayPal can announce a payment before it lists it. Answering non-2xx makes PayPal send the event again later. */
const NOT_LISTED = "payment not listed yet";

export interface WebhookResult {
  status: number;
  outcome: string;
}

type WebhookDeps = FundingDeps & { webhookId: string | null };

/**
 * Verifies a PayPal webhook, then brings our records up to date from PayPal. The work is idempotent and the
 * event id is stored only after it succeeds, so PayPal's retries after a failure run again, and replays don't.
 */
export async function handleWebhook(deps: WebhookDeps, headers: Headers, rawBody: string): Promise<WebhookResult> {
  if (!deps.webhookId) return { status: 503, outcome: "webhooks not configured" };
  let event: { id?: unknown; event_type?: unknown; resource?: unknown };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return { status: 400, outcome: "not JSON" };
  }
  if (typeof event.id !== "string" || typeof event.event_type !== "string") return { status: 400, outcome: "not a PayPal event" };
  const verified = await deps.paypal.verifyWebhookSignature({
    headers: Object.fromEntries(SIGNATURE_HEADERS.map((k) => [k, headers.get(k)])),
    webhookId: deps.webhookId,
    event,
  });
  if (!verified) return { status: 400, outcome: "bad signature" };

  const [seen] = await deps.db.select({ id: webhookEvents.id }).from(webhookEvents).where(eq(webhookEvents.id, event.id)).limit(1);
  if (seen) return { status: 200, outcome: "duplicate" };
  const resource = event.resource && typeof event.resource === "object" ? (event.resource as Record<string, unknown>) : {};
  const outcome = await dispatch(deps, event.event_type, resource);
  // Not stored as handled, so PayPal sends the event again (503) or shows it as a failed delivery (422).
  if (outcome === NOT_LISTED || REFUND_RETRY.includes(outcome)) return { status: 503, outcome };
  if (outcome === REFUND_UNREADABLE) return { status: 422, outcome };
  await deps.db.insert(webhookEvents).values({ id: event.id, eventType: event.event_type, outcome }).onConflictDoNothing();
  return { status: 200, outcome };
}

async function dispatch(deps: WebhookDeps, type: string, r: Record<string, unknown>): Promise<string> {
  const reconcile = async (id: unknown) =>
    typeof id === "string" && (await reconcileSubscription(deps, id)) ? "reconciled" : "unknown subscription";
  if (type.startsWith("BILLING.SUBSCRIPTION.")) return reconcile(r.id);
  if (type === "PAYMENT.SALE.COMPLETED") {
    const outcome = await reconcile(r.billing_agreement_id);
    if (outcome === "reconciled" && typeof r.id === "string" && !(await isRecorded(deps, r.id))) return NOT_LISTED;
    return outcome;
  }
  if (type === "PAYMENT.CAPTURE.COMPLETED") return creditCapture(deps, r);
  if (type.startsWith("PAYMENT.PAYOUTS-ITEM.")) return refreshPayoutItem(deps, r as PaypalPayoutItem);
  if (REFUND_EVENTS.includes(type)) return recordRefund(deps, type, r);
  return "ignored";
}

async function isRecorded(deps: WebhookDeps, paypalId: string): Promise<boolean> {
  const [row] = await deps.db.select({ id: fundingEvents.paypalId }).from(fundingEvents).where(eq(fundingEvents.paypalId, paypalId)).limit(1);
  return Boolean(row);
}

async function creditCapture(deps: WebhookDeps, r: Record<string, unknown>): Promise<string> {
  const cap = CaptureShape.safeParse(r);
  if (!cap.success) return creditAgentCapture(deps, r);
  const [account] = await deps.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, cap.data.custom_id)).limit(1);
  if (!account) return "unknown account";
  // Read the order itself, so the payment is recorded exactly as when we capture it: with who paid, and only for its owner.
  const order = await deps.paypal.getOrder(cap.data.supplementary_data.related_ids.order_id).catch((e: unknown) => {
    if (e instanceof PayPalError && e.status === 404) return null;
    throw e;
  });
  if (!order || order.purchase_units?.[0]?.custom_id !== account.id) return "unknown order";
  return (await creditCaptures(deps.db, account.id, order, deps.now?.())) > 0 ? "credited" : "already credited";
}

/** The safety net for payments the agent started: PayPal took the money, so credit it even if nobody asks the agent again. */
async function creditAgentCapture(deps: WebhookDeps, r: Record<string, unknown>): Promise<string> {
  const cap = AgentCaptureShape.safeParse(r);
  if (!cap.success) return "ignored";
  const orderId = cap.data.supplementary_data.related_ids.order_id;
  const [payment] = await deps.db.select().from(agentPayments).where(eq(agentPayments.orderId, orderId)).limit(1);
  if (!payment) return "ignored";
  const order = await deps.paypal.getOrder(orderId).catch((e: unknown) => {
    if (e instanceof PayPalError && e.status === 404) return null;
    throw e;
  });
  if (!order) return "unknown order";
  const credited = await creditCaptures(deps.db, payment.accountId, order, deps.now?.());
  if (payment.status !== "captured") {
    await deps.db.update(agentPayments).set({ status: "captured", capturedAt: deps.now?.() ?? new Date() }).where(eq(agentPayments.orderId, orderId));
  }
  return credited > 0 ? "credited" : "already credited";
}
