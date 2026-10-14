import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals, maintainers, payoutItems } from "../db/schema";
import { withSettleLock } from "../funding/lock";
import { createMaintainerSession } from "./sessions";

export type SignIn = { ok: true; session: string } | { ok: false; reason: "taken" };

/**
 * Signs a maintainer in by their GitHub account. Identity is GitHub's numeric id: when the login was renamed,
 * the row and everything they're owed move to the new login. A claim made for their login before they ever
 * signed in (sandbox seeding) becomes theirs. A login another GitHub account holds here is refused.
 */
export async function signInMaintainer(db: Db, user: { id: number; login: string }, now: Date = new Date()): Promise<SignIn> {
  const login = user.login.toLowerCase();
  // Moving money to a renamed login is an accrual change, so it waits for any settlement in progress.
  return withSettleLock(db, async (tx) => {
    const [mine] = await tx.select().from(maintainers).where(eq(maintainers.githubId, user.id)).limit(1);
    const [named] = await tx.select().from(maintainers).where(eq(maintainers.login, login)).limit(1);
    if (named && named.githubId !== null && named.githubId !== user.id) return { ok: false, reason: "taken" };
    if (mine && mine.login !== login) {
      if (named) return { ok: false, reason: "taken" };
      await tx.update(maintainers).set({ login }).where(eq(maintainers.githubId, user.id));
      await tx.update(accruals).set({ login }).where(eq(accruals.login, mine.login));
      await tx.update(payoutItems).set({ login }).where(eq(payoutItems.login, mine.login));
    } else if (!mine && named) {
      await tx.update(maintainers).set({ githubId: user.id }).where(eq(maintainers.login, login));
    } else if (!mine) {
      await tx.insert(maintainers).values({ login, githubId: user.id });
    }
    return { ok: true, session: await createMaintainerSession(tx, user.id, now) };
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
