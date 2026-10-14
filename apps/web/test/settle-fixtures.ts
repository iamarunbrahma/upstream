import { eq, sql } from "drizzle-orm";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { accruals, maintainers, receiptItems, receipts, type RepoRecipients } from "../lib/db/schema";
import { recordFunding } from "../lib/funding/ledger";
import { FakePayPal } from "../lib/paypal/fake";

export const NOW = new Date("2026-10-14T10:00:00Z");
export const DAY = 86_400_000;
/** The GitHub accounts behind the fixture's logins. */
export const GITHUB_IDS: Record<string, number> = { alice: 101, bob: 102, carol: 103 };

/**
 * A database, a fake PayPal and fake package lookups for settlement tests.
 * npm "a" is paid to alice and bob in halves; npm "b" all to carol. Set `lookups[...]` to change that.
 */
export async function settlementWorld() {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  const paypal = new FakePayPal();
  const lookups: Record<string, RepoRecipients | "later" | null> = {
    "npm:a": { source: "funding", recipients: [{ login: "alice", githubId: 101, shareBp: 5000 }, { login: "bob", githubId: 102, shareBp: 5000 }] },
    "npm:b": { source: "committers", recipients: [{ login: "carol", githubId: 103, shareBp: 10_000 }] },
  };
  /** Packages whose registry can't be reached right now. */
  const registryDown = new Set<string>();
  let clock = NOW;
  let seq = 0;
  const deps = {
    db,
    paypal,
    repoFor: async (ecosystem: string, name: string) =>
      registryDown.has(`${ecosystem}:${name}`) ? ("later" as const) : lookups[`${ecosystem}:${name}`] === null ? null : { owner: ecosystem, name },
    recipients: async (repo: { owner: string; name: string }) => lookups[`${repo.owner}:${repo.name}`] ?? { source: "none" as const, recipients: [] },
    now: () => clock,
    minPayoutCents: undefined as number | undefined,
  };

  const fund = (accountId: string, cents: number, payerId: string | null = null) =>
    recordFunding(db, { accountId, source: "topup", paypalId: `CAP-${++seq}`, amountCents: cents, payerId, occurredAt: clock, raw: null });

  return {
    db,
    paypal,
    lookups,
    registryDown,
    deps,
    fund,
    /** Move the clock to `days` after NOW. */
    at: (days: number) => {
      clock = new Date(NOW.getTime() + days * DAY);
    },
    async funder(cents: number, payerId: string | null = null) {
      const { accountId } = await createDevice(db, null);
      if (cents > 0) await fund(accountId, cents, payerId);
      return accountId;
    },
    /** A receipt with these package weights (basis points, adding up to 10000). */
    async receipt(accountId: string, weights: Record<string, number>, status: "approved" | "proposed" = "approved", createdAt = clock) {
      const [r] = await db
        .insert(receipts)
        .values({ accountId, sessionId: `s-${++seq}`, agent: "claude-code", endedAt: createdAt, status, source: "ai", promptVersion: "judge-v2", createdAt })
        .returning({ id: receipts.id });
      await db.insert(receiptItems).values(
        Object.entries(weights).map(([name, weightBp]) => ({
          receiptId: r!.id,
          ecosystem: "npm" as const,
          name,
          weightBp,
          role: "feature",
          reason: "test",
          evidence: { ecosystem: "npm" as const, name, installed: true, manifestAdded: false, importFiles: 1, usageLines: 1, docsReads: 0, kind: "dependency" as const, description: null },
        })),
      );
      return r!.id;
    },
    /** A maintainer who signed in and linked this PayPal account `daysAgo` days before the current clock. */
    claim: (login: string, payerId: string, daysAgo: number) =>
      db.insert(maintainers).values({ login, githubId: GITHUB_IDS[login], paypalPayerId: payerId, claimedAt: new Date(clock.getTime() - daysAgo * DAY) }),
    /** Cents set aside from this funder, per maintainer and status. */
    async owed(funderId: string, status?: "held" | "queued" | "paid" | "returned") {
      const rows = await db
        .select({ login: accruals.login, status: accruals.status, cents: sql<number>`sum(${accruals.cents})::int` })
        .from(accruals)
        .where(eq(accruals.funderId, funderId))
        .groupBy(accruals.login, accruals.status);
      const out: Record<string, number> = {};
      for (const r of rows) if (!status || r.status === status) out[r.login] = (out[r.login] ?? 0) + r.cents;
      return out;
    },
  };
}
