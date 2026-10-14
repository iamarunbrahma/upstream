import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { accruals, receiptItems, receipts } from "../lib/db/schema";
import { recordFunding } from "../lib/funding/ledger";
import { settle } from "../lib/funding/settle";

/**
 * PGlite runs one transaction at a time, so only real Postgres can show two settlement runs overlapping.
 * TEST_DATABASE_URL must point at a throwaway database: this test wipes its public schema.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("settle on Postgres", () => {
  it("spends a budget once when two runs overlap", async () => {
    const db = createPgDb(url!);
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await db.execute(sql`create schema public`);
    await migrateDb(db, "pg");
    const { accountId } = await createDevice(db, null);
    await recordFunding(db, { accountId, source: "topup", paypalId: "CAP-PG", amountCents: 1000, payerId: null, occurredAt: new Date(), raw: null });
    const [r] = await db
      .insert(receipts)
      .values({ accountId, sessionId: "s-pg", agent: "claude-code", endedAt: new Date(), status: "approved", source: "ai", promptVersion: "judge-v2" })
      .returning({ id: receipts.id });
    await db.insert(receiptItems).values({
      receiptId: r!.id,
      ecosystem: "npm",
      name: "b",
      weightBp: 10_000,
      role: "feature",
      reason: "test",
      evidence: { ecosystem: "npm", name: "b", installed: true, manifestAdded: false, importFiles: 1, usageLines: 1, docsReads: 0, kind: "dependency", description: null },
    });
    const deps = {
      db,
      repoFor: async () => ({ owner: "o", name: "b" }),
      recipients: async () => ({ source: "committers" as const, recipients: [{ login: "carol", shareBp: 10_000 }] }),
    };
    await Promise.all([settle(deps), settle(deps), settle(deps)]);
    const [row] = await db.select({ total: sql<string>`coalesce(sum(${accruals.cents}), 0)` }).from(accruals).where(eq(accruals.funderId, accountId));
    expect(Number(row!.total)).toBe(1000);
  }, 240_000); // a remote database answers each of the many migration statements over the network
});
