import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { receiptItems, receipts, recipientCache } from "../lib/db/schema";
import { isDemoAccount } from "../lib/demo/accounts";
import { describeSettleNow } from "../lib/demo/settle-now";
import { recordFunding } from "../lib/funding/ledger";
import { FakePayPal } from "../lib/paypal/fake";
import { createRateLimiter } from "../lib/limits";
import type { Deps } from "../lib/receipts/service";
import { accountForSession, createSession, SESSION_COOKIE } from "../lib/web-auth";
import { fakeRegistry } from "./helpers";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
const { POST: startDemo } = await import("../app/demo/start/route");
const { GET: getMe } = await import("../app/api/me/route");
const { POST: settleNow } = await import("../app/api/demo/settle/route");

const start = (origin = "http://up.test", ip = "203.0.113.7") =>
  startDemo(new Request("http://up.test/demo/start", { method: "POST", headers: { origin, host: "up.test", "x-forwarded-for": ip } }));
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;
const me = async (cookie: string) => (await getMe(new Request("http://up.test/api/me", { headers: { cookie } }))).json() as Promise<{ demo: boolean }>;

beforeEach(async () => {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  h.deps = { db, http: fakeRegistry, model: null, demoStartLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }) };
  process.env.DEMO_MODE = "1";
});
afterEach(() => {
  delete process.env.DEMO_MODE;
});

describe("Try the demo", () => {
  it("gives each visitor a fresh demo account, signed in, and sends them to the dashboard", async () => {
    const first = await start();
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/dashboard");
    expect(cookieOf(first).startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(await me(cookieOf(first))).toMatchObject({ demo: true });

    const second = await start();
    expect(cookieOf(second)).not.toBe(cookieOf(first));
  });

  it("is off unless the server runs the demo", async () => {
    delete process.env.DEMO_MODE;
    expect((await start()).status).toBe(404);
  });

  it("refuses a request another site started", async () => {
    expect((await start("https://evil.example")).status).toBe(403);
  });

  it("limits how many demo accounts one address can make", async () => {
    expect((await start()).status).toBe(303);
    expect((await start()).status).toBe(303);
    expect((await start()).status).toBe(429);
    expect((await start("http://up.test", "198.51.100.9")).status).toBe(303);
  });

  it("never treats a real account as a demo account", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    expect(await isDemoAccount(h.deps.db, accountId)).toBe(false);
    const res = await start();
    const cookie = cookieOf(res);
    expect(await me(cookie)).toMatchObject({ demo: true });
    delete process.env.DEMO_MODE;
    // A demo account stops being one when the server stops running the demo.
    expect(await me(cookie)).toMatchObject({ demo: false });
  });
});

