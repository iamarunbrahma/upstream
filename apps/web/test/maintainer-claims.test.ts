import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb, type Db } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { accruals, maintainers, payoutItems, settlements } from "../lib/db/schema";
import { linkPayPal, signInMaintainer } from "../lib/maintainers/claims";
import { maintainerForSession } from "../lib/maintainers/sessions";

const NOW = new Date("2026-10-14T10:00:00Z");
const DAY = 86_400_000;
let db: Db;
beforeEach(async () => {
  db = createPgliteDb();
  await migrateDb(db, "pglite");
});
const row = async (githubId: number) => (await db.select().from(maintainers).where(eq(maintainers.githubId, githubId)))[0];

describe("signInMaintainer", () => {
  it("signs a maintainer in by their GitHub account, creating them once", async () => {
    const first = await signInMaintainer(db, { id: 7, login: "Alice" }, NOW);
    const again = await signInMaintainer(db, { id: 7, login: "alice" }, NOW);
    if (!first.ok || !again.ok) throw new Error("expected sign-ins");
    expect(first.session).not.toBe(again.session);
    expect(await maintainerForSession(db, first.session, NOW)).toEqual({ login: "alice", githubId: 7 });
    expect(await db.select().from(maintainers)).toHaveLength(1);
  });

  it("follows a renamed GitHub login, and moves what they're owed along with it", async () => {
    await signInMaintainer(db, { id: 7, login: "alice" }, NOW);
    const { accountId } = await createDevice(db, null);
    const [s] = await db.insert(settlements).values({}).returning();
    const [line] = await db.insert(payoutItems).values({ settlementId: s!.id, login: "alice", payerId: "P-A", cents: 300 }).returning();
    await db.insert(accruals).values([
      { settlementId: s!.id, funderId: accountId, login: "alice", ecosystem: "npm", name: "a", cents: 500 },
      { settlementId: s!.id, funderId: accountId, login: "alice", ecosystem: "npm", name: "a", cents: 300, status: "paid", payoutItemId: line!.id },
    ]);
    expect((await signInMaintainer(db, { id: 7, login: "Alice-Renamed" }, NOW)).ok).toBe(true);
    expect((await row(7))!.login).toBe("alice-renamed");
    expect((await db.select().from(accruals)).map((a) => a.login)).toEqual(["alice-renamed", "alice-renamed"]);
    expect((await db.select().from(payoutItems))[0]!.login).toBe("alice-renamed");
  });

  it("takes over a sandbox claim made for their login before they signed in", async () => {
    await db.insert(maintainers).values({ login: "carol", paypalPayerId: "P-C", claimedAt: new Date(NOW.getTime() - 8 * DAY) });
    expect((await signInMaintainer(db, { id: 9, login: "carol" }, NOW)).ok).toBe(true);
    expect(await row(9)).toMatchObject({ login: "carol", paypalPayerId: "P-C" });
  });

  it("refuses a login that another GitHub account holds here", async () => {
    await db.insert(maintainers).values({ login: "bob", githubId: 5 });
    expect(await signInMaintainer(db, { id: 6, login: "bob" }, NOW)).toEqual({ ok: false, reason: "taken" });
    await signInMaintainer(db, { id: 8, login: "dan" }, NOW);
    expect(await signInMaintainer(db, { id: 8, login: "bob" }, NOW)).toEqual({ ok: false, reason: "taken" });
    expect((await row(8))!.login).toBe("dan");
  });
});

describe("linkPayPal", () => {
  beforeEach(async () => {
    await signInMaintainer(db, { id: 7, login: "alice" }, NOW);
    await signInMaintainer(db, { id: 8, login: "bob" }, NOW);
  });

  it("links only a verified PayPal account, and starts the first-payout hold", async () => {
    expect(await linkPayPal(db, 7, { payerId: "P-1", verified: false }, NOW)).toBe("not verified");
    expect((await row(7))!.paypalPayerId).toBeNull();
    expect(await linkPayPal(db, 7, { payerId: "P-1", verified: true }, NOW)).toBe("linked");
    expect(await row(7)).toMatchObject({ paypalPayerId: "P-1", claimedAt: NOW });
  });

  it("never links one PayPal account to two maintainers", async () => {
    await linkPayPal(db, 7, { payerId: "P-1", verified: true }, NOW);
    expect(await linkPayPal(db, 8, { payerId: "P-1", verified: true }, NOW)).toBe("used by another maintainer");
    expect((await row(8))!.paypalPayerId).toBeNull();
  });

  it("restarts the hold when the PayPal account changes, but not when it's the same one", async () => {
    await linkPayPal(db, 7, { payerId: "P-1", verified: true }, NOW);
    const later = new Date(NOW.getTime() + 3 * DAY);
    expect(await linkPayPal(db, 7, { payerId: "P-1", verified: true }, later)).toBe("unchanged");
    expect((await row(7))!.claimedAt).toEqual(NOW);
    expect(await linkPayPal(db, 7, { payerId: "P-2", verified: true }, later)).toBe("linked");
    expect(await row(7)).toMatchObject({ paypalPayerId: "P-2", claimedAt: later });
  });
});
