import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { accountSettings } from "../db/schema";
import { balanceCents } from "./ledger";

export interface AccountSettings {
  autoApprove: boolean;
}

export async function getSettings(db: Db, accountId: string): Promise<AccountSettings> {
  const [row] = await db
    .select({ autoApprove: accountSettings.autoApprove })
    .from(accountSettings)
    .where(eq(accountSettings.accountId, accountId))
    .limit(1);
  return { autoApprove: row?.autoApprove ?? false };
}

export async function setAutoApprove(db: Db, accountId: string, autoApprove: boolean): Promise<AccountSettings> {
  await db
    .insert(accountSettings)
    .values({ accountId, autoApprove })
    .onConflictDoUpdate({ target: accountSettings.accountId, set: { autoApprove, updatedAt: new Date() } });
  return { autoApprove };
}

/** The spending rule: approve by itself only when the funder turned it on and there is money in the budget. */
export async function shouldAutoApprove(db: Db, accountId: string): Promise<boolean> {
  return (await getSettings(db, accountId)).autoApprove && (await balanceCents(db, accountId)) > 0;
}
