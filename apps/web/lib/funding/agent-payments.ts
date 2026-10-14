import { and, eq, gt, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { agentPayments } from "../db/schema";
import type { AgentOrders } from "../paypal/agent-toolkit";
import type { PaypalOrder } from "../paypal/api";
import { PayPalError } from "../paypal/client";
import { balanceCents, netCents } from "./ledger";
import { FundingError } from "./subscriptions";
import { creditCaptures, TOPUP_MAX_CENTS, TOPUP_MIN_CENTS } from "./topups";

export const AGENT_OPEN_LIMIT = 3;
export const AGENT_DAILY_CENTS = 10_000;
const OPEN_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AgentPaymentDeps {
  db: Db;
  orders: AgentOrders;
  now?: () => Date;
}

export type AgentPaymentResult =
  | { status: "added"; addedCents: number; budgetCents: number }
  | { status: "waiting" | "processing" | "cancelled"; budgetCents: number };

/** Starts a PayPal order the developer's agent asked for. Nothing moves until the developer approves it in PayPal. */
export async function startAgentPayment(
  deps: AgentPaymentDeps,
  accountId: string,
  cents: number,
  urls: { returnUrl: string; cancelUrl: string },
): Promise<{ orderId: string; approveUrl: string; cents: number }> {
  if (!Number.isInteger(cents) || cents < TOPUP_MIN_CENTS || cents > TOPUP_MAX_CENTS) {
    throw new FundingError(400, "Payments from the agent can be from $1 to $500");
  }
  const now = deps.now?.() ?? new Date();
  // One account's starts run one at a time, so two parallel requests can't both pass the limits.
  const order = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-payments:${accountId}`}))`);
    const [open] = await tx
      .select({ n: sql<string>`count(*)` })
      .from(agentPayments)
      .where(and(eq(agentPayments.accountId, accountId), eq(agentPayments.status, "created"), gt(agentPayments.createdAt, new Date(now.getTime() - OPEN_MS))));
    if (Number(open?.n ?? 0) >= AGENT_OPEN_LIMIT) {
      throw new FundingError(429, "You already have 3 payments waiting for approval in PayPal. Approve one, or wait a few hours, then try again.");
    }
    const [day] = await tx
      .select({ total: sql<string>`coalesce(sum(${agentPayments.cents}), 0)` })
      .from(agentPayments)
      .where(and(eq(agentPayments.accountId, accountId), ne(agentPayments.status, "cancelled"), gt(agentPayments.createdAt, new Date(now.getTime() - DAY_MS))));
    if (Number(day?.total ?? 0) + cents > AGENT_DAILY_CENTS) {
      throw new FundingError(429, "Your agent can add at most $100 a day. Add more on the dashboard, or try again tomorrow.");
    }
    const created = await deps.orders.createOrder(cents, urls.returnUrl, urls.cancelUrl);
    await tx.insert(agentPayments).values({ orderId: created.id, accountId, cents, createdAt: now });
    return created;
  });
  return { orderId: order.id, approveUrl: order.approveUrl, cents };
}

/** Net of PayPal's fee, over the order's completed captures. */
function orderNetCents(order: PaypalOrder): number {
  return (order.purchase_units ?? [])
    .flatMap((u) => u.payments?.captures ?? [])
    .filter((c) => c.status === "COMPLETED")
    .reduce((sum, c) => sum + netCents(c.seller_receivable_breakdown?.net_amount, c.amount), 0);
}

/**
 * Checks a payment the agent started, for the account that started it: captures it once approved and credits it.
 * Safe to call any number of times; the budget is credited once per capture.
 */
export async function finishAgentPayment(deps: AgentPaymentDeps, accountId: string, orderId: string): Promise<AgentPaymentResult> {
  const [row] = await deps.db
    .select()
    .from(agentPayments)
    .where(and(eq(agentPayments.orderId, orderId), eq(agentPayments.accountId, accountId)))
    .limit(1);
  if (!row) throw new FundingError(404, "No such payment for this machine.");
  const now = deps.now?.() ?? new Date();
  const budget = () => balanceCents(deps.db, accountId);
  const cancel = async (): Promise<AgentPaymentResult> => {
    await deps.db.update(agentPayments).set({ status: "cancelled" }).where(eq(agentPayments.orderId, orderId));
    return { status: "cancelled", budgetCents: await budget() };
  };
  if (row.status === "cancelled") return { status: "cancelled", budgetCents: await budget() };

  let order: PaypalOrder;
  try {
    order = await deps.orders.getOrder(orderId);
  } catch (e) {
    if (e instanceof PayPalError && e.status === 404) return cancel();
    throw e;
  }
  if (order.status === "APPROVED") {
    try {
      order = await deps.orders.captureOrder(orderId);
    } catch (e) {
      if (!(e instanceof PayPalError)) throw e;
      order = await deps.orders.getOrder(orderId);
      if (order.status !== "COMPLETED") throw e;
    }
    if (order.status !== "COMPLETED") order = await deps.orders.getOrder(orderId);
  }
  if (order.status === "COMPLETED") {
    // PayPal can complete the order while its capture is still pending (a payment review): nothing to credit yet.
    if (orderNetCents(order) === 0) return { status: "processing", budgetCents: await budget() };
    await creditCaptures(deps.db, accountId, order, now);
    if (row.status !== "captured") await deps.db.update(agentPayments).set({ status: "captured", capturedAt: now }).where(eq(agentPayments.orderId, orderId));
    return { status: "added", addedCents: orderNetCents(order), budgetCents: await budget() };
  }
  if (order.status === "VOIDED") return cancel();
  return { status: "waiting", budgetCents: await budget() };
}

/**
 * The developer pressed Cancel on PayPal's page. PayPal doesn't void the order, so mark it cancelled here (unless
 * it was approved after all), which also frees it from the limits. Anyone holding the order id can only cancel a
 * payment that hasn't been approved, so no money can be lost this way.
 */
export async function cancelAgentPayment(deps: AgentPaymentDeps, orderId: string): Promise<boolean> {
  const [row] = await deps.db.select({ status: agentPayments.status }).from(agentPayments).where(eq(agentPayments.orderId, orderId)).limit(1);
  if (row?.status !== "created") return false;
  const order = await deps.orders.getOrder(orderId).catch((e: unknown) => {
    if (e instanceof PayPalError && e.status === 404) return null;
    throw e;
  });
  if (order && (order.status === "APPROVED" || order.status === "COMPLETED")) return false;
  const done = await deps.db
    .update(agentPayments)
    .set({ status: "cancelled" })
    .where(and(eq(agentPayments.orderId, orderId), eq(agentPayments.status, "created")))
    .returning({ id: agentPayments.orderId });
  return done.length > 0;
}
