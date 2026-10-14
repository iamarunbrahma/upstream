import { desc, eq, sql } from "drizzle-orm";
import { receipts, subscriptions } from "../../../lib/db/schema";
import { isDemoAccount } from "../../../lib/demo/accounts";
import { balanceCents, givenCents } from "../../../lib/funding/ledger";
import { getSettings } from "../../../lib/funding/settings";
import { givenLines, projectSplit } from "../../../lib/funding/view";
import { json, withAccount } from "../../../lib/http";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  return withAccount(req, async (deps, accountId) => {
    const [subscription] = await deps.db
      .select({ id: subscriptions.id, tier: subscriptions.tier, status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId))
      // A live subscription wins over an abandoned attempt that changed later, so we never invite a second one.
      .orderBy(sql`case ${subscriptions.status} when 'ACTIVE' then 0 when 'APPROVED' then 1 when 'SUSPENDED' then 2 else 3 end`, desc(subscriptions.updatedAt))
      .limit(1);
    const counts = await deps.db
      .select({ status: receipts.status, n: sql<string>`count(*)` })
      .from(receipts)
      .where(eq(receipts.accountId, accountId))
      .groupBy(receipts.status);
    return json({
      balanceCents: await balanceCents(deps.db, accountId),
      givenCents: await givenCents(deps.db, accountId),
      subscription: subscription ?? null,
      autoApprove: (await getSettings(deps.db, accountId)).autoApprove,
      receipts: { proposed: 0, approved: 0, skipped: 0, ...Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) },
      paymentsReady: Boolean(deps.paypal),
      demo: await isDemoAccount(deps.db, accountId),
      projection: await projectSplit(deps.db, accountId),
      given: await givenLines(deps.db, accountId),
    });
  });
}
