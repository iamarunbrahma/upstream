import { describe, expect, it } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { accruals, fundingEvents, maintainers, payoutItems, settlements } from "../lib/db/schema";
import { balanceCents, recordFunding } from "../lib/funding/ledger";

async function setup() {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  const { accountId } = await createDevice(db, null);
  const [s] = await db.insert(settlements).values({}).returning();
  return { db, accountId, settlementId: s!.id };
}
const accrual = (settlementId: string, funderId: string, cents: number, status: "held" | "queued" | "paid" | "returned") =>
  ({ settlementId, funderId, login: "alice", ecosystem: "npm" as const, name: "left-pad", cents, status });

describe("settlement tables", () => {
  it("are created by migrations, with one maintainer per PayPal account", async () => {
    const { db } = await setup();
    await db.insert(maintainers).values({ login: "alice", paypalPayerId: "PAYER-1" });
    await expect(db.insert(maintainers).values({ login: "bob", paypalPayerId: "PAYER-1" })).rejects.toThrow();
  });
});

describe("balanceCents", () => {
  it("is the money put in, less refunds and what settlements set aside, counting returned money back", async () => {
    const { db, accountId, settlementId } = await setup();
    await recordFunding(db, { accountId, source: "topup", paypalId: "CAP-1", amountCents: 1000, payerId: null, occurredAt: new Date(), raw: null });
    await db.insert(fundingEvents).values({ paypalId: "REF-1", accountId, source: "refund", refundOf: "CAP-1", amountCents: -150, occurredAt: new Date() });
    await db.insert(accruals).values([
      accrual(settlementId, accountId, 300, "held"),
      accrual(settlementId, accountId, 200, "paid"),
      accrual(settlementId, accountId, 50, "queued"),
      accrual(settlementId, accountId, 100, "returned"),
    ]);
    expect(await balanceCents(db, accountId)).toBe(1000 - 150 - 300 - 200 - 50);
  });

  it("is zero for a new account", async () => {
    const { db, accountId } = await setup();
    expect(await balanceCents(db, accountId)).toBe(0);
  });

  it("links a payout line to its settlement", async () => {
    const { db, settlementId } = await setup();
    const [item] = await db.insert(payoutItems).values({ settlementId, login: "alice", payerId: "PAYER-1", cents: 500 }).returning();
    expect(item!.status).toBe("PENDING");
  });
});
