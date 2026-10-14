import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { accountSettings, fundingEvents, loginCodes, subscriptions, webhookEvents, webSessions } from "../lib/db/schema";

describe("funding tables", () => {
  it("are created by migrations and enforce one row per PayPal id", async () => {
    const db = createPgliteDb();
    await migrateDb(db, "pglite");
    const { accountId } = await createDevice(db, null);
    const later = new Date(Date.now() + 60_000);
    await db.insert(webSessions).values({ idHash: "s", accountId, expiresAt: later });
    await db.insert(loginCodes).values({ codeHash: "c", accountId, expiresAt: later });
    await db.insert(subscriptions).values({ id: "I-1", accountId, tier: "starter", status: "APPROVAL_PENDING" });
    await db.insert(webhookEvents).values({ id: "WH-1", eventType: "X", outcome: "ignored" });
    await db.insert(accountSettings).values({ accountId });
    const event = { paypalId: "SALE-1", accountId, source: "subscription" as const, amountCents: 453, occurredAt: new Date() };
    await db.insert(fundingEvents).values(event);
    await expect(db.insert(fundingEvents).values(event)).rejects.toThrow();
    const [settings] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, accountId));
    expect(settings!.autoApprove).toBe(false);
  });
});
