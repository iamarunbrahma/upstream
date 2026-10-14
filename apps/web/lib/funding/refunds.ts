import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { fundingEvents } from "../db/schema";
import { toCents } from "../paypal/money";

export const REFUND_EVENTS = ["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED", "PAYMENT.SALE.REFUNDED", "PAYMENT.SALE.REVERSED"];

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

/**
 * Takes refunded or reversed money back out of the funder's budget, as a negative funding event. Never takes
 * back more than the payment added, however many refunds name it. The same refund twice is recorded once.
 */
export async function recordRefund(db: Db, type: string, r: Resource): Promise<"refund recorded" | "already recorded" | "unknown payment" | "ignored"> {
  const refundId = typeof r.id === "string" ? r.id : null;
  const paymentId = refundedPaymentId(type, r);
  const cents = refundCents(r);
  if (!refundId || !paymentId || cents <= 0) return "ignored";
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${paymentId}))`);
    const [payment] = await tx
      .select()
      .from(fundingEvents)
      .where(and(eq(fundingEvents.paypalId, paymentId), ne(fundingEvents.source, "refund")))
      .limit(1);
    if (!payment) return "unknown payment";
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
