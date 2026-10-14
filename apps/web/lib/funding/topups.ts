import type { Db } from "../db/client";
import type { PaypalOrder } from "../paypal/api";
import { PayPalError } from "../paypal/client";
import { netCents, recordFunding } from "./ledger";
import { FundingError, type FundingDeps } from "./subscriptions";

export const TOPUP_MIN_CENTS = 100;
export const TOPUP_MAX_CENTS = 50_000;

export async function startTopup(deps: FundingDeps, accountId: string, cents: number): Promise<string> {
  if (!Number.isInteger(cents) || cents < TOPUP_MIN_CENTS || cents > TOPUP_MAX_CENTS) {
    throw new FundingError(400, "Top-ups can be from $1 to $500");
  }
  return (await deps.paypal.createOrder(cents, accountId, "Upstream open-source budget top-up")).id;
}

/** Credits every completed capture on `order` to `accountId`, once per capture id. Returns the newly credited cents. */
export async function creditCaptures(db: Db, accountId: string, order: PaypalOrder, now: Date = new Date()): Promise<number> {
  let credited = 0;
  for (const unit of order.purchase_units ?? []) {
    for (const cap of unit.payments?.captures ?? []) {
      if (cap.status !== "COMPLETED") continue;
      const cents = netCents(cap.seller_receivable_breakdown?.net_amount, cap.amount);
      const fresh = await recordFunding(db, {
        accountId,
        source: "topup",
        paypalId: cap.id,
        amountCents: cents,
        payerId: order.payer?.payer_id ?? null,
        occurredAt: cap.create_time ? new Date(cap.create_time) : now,
        raw: cap,
      });
      if (fresh) credited += cents;
    }
  }
  return credited;
}

async function getOwnOrder(deps: FundingDeps, accountId: string, orderId: string): Promise<PaypalOrder> {
  let order: PaypalOrder;
  try {
    order = await deps.paypal.getOrder(orderId);
  } catch (e) {
    if (e instanceof PayPalError && e.status === 404) throw new FundingError(404, "order not found");
    throw e;
  }
  if (order.purchase_units?.[0]?.custom_id !== accountId) throw new FundingError(404, "order not found");
  return order;
}

/** Captures an approved top-up and credits it. Ownership is checked before capturing; retrying after any failure is safe. */
export async function completeTopup(deps: FundingDeps, accountId: string, orderId: string): Promise<number> {
  let order = await getOwnOrder(deps, accountId, orderId);
  if (order.status !== "COMPLETED") {
    try {
      order = await deps.paypal.captureOrder(orderId);
    } catch (e) {
      if (!(e instanceof PayPalError)) throw e;
      if (e.code === "ORDER_ALREADY_CAPTURED") order = await deps.paypal.getOrder(orderId);
      else if (e.code === "ORDER_NOT_APPROVED") throw new FundingError(409, "Approve the payment in the PayPal window first");
      else throw e;
    }
  }
  return creditCaptures(deps.db, accountId, order, deps.now?.());
}
