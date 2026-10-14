import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { accruals, payoutItems, settlements } from "../db/schema";
import type { PaypalPayoutItem } from "../paypal/api";
import { PayPalError } from "../paypal/client";
import { toCents } from "../paypal/money";
import { withSettleLock } from "./lock";
import type { PayoutDeps } from "./payouts";

/** PayPal paid the line. */
const PAID = ["SUCCESS"];
/** The money never arrived. It's held again, for a later run (or the funder, after 90 days unclaimed). */
const RETRY = ["FAILED", "RETURNED"];
/** PayPal won't deliver it. The money goes back to the funder. */
const UNDELIVERABLE = ["BLOCKED", "DENIED"];
/** The money arrived, then came back: the maintainer refunded it or PayPal reversed it. It goes back to the funder. */
const CAME_BACK = ["REFUNDED", "REVERSED"];
const FINAL = [...PAID, ...RETRY, ...UNDELIVERABLE, ...CAME_BACK];

/**
 * Applies PayPal's current status for one payout line, read from PayPal (never taken from a webhook's body).
 * The line must be one we sent, in the batch PayPal names. Money PayPal has paid stays paid unless PayPal says
 * it came back. Applying the same status again changes nothing.
 */
export async function applyPayoutItem(db: Db, item: PaypalPayoutItem): Promise<"payout line updated" | "unknown payout line" | "ignored"> {
  const id = z.uuid().safeParse(item.payout_item?.sender_item_id);
  if (!id.success || !item.transaction_status) return "ignored";
  return withSettleLock(db, (tx) => applyLocked(tx, id.data, item));
}

async function applyLocked(db: Db, lineId: string, item: PaypalPayoutItem): Promise<"payout line updated" | "unknown payout line"> {
  const [line] = await db
    .select({ id: payoutItems.id, settlementId: payoutItems.settlementId, batchId: settlements.payoutBatchId })
    .from(payoutItems)
    .innerJoin(settlements, eq(settlements.id, payoutItems.settlementId))
    .where(eq(payoutItems.id, lineId))
    .limit(1);
  if (!line) return "unknown payout line";
  if (item.payout_batch_id && line.batchId && item.payout_batch_id !== line.batchId) return "unknown payout line";
  if (item.payout_batch_id && !line.batchId) {
    await db.update(settlements).set({ payoutBatchId: item.payout_batch_id }).where(eq(settlements.id, line.settlementId));
  }
  const fee = item.payout_item_fee?.currency === "USD" ? toCents(item.payout_item_fee.value) : null;
  await db
    .update(payoutItems)
    .set({ status: item.transaction_status, paypalItemId: item.payout_item_id ?? null, feeCents: fee, updatedAt: new Date() })
    .where(eq(payoutItems.id, line.id));
  const ofLine = (statuses: Array<"queued" | "paid">) => and(eq(accruals.payoutItemId, line.id), inArray(accruals.status, statuses));
  const status = item.transaction_status!;
  if (PAID.includes(status)) {
    await db.update(accruals).set({ status: "paid" }).where(ofLine(["queued"]));
  } else if (RETRY.includes(status)) {
    await db.update(accruals).set({ status: "held", payoutItemId: null }).where(ofLine(["queued"]));
  } else if (UNDELIVERABLE.includes(status)) {
    await db.update(accruals).set({ status: "returned", returnReason: "bounced" }).where(ofLine(["queued"]));
  } else if (CAME_BACK.includes(status)) {
    await db.update(accruals).set({ status: "returned", returnReason: "bounced" }).where(ofLine(["queued", "paid"]));
  }
  return "payout line updated";
}

/** A payout webhook only says "this line changed": read the line from PayPal and apply what PayPal says now. */
export async function refreshPayoutItem(deps: PayoutDeps, resource: PaypalPayoutItem): Promise<"payout line updated" | "unknown payout line" | "ignored"> {
  if (typeof resource.payout_item_id !== "string" || !resource.payout_item_id) return "ignored";
  let current: PaypalPayoutItem;
  try {
    current = await deps.paypal.getPayoutItem(resource.payout_item_id);
  } catch (e) {
    if (e instanceof PayPalError && e.status === 404) return "unknown payout line";
    throw e;
  }
  return applyPayoutItem(deps.db, current);
}

/** Reads every sent batch that still has unfinished lines, for when webhooks can't reach us. Returns lines updated. */
export async function reconcilePayouts(deps: PayoutDeps): Promise<number> {
  const open = await deps.db
    .selectDistinct({ id: settlements.id, batchId: settlements.payoutBatchId })
    .from(settlements)
    .innerJoin(payoutItems, eq(payoutItems.settlementId, settlements.id))
    .where(isNotNull(settlements.payoutBatchId));
  let updated = 0;
  for (const s of open) {
    const lines = await deps.db.select({ status: payoutItems.status }).from(payoutItems).where(eq(payoutItems.settlementId, s.id));
    if (lines.every((l) => FINAL.includes(l.status))) continue;
    const batch = await deps.paypal.getPayoutBatch(s.batchId!);
    await deps.db.update(settlements).set({ batchStatus: batch.batch_header.batch_status }).where(eq(settlements.id, s.id));
    for (const item of batch.items ?? []) {
      if ((await applyPayoutItem(deps.db, { ...item, payout_batch_id: item.payout_batch_id ?? s.batchId! })) === "payout line updated") updated += 1;
    }
  }
  return updated;
}
