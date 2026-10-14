import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals, maintainers, payoutItems, recipientCache } from "../db/schema";
import { withSettleLock } from "../funding/lock";
import { createMaintainerSession } from "./sessions";

/** Moves a maintainer row, and the money and payout lines filed under its login, to another login. */
async function relabel(tx: Db, from: string, to: string): Promise<void> {
  await tx.update(maintainers).set({ login: to }).where(eq(maintainers.login, from));
  await tx.update(accruals).set({ login: to }).where(eq(accruals.login, from));
  await tx.update(payoutItems).set({ login: to }).where(eq(payoutItems.login, from));
  // Cached "who gets paid" answers that name the old login are out of date now.
  await tx.delete(recipientCache).where(sql`${recipientCache.data}->'recipients' @> ${JSON.stringify([{ login: from }])}::jsonb`);
}

/**
 * Signs a maintainer in by their GitHub account and returns a new session. Identity is GitHub's numeric id:
 * when the login was renamed, the row and everything filed under it move to the new login. GitHub has just
 * proved who holds this login now, so a row another GitHub account left under it (they renamed away, and the
 * name was taken again) is moved aside under "~<their id>", where it stays theirs until they sign in again.
 * A claim made for this login before anyone signed in (sandbox seeding) becomes theirs.
 */
export async function signInMaintainer(db: Db, user: { id: number; login: string }, now: Date = new Date()): Promise<string> {
  const login = user.login.toLowerCase();
  // Moving money between logins is an accrual change, so it waits for any settlement in progress.
  return withSettleLock(db, async (tx) => {
    const [mine] = await tx.select().from(maintainers).where(eq(maintainers.githubId, user.id)).limit(1);
    const [named] = await tx.select().from(maintainers).where(eq(maintainers.login, login)).limit(1);
    if (named && named.githubId !== user.id && (named.githubId !== null || mine)) {
      await relabel(tx, login, named.githubId !== null ? `~${named.githubId}` : `~seeded:${login}`);
    }
    if (mine && mine.login !== login) {
      await relabel(tx, mine.login, login);
    } else if (!mine && named && named.githubId === null) {
      await tx.update(maintainers).set({ githubId: user.id }).where(eq(maintainers.login, login));
    } else if (!mine) {
      await tx.insert(maintainers).values({ login, githubId: user.id });
    }
    return createMaintainerSession(tx, user.id, now);
  });
}

export type LinkResult = "linked" | "unchanged" | "not verified" | "used by another maintainer";

/**
 * Links the PayPal account a maintainer proved with Log in with PayPal. Only verified accounts, never one
 * already linked to another maintainer. A different account restarts the 7-day hold before the next payout.
 */
export async function linkPayPal(db: Db, githubId: number, account: { payerId: string; verified: boolean }, now: Date = new Date()): Promise<LinkResult> {
  if (!account.verified) return "not verified";
  // Who can be paid is what queuePayouts reads, so this waits for any settlement in progress.
  return withSettleLock(db, async (tx) => {
    const [me] = await tx.select().from(maintainers).where(eq(maintainers.githubId, githubId)).limit(1);
    if (!me) throw new Error("linkPayPal needs a signed-in maintainer");
    if (me.paypalPayerId === account.payerId) return "unchanged";
    const [other] = await tx
      .select({ login: maintainers.login })
      .from(maintainers)
      .where(and(eq(maintainers.paypalPayerId, account.payerId), ne(maintainers.login, me.login)))
      .limit(1);
    if (other) return "used by another maintainer";
    await tx.update(maintainers).set({ paypalPayerId: account.payerId, claimedAt: now }).where(eq(maintainers.githubId, githubId));
    return "linked";
  });
}
