import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { receipts } from "../db/schema";
import { balanceCents } from "../funding/ledger";

/** Why "Settle now" has nothing to do for this funder yet, in plain words; null when it can run. */
export async function settleNowBlocker(db: Db, accountId: string): Promise<string | null> {
  if ((await balanceCents(db, accountId)) <= 0) return "Add money to your budget first.";
  const [open] = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.accountId, accountId), eq(receipts.status, "approved"), isNull(receipts.settlementId)))
    .limit(1);
  return open ? null : "Approve a receipt first. Settling splits your budget across the receipts you approved.";
}
