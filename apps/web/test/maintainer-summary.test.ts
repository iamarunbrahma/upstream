import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb, type Db } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { accruals, payoutItems, receiptItems, receipts, settlements } from "../lib/db/schema";
import { linkPayPal, signInMaintainer } from "../lib/maintainers/claims";
import { MAINTAINER_COOKIE } from "../lib/maintainers/sessions";
import { maintainerSummary } from "../lib/maintainers/summary";
import type { Deps } from "../lib/receipts/service";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
const { GET: getMine } = await import("../app/api/maintainer/me/route");

const OCT = new Date("2026-10-14T10:00:00Z");
const SEP = new Date("2026-09-20T10:00:00Z");
let db: Db;
let session: string;
beforeEach(async () => {
  db = createPgliteDb();
  await migrateDb(db, "pglite");
  h.deps = { db, http: async () => ({ status: 404, body: null }), model: null } as unknown as Deps;
  session = await signInMaintainer(db, { id: 7, login: "alice" }, OCT);
});

async function money() {
  const { accountId } = await createDevice(db, null);
  const [s] = await db.insert(settlements).values({}).returning();
  const [line] = await db.insert(payoutItems).values({ settlementId: s!.id, login: "alice", githubId: 7, payerId: "P-A", cents: 700, status: "SUCCESS", updatedAt: OCT }).returning();
  // Someone else's payout filed under the same login "alice" (an earlier holder of the name).
  await db.insert(payoutItems).values({ settlementId: s!.id, login: "alice", githubId: 99, payerId: "P-X", cents: 999, status: "SUCCESS", updatedAt: OCT });
  const owed = { settlementId: s!.id, funderId: accountId, login: "alice", githubId: 7, ecosystem: "npm" as const };
  await db.insert(accruals).values([
    { ...owed, name: "left-pad", cents: 700, status: "paid", payoutItemId: line!.id, createdAt: SEP },
    { ...owed, name: "left-pad", cents: 250, status: "queued", createdAt: OCT },
    { ...owed, name: "right-pad", cents: 120, status: "held", createdAt: OCT },
    { ...owed, name: "right-pad", cents: 999, status: "returned", returnReason: "unclaimed", createdAt: OCT },
    { ...owed, login: "bob", githubId: 8, name: "left-pad", cents: 50, createdAt: OCT },
    { ...owed, githubId: null, name: "left-pad", cents: 30, createdAt: OCT },
    { ...owed, login: "alice", githubId: 99, name: "left-pad", cents: 40, createdAt: OCT },
    { ...owed, login: "alice-before-rename", githubId: 7, name: "right-pad", cents: 5, createdAt: OCT },
  ]);
  const [r] = await db
    .insert(receipts)
    .values({ accountId, sessionId: "s1", agent: "claude-code", endedAt: OCT, status: "approved", source: "ai", promptVersion: "judge-v2" })
    .returning();
  const ev = (name: string) => ({ ecosystem: "npm" as const, name, installed: true, manifestAdded: false, importFiles: 1, usageLines: 1, docsReads: 0, kind: "dependency" as const, description: null });
  await db.insert(receiptItems).values([
    { receiptId: r!.id, ecosystem: "npm", name: "left-pad", weightBp: 6000, role: "foundation", reason: "x", evidence: ev("left-pad") },
    { receiptId: r!.id, ecosystem: "npm", name: "right-pad", weightBp: 4000, role: "helper", reason: "x", evidence: ev("right-pad") },
  ]);
}

describe("maintainerSummary", () => {
  it("shows what's waiting, on its way and paid, by month and by package, never counting money given back", async () => {
    await money();
    expect(await maintainerSummary(db, { login: "alice", githubId: 7 })).toEqual({
      login: "alice",
      paypal: { linked: false, firstPayoutFrom: null },
      cents: { waiting: 125, onItsWay: 250, paid: 700 },
      months: [
        { month: "2026-10", setAsideCents: 375 },
        { month: "2026-09", setAsideCents: 700 },
      ],
      payouts: [{ date: "2026-10-14", cents: 700, status: "SUCCESS" }],
      packages: [
        { ecosystem: "npm", name: "left-pad", cents: 950, roles: { foundation: 1 } },
        { ecosystem: "npm", name: "right-pad", cents: 125, roles: { helper: 1 } },
      ],
    });
  });

  it("says when the first payout can go out once PayPal is linked", async () => {
    await linkPayPal(db, 7, { payerId: "P-A", verified: true }, OCT);
    expect((await maintainerSummary(db, { login: "alice", githubId: 7 })).paypal).toEqual({ linked: true, firstPayoutFrom: "2026-10-21" });
  });
});

describe("GET /api/maintainer/me", () => {
  it("answers only a signed-in maintainer", async () => {
    expect((await getMine(new Request("http://up.test/api/maintainer/me"))).status).toBe(401);
    const res = await getMine(new Request("http://up.test/api/maintainer/me", { headers: { cookie: `${MAINTAINER_COOKIE}=${session}` } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { login: string }).login).toBe("alice");
  });
});
