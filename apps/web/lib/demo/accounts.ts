import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts } from "../db/schema";

/** The hosted sandbox demo: "Try the demo" accounts, the sample session and "Settle now". Off unless DEMO_MODE=1. */
export function demoEnabled(): boolean {
  return process.env.DEMO_MODE === "1";
}

/** A new, empty funder account for one visitor of the demo. */
export async function createDemoAccount(db: Db): Promise<string> {
  const [account] = await db.insert(accounts).values({ demo: true }).returning({ id: accounts.id });
  return account!.id;
}

/** True only for an account "Try the demo" made, and only while this server runs the demo. */
export async function isDemoAccount(db: Db, accountId: string): Promise<boolean> {
  if (!demoEnabled()) return false;
  const [account] = await db.select({ demo: accounts.demo }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
  return account?.demo === true;
}
