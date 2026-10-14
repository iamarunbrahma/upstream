import { sql } from "drizzle-orm";
import type { Db } from "../db/client";

/** One Postgres advisory lock for every write that moves money between accrual states. */
export const SETTLE_LOCK = 7_340_211;

/**
 * Runs `fn` in a transaction holding SETTLE_LOCK, so settling, queuing payouts and applying a payout status
 * never interleave, and each one happens completely or not at all.
 */
export function withSettleLock<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETTLE_LOCK})`);
    return fn(tx as unknown as Db);
  });
}
