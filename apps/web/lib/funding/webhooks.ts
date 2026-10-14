import { eq } from "drizzle-orm";
import { z } from "zod";
import { accounts, webhookEvents } from "../db/schema";
import { netCents, recordFunding } from "./ledger";
import { reconcileSubscription, type FundingDeps } from "./subscriptions";

const SIGNATURE_HEADERS = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];

const MoneyShape = z.object({ currency_code: z.string(), value: z.string() });
const CaptureShape = z.object({
  id: z.string(),
  status: z.literal("COMPLETED"),
  custom_id: z.uuid(),
  create_time: z.string().optional(),
  amount: MoneyShape.optional(),
  seller_receivable_breakdown: z.object({ net_amount: MoneyShape.optional() }).optional(),
});

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
  await deps.db.insert(webhookEvents).values({ id: event.id, eventType: event.event_type, outcome }).onConflictDoNothing();
  return { status: 200, outcome };
}

async function dispatch(deps: WebhookDeps, type: string, r: Record<string, unknown>): Promise<string> {
  const reconcile = async (id: unknown) =>
    typeof id === "string" && (await reconcileSubscription(deps, id)) ? "reconciled" : "unknown subscription";
  if (type.startsWith("BILLING.SUBSCRIPTION.")) return reconcile(r.id);
  if (type === "PAYMENT.SALE.COMPLETED") return reconcile(r.billing_agreement_id);
  if (type === "PAYMENT.CAPTURE.COMPLETED") return creditCapture(deps, r);
  return "ignored";
}

async function creditCapture(deps: WebhookDeps, r: Record<string, unknown>): Promise<string> {
  const cap = CaptureShape.safeParse(r);
  if (!cap.success) return "ignored";
  const [account] = await deps.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, cap.data.custom_id)).limit(1);
  if (!account) return "unknown account";
  const fresh = await recordFunding(deps.db, {
    accountId: account.id,
    source: "topup",
    paypalId: cap.data.id,
    amountCents: netCents(cap.data.seller_receivable_breakdown?.net_amount, cap.data.amount),
    payerId: null,
    occurredAt: cap.data.create_time ? new Date(cap.data.create_time) : new Date(),
    raw: r,
  });
  return fresh ? "credited" : "already credited";
}
