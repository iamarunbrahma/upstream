import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { describeRun, runSettlement, settlementDeps } from "../lib/funding/run";
import { PayPalError } from "../lib/paypal/client";
import { FakePayPal } from "../lib/paypal/fake";
import type { Deps } from "../lib/receipts/service";
import type { GithubGet } from "../lib/resolver/recipients";
import { settlementWorld } from "./settle-fixtures";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
const { POST: settleNow } = await import("../app/api/settle/route");

describe("runSettlement", () => {
  it("catches up on payout statuses, settles, then sends, and says what happened in plain words", async () => {
    const w = await settlementWorld();
    const f = await w.funder(1350);
    await w.receipt(f, { a: 6000, b: 4000 });
    await w.receipt(f, { a: 10_000 });
    await w.claim("alice", "PAYER-ALICE", 8);
    const first = await runSettlement(w.deps);
    expect(first).toMatchObject({ settledFunders: 1, setAsideCents: 1350, payoutLines: 1, queuedCents: 540, reconciledLines: 0 });
    expect(first.sent).toMatchObject([{ outcome: "sent" }]);
    expect(describeRun(first)).toEqual([
      "Settled 1 developer's budget: $13.50 set aside for open-source maintainers.",
      "Put $5.40 on 1 payout line.",
      "PayPal took the payout batch.",
    ]);
    const line = [...w.paypal.payoutBatches.values()][0]!.items[0]!;
    w.paypal.setPayoutItemStatus(line.payout_item!.sender_item_id!, "SUCCESS");
    const second = await runSettlement(w.deps);
    expect(second.reconciledLines).toBe(1);
    expect(describeRun(second)).toEqual(["Checked 1 payout line with PayPal.", "Nothing new to settle."]);
  });
});

describe("runSettlement when PayPal can't be reached", () => {
  it("still settles everyone else, and says which check has to wait", async () => {
    const w = await settlementWorld();
    const early = await w.funder(1000);
    await w.receipt(early, { b: 10_000 });
    await w.claim("carol", "PAYER-CAROL", 8);
    await runSettlement(w.deps);
    const later = await w.funder(700);
    await w.receipt(later, { a: 10_000 });
    w.paypal.failNext("getPayoutBatch", new PayPalError(503, "SERVICE_UNAVAILABLE", "try later", null));
    const r = await runSettlement(w.deps);
    expect(r).toMatchObject({ uncheckedBatches: 1, settledFunders: 1, setAsideCents: 700 });
    expect(describeRun(r)[0]).toBe("Couldn't reach PayPal to check 1 payout batch. It will be checked on the next run.");
  });
});

describe("describeRun", () => {
  it("says plainly when a batch is too old to send again safely", () => {
    const quiet = { settlementId: "s", expiredReceipts: 0, settledFunders: 0, waitingFunders: 0, setAsideCents: 0, returnedCents: 0, payoutLines: 0, queuedCents: 0, reconciledLines: 0, uncheckedBatches: 0 };
    expect(describeRun({ ...quiet, sent: [{ settlementId: "s", outcome: "needs-check" }] })).toEqual([
      "A payout batch may already have gone out, and it's too old to send again safely. Check it in PayPal before paying anyone by hand.",
    ]);
  });
});

describe("settlementDeps", () => {
  it("finds a package's repo through the registry and its people through GitHub", async () => {
    const db = createPgliteDb();
    await migrateDb(db, "pglite");
    const http = async (url: string) =>
      url.includes("pypi.org/pypi/widget/json")
        ? { status: 200, body: { info: { summary: "Widgets", project_urls: { Source: "https://github.com/Acme/Widget" } } } }
        : { status: 404, body: null };
    const gh: GithubGet = async (path) =>
      path.startsWith("/repos/acme/widget/commits") ? { status: 200, body: [{ author: { login: "alice", type: "User" } }] } : { status: 404, body: null };
    const deps = settlementDeps({ db, http, model: null, paypal: new FakePayPal() } as unknown as Deps & { paypal: FakePayPal }, gh);
    const repo = await deps.repoFor("pypi", "widget");
    expect(repo).toEqual({ owner: "acme", name: "widget" });
    if (!repo || repo === "later") throw new Error("expected a repo");
    expect(await deps.recipients(repo)).toEqual({ source: "committers", recipients: [{ login: "alice", shareBp: 10_000 }] });
    expect(await deps.repoFor("pypi", "missing")).toBeNull();
    const down = settlementDeps({ db, http: async () => ({ status: 503, body: null }), model: null, paypal: new FakePayPal() } as unknown as Deps & { paypal: FakePayPal }, gh);
    expect(await down.repoFor("pypi", "never-seen")).toBe("later");
  });
});

describe("POST /api/settle", () => {
  beforeEach(async () => {
    const db = createPgliteDb();
    await migrateDb(db, "pglite");
    h.deps = { db, http: async () => ({ status: 404, body: null }), model: null, paypal: new FakePayPal() } as unknown as Deps;
    process.env.SETTLE_TOKEN = "settle-secret";
  });
  afterEach(() => {
    delete process.env.SETTLE_TOKEN;
  });
  const call = (token?: string) =>
    settleNow(new Request("http://up.test/api/settle", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} }));

  it("runs a settlement only for someone holding the settle token", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("wrong")).status).toBe(401);
    const ok = await call("settle-secret");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { summary: string[] }).summary).toEqual(["Nothing new to settle."]);
  });

  it("is switched off when no settle token is set", async () => {
    delete process.env.SETTLE_TOKEN;
    expect((await call("settle-secret")).status).toBe(401);
  });
});