describe("Settle now", () => {
  /** A registry where pypi "widget" lives at github.com/acme/widget, whose one maintainer is already known. */
  const widgetRegistry = async (url: string) =>
    url.includes("pypi.org/pypi/widget/json")
      ? { status: 200, body: { info: { summary: "Widgets", project_urls: { Source: "https://github.com/acme/widget" } } } }
      : { status: 404, body: null };

  beforeEach(async () => {
    h.deps = { ...h.deps, http: widgetRegistry, paypal: new FakePayPal(), demoSettleLimiter: createRateLimiter({ limit: 3, windowMs: 60_000 }) };
    await h.deps.db.insert(recipientCache).values({
      repo: "acme/widget",
      data: { source: "funding", recipients: [{ login: "alice", githubId: 42, shareBp: 10_000 }] },
      fetchedAt: new Date(),
    });
  });

  const press = (cookie: string, origin = "http://up.test") =>
    settleNow(new Request("http://up.test/api/demo/settle", { method: "POST", headers: { cookie, origin, host: "up.test" } }));
  /** A signed-in demo account: its cookie and its id. */
  const demoFunder = async () => {
    const cookie = cookieOf(await start());
    return { cookie, accountId: (await accountForSession(h.deps.db, cookie.split("=")[1]!))! };
  };
  const approvedReceipt = async (accountId: string) => {
    const [r] = await h.deps.db
      .insert(receipts)
      .values({ accountId, sessionId: "s-1", agent: "claude-code", endedAt: new Date(), status: "approved", source: "ai", promptVersion: "judge-v2" })
      .returning({ id: receipts.id });
    await h.deps.db.insert(receiptItems).values({
      receiptId: r!.id, ecosystem: "pypi", name: "widget", weightBp: 10_000, role: "foundation", reason: "test",
      evidence: { ecosystem: "pypi", name: "widget", installed: true, manifestAdded: false, importFiles: 1, usageLines: 1, docsReads: 0, kind: "dependency", description: null },
    });
  };
  const fund = (accountId: string, cents: number) =>
    recordFunding(h.deps.db, { accountId, source: "topup", paypalId: `CAP-${accountId}`, amountCents: cents, payerId: "BUYER", occurredAt: new Date(), raw: null });

  it("settles the demo account's own budget and says what happened", async () => {
    const { cookie, accountId } = await demoFunder();
    await fund(accountId, 1000);
    await approvedReceipt(accountId);
    const res = await press(cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "settled", summary: ["Set aside $10.00 of your budget for open-source maintainers."] });
  });

  it("describes only the visitor's own budget, never the rest of the server's run", () => {
    const run = {
      settlementId: "s-1", expiredReceipts: 3, settledFunders: 1, waitingFunders: 0, setAsideCents: 500,
      returnedCents: 9999, payoutLines: 1, queuedCents: 120, reconciledLines: 7, uncheckedBatches: 2,
      sent: [{ settlementId: "s-old", outcome: "needs-check" as const }, { settlementId: "s-1", outcome: "sent" as const }],
    };
    expect(describeSettleNow(run)).toEqual({
      outcome: "settled",
      summary: ["Set aside $5.00 of your budget for open-source maintainers.", "$1.20 of it is on its way through PayPal Payouts to 1 maintainer who joined Upstream."],
    });
    // Another run sending this batch at the same moment still means it's on its way.
    expect(describeSettleNow({ ...run, sent: [] }).summary[1]).toBe("$1.20 of it is on its way through PayPal Payouts to 1 maintainer who joined Upstream.");
    expect(describeSettleNow({ ...run, settledFunders: 0, waitingFunders: 1, setAsideCents: 0, payoutLines: 0, queuedCents: 0, sent: [] })).toEqual({
      outcome: "waiting",
      summary: ["GitHub or a package registry is busy, so your budget wasn't settled yet. Please press Settle now again in a minute."],
    });
    expect(describeSettleNow({ ...run, settledFunders: 0, setAsideCents: 0, payoutLines: 0, queuedCents: 0, sent: [] })).toEqual({
      outcome: "nothing",
      summary: ["Nothing new to settle."],
    });
    expect(describeSettleNow({ ...run, setAsideCents: 0, payoutLines: 0, queuedCents: 0 })).toEqual({
      outcome: "kept",
      summary: ["None of these packages has a maintainer Upstream can pay yet, so your budget stays as it is."],
    });
    expect(describeSettleNow({ ...run, sent: [{ settlementId: "s-1", outcome: "failed" as const, error: "x" }] }).summary[1]).toBe(
      "$1.20 of it is ready for 1 maintainer who joined Upstream, but PayPal couldn't take the payout right now. It goes out on the next run.",
    );
  });

  it("says what to do first when there's no money or nothing approved yet", async () => {
    const { cookie, accountId } = await demoFunder();
    const first = await press(cookie);
    expect(first.status).toBe(409);
    expect(((await first.json()) as { error: string }).error).toBe("Add money to your budget first.");
    await fund(accountId, 500);
    const second = await press(cookie);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe("Approve a receipt first. Settling splits your budget across the receipts you approved.");
  });

  it("is only for demo accounts, only on the demo server, and only from this site", async () => {
    const { cookie } = await demoFunder();
    expect((await press(cookie, "https://evil.example")).status).toBe(403);
    delete process.env.DEMO_MODE;
    expect((await press(cookie)).status).toBe(404);
    process.env.DEMO_MODE = "1";
    const { accountId } = await createDevice(h.deps.db, null);
    const real = `${SESSION_COOKIE}=${await createSession(h.deps.db, accountId)}`;
    expect((await press(real)).status).toBe(403);
  });

  it("limits how often one account can press it", async () => {
    const { cookie } = await demoFunder();
    for (let i = 0; i < 3; i++) expect((await press(cookie)).status).toBe(409);
    expect((await press(cookie)).status).toBe(429);
  });
});
