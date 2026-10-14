import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals, fundingEvents, maintainers, payoutItems, settlements, subscriptions } from "../db/schema";
import type { PayPalApi } from "../paypal/api";
import { PayPalError } from "../paypal/client";
import { balanceCents } from "./ledger";

const DAY = 24 * 60 * 60 * 1000;
/** A maintainer is paid once they're owed at least this much; below it, money carries over (spec section 7). */
export const MIN_PAYOUT_CENTS = 100;
/** Self-dealing control: a new maintainer's first payout waits this long after they link PayPal. */
export const FIRST_PAYOUT_HOLD_MS = 7 * DAY;
/** Money nobody claimed in this long goes back into the funder's budget. */
export const UNCLAIMED_RETURN_MS = 90 * DAY;

export interface QueueSummary {
  returnedCents: number;
  payoutLines: number;
  queuedCents: number;
}

const total = (rows: Array<{ cents: number }>) => rows.reduce((sum, r) => sum + r.cents, 0);

/**
 * Runs inside the settlement's locked transaction. Gives money back to funders when it sat unclaimed for
 * 90 days, or when it would go to the funder's own PayPal account. Then puts everything held for each
 * maintainer who linked PayPal at least 7 days ago, and is owed $1 or more, on one payout line.
 */
export async function queuePayouts(tx: Db, settlementId: string, now: Date): Promise<QueueSummary> {
  const refunded = await takeBackRefunded(tx);
  const claimed = tx.select({ login: maintainers.login }).from(maintainers).where(isNotNull(maintainers.paypalPayerId));
  const unclaimed = await tx
    .update(accruals)
    .set({ status: "returned", returnReason: "unclaimed" })
    .where(and(eq(accruals.status, "held"), lt(accruals.createdAt, new Date(now.getTime() - UNCLAIMED_RETURN_MS)), notInArray(accruals.login, claimed)))
    .returning({ cents: accruals.cents });
  // The funder's PayPal accounts are the payers on their own payments and subscriptions.
  const samePerson = await tx
    .update(accruals)
    .set({ status: "returned", returnReason: "same-person" })
    .where(
      and(
        eq(accruals.status, "held"),
        sql`exists (
          select 1 from ${maintainers} m
          where m.login = ${accruals.login} and m.paypal_payer_id is not null and (
            exists (select 1 from ${fundingEvents} f where f.account_id = ${accruals.funderId} and f.payer_id = m.paypal_payer_id)
            or exists (select 1 from ${subscriptions} s where s.account_id = ${accruals.funderId} and s.payer_id = m.paypal_payer_id)
          )
        )`,
      ),
    )
    .returning({ cents: accruals.cents });

  const ready = await tx
    .select({ login: maintainers.login, payerId: maintainers.paypalPayerId, cents: sql<string>`sum(${accruals.cents})` })
    .from(accruals)
    .innerJoin(maintainers, eq(maintainers.login, accruals.login))
    .where(and(eq(accruals.status, "held"), isNotNull(maintainers.paypalPayerId), lte(maintainers.claimedAt, new Date(now.getTime() - FIRST_PAYOUT_HOLD_MS))))
    .groupBy(maintainers.login, maintainers.paypalPayerId)
    .having(sql`sum(${accruals.cents}) >= ${MIN_PAYOUT_CENTS}`)
    .orderBy(maintainers.login);
  let queuedCents = 0;
  for (const r of ready) {
    const cents = Number(r.cents);
    const [line] = await tx.insert(payoutItems).values({ settlementId, login: r.login, payerId: r.payerId!, cents, updatedAt: now }).returning({ id: payoutItems.id });
    await tx.update(accruals).set({ status: "queued", payoutItemId: line!.id }).where(and(eq(accruals.status, "held"), eq(accruals.login, r.login)));
    queuedCents += cents;
  }
  return { returnedCents: refunded + total(unclaimed) + total(samePerson), payoutLines: ready.length, queuedCents };
}

