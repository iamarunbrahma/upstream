import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { fundingEvents } from "../db/schema";
import type { PayPalApi } from "../paypal/api";
import { PayPalError } from "../paypal/client";
import { toCents } from "../paypal/money";

export const REFUND_EVENTS = ["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED", "PAYMENT.SALE.REFUNDED", "PAYMENT.SALE.REVERSED"];

/**
 * A refund must never be lost, or refunded money could still be paid out. Outcomes that ask PayPal to send the
 * event again (503), and one it shows as a failed delivery (422), for the webhook handler.
 */
export const REFUND_RETRY = ["payment not recorded yet", "refund not completed yet"];
export const REFUND_UNREADABLE = "refund not understood";
export type RefundOutcome = "refund recorded" | "already recorded" | "ignored" | "payment not recorded yet" | "refund not completed yet" | "refund not understood";

type Resource = Record<string, unknown>;

/** The sale or capture a refund takes money from: `sale_id` (v1), or the "up" / "sale" link (v2 and v1). */
function refundedPaymentId(type: string, r: Resource): string | null {
  if (typeof r.sale_id === "string") return r.sale_id;
  for (const link of Array.isArray(r.links) ? (r.links as Array<{ rel?: unknown; href?: unknown }>) : []) {
    if ((link.rel === "up" || link.rel === "sale") && typeof link.href === "string") {
      const m = link.href.match(/\/(?:captures|sale)\/([A-Za-z0-9-]+)$/);
      if (m) return m[1]!;
    }
  }
  // A reversed sale can arrive as the sale itself.
  return type === "PAYMENT.SALE.REVERSED" && typeof r.id === "string" ? r.id : null;
}

/** The refunded amount in cents: v2 uses { value, currency_code }, v1 { total, currency }, sometimes negative. */
function refundCents(r: Resource): number {
  const a = r.amount as { value?: unknown; total?: unknown; currency_code?: unknown; currency?: unknown } | undefined;
  const value = a?.value ?? a?.total;
  if ((a?.currency_code ?? a?.currency) !== "USD" || typeof value !== "string") return 0;
  return toCents(value.replace(/^-/, ""));
}

export interface RefundDeps {
  db: Db;
  paypal: PayPalApi;
}

/**
 * PayPal's current record of the refund an event names: PayPal resends the same event body on every retry, so
 * only a fresh read can show a pending refund completing. A sale reversal is a final, one-off event, used as sent.
 */
async function currentRefund(paypal: PayPalApi, type: string, event: Resource): Promise<Resource | null> {
  if (type === "PAYMENT.SALE.REVERSED") return event;
  const id = typeof event.id === "string" ? event.id : null;
  if (!id) return null;
  try {
    return type.startsWith("PAYMENT.CAPTURE.") ? await paypal.getRefund(id) : await paypal.getSaleRefund(id);
  } catch (e) {
    if (e instanceof PayPalError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Takes refunded or reversed money back out of the funder's budget, as a negative funding event. Never takes
 * back more than the payment added, however many refunds name it. The same refund twice is recorded once.
 * Fails closed: a refund for a payment not recorded yet, or still pending, is asked for again.
 */
export async function recordRefund(deps: RefundDeps, type: string, event: Resource): Promise<RefundOutcome> {
  const r = await currentRefund(deps.paypal, type, event);
  if (!r) return REFUND_UNREADABLE;
  const db = deps.db;
  const state = String(r.status ?? r.state ?? "").toUpperCase();
  if (["FAILED", "CANCELLED", "CANCELED", "DENIED"].includes(state)) return "ignored";
  if (state === "PENDING") return "refund not completed yet";
  const currency = (r.amount as { currency_code?: unknown; currency?: unknown } | undefined)?.currency_code ?? (r.amount as { currency?: unknown } | undefined)?.currency;
  if (typeof currency === "string" && currency !== "USD") return "ignored";
  const refundId = typeof r.id === "string" ? r.id : null;
  const paymentId = refundedPaymentId(type, r);
  const cents = refundCents(r);
  if (!refundId || !paymentId || cents <= 0) return REFUND_UNREADABLE;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${paymentId}))`);
    const [payment] = await tx
      .select()
      .from(fundingEvents)
      .where(and(eq(fundingEvents.paypalId, paymentId), ne(fundingEvents.source, "refund")))
      .limit(1);
    if (!payment) return "payment not recorded yet";
    const [prior] = await tx
      .select({ total: sql<string>`coalesce(sum(${fundingEvents.amountCents}), 0)` })
      .from(fundingEvents)
      .where(eq(fundingEvents.refundOf, paymentId));
    const left = payment.amountCents + Number(prior?.total ?? 0);
    const take = Math.min(cents, Math.max(left, 0));
    if (take === 0) return "already recorded";
    const rows = await tx
      .insert(fundingEvents)
      .values({
        paypalId: `refund:${refundId}`,
        accountId: payment.accountId,
        source: "refund",
        refundOf: paymentId,
        amountCents: -take,
        payerId: null,
        occurredAt: typeof r.create_time === "string" ? new Date(r.create_time) : new Date(),
        raw: r,
      })
      .onConflictDoNothing({ target: fundingEvents.paypalId })
      .returning({ id: fundingEvents.paypalId });
    return rows.length > 0 ? "refund recorded" : "already recorded";
  });
}
