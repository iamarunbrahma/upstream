import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { accruals, payoutItems, settlements } from "../db/schema";
import type { PaypalPayoutItem } from "../paypal/api";
import { toCents } from "../paypal/money";
import type { PayoutDeps } from "./payouts";

/** PayPal paid the line. */
const PAID = ["SUCCESS"];
/** The money didn't arrive, or came back: it's held again, to be paid on a later run or returned after 90 days. */
const BOUNCED = ["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED"];
const FINAL = [...PAID, ...BOUNCED];

/**
 * Applies PayPal's status for one payout line, from a webhook or from reading the batch. The line must be one
 * we sent, in the batch PayPal names. Applying the same status again changes nothing.
 */
export async function applyPayoutItem(db: Db, item: PaypalPayoutItem): Promise<"payout line updated" | "unknown payout line" | "ignored"> {
  const id = z.uuid().safeParse(item.payout_item?.sender_item_id);
  if (!id.success || !item.transaction_status) return "ignored";
  const [line] = await db
    .select({ id: payoutItems.id, settlementId: payoutItems.settlementId, batchId: settlements.payoutBatchId })
    .from(payoutItems)
    .innerJoin(settlements, eq(settlements.id, payoutItems.settlementId))
    .where(eq(payoutItems.id, id.data))
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
  if (PAID.includes(item.transaction_status)) {
    await db.update(accruals).set({ status: "paid" }).where(and(eq(accruals.payoutItemId, line.id), eq(accruals.status, "queued")));
  } else if (BOUNCED.includes(item.transaction_status)) {
    await db
      .update(accruals)
      .set({ status: "held", payoutItemId: null })
      .where(and(eq(accruals.payoutItemId, line.id), inArray(accruals.status, ["queued", "paid"])));
  }
  return "payout line updated";
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