/** A refund after a settlement can leave a funder below zero. Take back their money not yet paid out, newest first. */
async function takeBackRefunded(tx: Db): Promise<number> {
  const funders = await tx.selectDistinct({ id: accruals.funderId }).from(accruals).where(eq(accruals.status, "held"));
  let returned = 0;
  for (const f of funders) {
    let short = -(await balanceCents(tx, f.id));
    if (short <= 0) continue;
    const held = await tx
      .select({ id: accruals.id, cents: accruals.cents })
      .from(accruals)
      .where(and(eq(accruals.funderId, f.id), eq(accruals.status, "held")))
      .orderBy(desc(accruals.createdAt), desc(accruals.cents));
    const ids: string[] = [];
    for (const a of held) {
      if (short <= 0) break;
      ids.push(a.id);
      short -= a.cents;
    }
    if (ids.length === 0) continue;
    const back = await tx.update(accruals).set({ status: "returned", returnReason: "refunded" }).where(inArray(accruals.id, ids)).returning({ cents: accruals.cents });
    returned += total(back);
  }
  return returned;
}

export interface PayoutDeps {
  db: Db;
  paypal: PayPalApi;
}

export interface SendResult {
  settlementId: string;
  /** sent: PayPal took the batch. sent-before: PayPal already has it, from an earlier try whose answer was lost. */
  outcome: "sent" | "sent-before" | "failed";
  batchId?: string;
  error?: string;
}

const isDuplicateBatch = (e: unknown) => e instanceof PayPalError && e.status === 400 && /sender_batch_id already exists/i.test(`${e.code} ${e.message}`);

async function lineNote(db: Db, lineId: string): Promise<string> {
  const rows = await db.selectDistinct({ name: accruals.name }).from(accruals).where(eq(accruals.payoutItemId, lineId)).orderBy(accruals.name);
  const names = rows.map((r) => r.name);
  const shown = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
  return `Thanks for ${shown}. AI coding agents used it, and their developers chose to pay you through Upstream.`;
}

/**
 * Sends each settlement's payout lines that PayPal hasn't taken yet, as one batch whose sender_batch_id is the
 * settlement id. PayPal refuses that id twice, so repeating this never pays twice. A failure leaves the lines
 * for the next run.
 */
export async function payOut(deps: PayoutDeps): Promise<SendResult[]> {
  const waiting = await deps.db
    .selectDistinct({ id: settlements.id })
    .from(settlements)
    .innerJoin(payoutItems, eq(payoutItems.settlementId, settlements.id))
    .where(and(isNull(settlements.payoutBatchId), isNull(settlements.batchStatus)));
  const results: SendResult[] = [];
  for (const { id } of waiting) {
    const lines = await deps.db.select().from(payoutItems).where(eq(payoutItems.settlementId, id)).orderBy(payoutItems.login);
    try {
      const notes = await Promise.all(lines.map((l) => lineNote(deps.db, l.id)));
      const batch = await deps.paypal.createPayoutBatch(
        id,
        lines.map((l, i) => ({ senderItemId: l.id, payerId: l.payerId, cents: l.cents, note: notes[i]! })),
      );
      await deps.db
        .update(settlements)
        .set({ payoutBatchId: batch.batch_header.payout_batch_id, batchStatus: batch.batch_header.batch_status })
        .where(eq(settlements.id, id));
      results.push({ settlementId: id, outcome: "sent", batchId: batch.batch_header.payout_batch_id });
    } catch (e) {
      if (isDuplicateBatch(e)) {
        // PayPal has this batch but we never heard its id. Its payout webhooks carry the id and fill it in.
        await deps.db.update(settlements).set({ batchStatus: "UNKNOWN" }).where(eq(settlements.id, id));
        results.push({ settlementId: id, outcome: "sent-before" });
      } else if (e instanceof PayPalError) {
        results.push({ settlementId: id, outcome: "failed", error: `${e.status} ${e.code}` });
      } else {
        throw e;
      }
    }
  }
  return results;
}
