import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { accruals, settlements, subscriptions } from "../lib/db/schema";
import { recordFunding } from "../lib/funding/ledger";
import { getSettings, setAutoApprove } from "../lib/funding/settings";
import { submitReceipt, type Deps } from "../lib/receipts/service";
import { createSession, SESSION_COOKIE } from "../lib/web-auth";
import { fakeRegistry, payload } from "./helpers";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
const { GET: getMe } = await import("../app/api/me/route");
const { PATCH: patchSettings } = await import("../app/api/settings/route");

beforeEach(async () => {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  h.deps = { db, http: fakeRegistry, model: null };
});

/** A settlement set `cents` of this funder's budget aside for a maintainer. */
async function setAside(accountId: string, cents: number) {
  const [s] = await h.deps.db.insert(settlements).values({}).returning();
  await h.deps.db.insert(accruals).values({ settlementId: s!.id, funderId: accountId, login: "alice", ecosystem: "pypi", name: "fastapi", cents });
}

const fund = (accountId: string, cents: number) =>
  recordFunding(h.deps.db, { accountId, source: "topup", paypalId: `CAP-${accountId}`, amountCents: cents, payerId: null, occurredAt: new Date(), raw: null });

describe("auto-approve", () => {
  it("leaves receipts waiting when it's off", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    await fund(accountId, 500);
    expect((await submitReceipt(h.deps, accountId, payload())).view.status).toBe("proposed");
  });

  it("waits while the budget is empty, even when it's on", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    await setAutoApprove(h.deps.db, accountId, true);
    expect((await submitReceipt(h.deps, accountId, payload())).view.status).toBe("proposed");
  });

  it("waits once a settlement has set the whole budget aside", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    await setAutoApprove(h.deps.db, accountId, true);
    await fund(accountId, 500);
    await setAside(accountId, 500);
    expect((await submitReceipt(h.deps, accountId, payload())).view.status).toBe("proposed");
  });

  it("approves receipts by itself when it's on and there is money in the budget", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    await setAutoApprove(h.deps.db, accountId, true);
    await fund(accountId, 500);
    expect((await submitReceipt(h.deps, accountId, payload())).view.status).toBe("approved");
    expect(await getSettings(h.deps.db, accountId)).toEqual({ autoApprove: true });
  });
});

describe("dashboard API", () => {
  it("summarises the budget, subscription, setting and receipts", async () => {
    const { accountId, token } = await createDevice(h.deps.db, null);
    await fund(accountId, 916);
    await submitReceipt(h.deps, accountId, payload());
    const res = await getMe(new Request("http://up.test/api/me", { headers: { authorization: `Bearer ${token}` } }));
    expect(await res.json()).toEqual({
      balanceCents: 916,
      givenCents: 0,
      subscription: null,
      autoApprove: false,
      receipts: { proposed: 1, approved: 0, skipped: 0 },
      paymentsReady: false,
      demo: false,
      projection: [],
      given: [],
    });
  });

  it("shows the budget left after what settlements set aside for maintainers", async () => {
    const { accountId, token } = await createDevice(h.deps.db, null);
    await fund(accountId, 1000);
    await setAside(accountId, 400);
    const res = await getMe(new Request("http://up.test/api/me", { headers: { authorization: `Bearer ${token}` } }));
    expect(await res.json()).toMatchObject({ balanceCents: 600, givenCents: 400 });
  });

  it("shows the active subscription even when an abandoned one changed more recently", async () => {
    const { accountId, token } = await createDevice(h.deps.db, null);
    await h.deps.db.insert(subscriptions).values([
      { id: "I-ACTIVE", accountId, tier: "starter", status: "ACTIVE", updatedAt: new Date("2026-10-14T10:00:00Z") },
      { id: "I-ABANDONED", accountId, tier: "builder", status: "APPROVAL_PENDING", updatedAt: new Date("2026-10-14T11:00:00Z") },
    ]);
    const res = await getMe(new Request("http://up.test/api/me", { headers: { authorization: `Bearer ${token}` } }));
    expect(((await res.json()) as { subscription: unknown }).subscription).toEqual({ id: "I-ACTIVE", tier: "starter", status: "ACTIVE" });
  });

  it("changes the setting from the dashboard, but not from another site", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    const cookie = `${SESSION_COOKIE}=${await createSession(h.deps.db, accountId)}`;
    const patch = (origin: string) =>
      patchSettings(
        new Request("http://up.test/api/settings", {
          method: "PATCH",
          headers: { cookie, origin, host: "up.test", "content-type": "application/json" },
          body: JSON.stringify({ autoApprove: true }),
        }),
      );
    expect((await patch("https://evil.example")).status).toBe(403);
    expect(await getSettings(h.deps.db, accountId)).toEqual({ autoApprove: false });
    expect(await (await patch("http://up.test")).json()).toEqual({ autoApprove: true });
  });
});
