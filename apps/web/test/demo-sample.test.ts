import { ReceiptPayload } from "@upstream/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { receipts } from "../lib/db/schema";
import { createDemoAccount } from "../lib/demo/accounts";
import { samplePayload } from "../lib/demo/sample";
import type { JudgeModel } from "../lib/judge/types";
import { createRateLimiter } from "../lib/limits";
import type { Deps } from "../lib/receipts/service";
import { createSession, SESSION_COOKIE } from "../lib/web-auth";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));
const { POST: runSample } = await import("../app/api/demo/sample-session/route");

/** Answers like a registry that knows every package, without a network. */
const anyRegistry = async () => ({ status: 200, body: { info: { summary: "A package" }, description: "A package" } });
let calls = 0;
const model: JudgeModel = { id: "fake-model", generate: async () => (calls++, JSON.stringify({ packages: [] })) };

beforeEach(async () => {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  calls = 0;
  h.deps = { db, http: anyRegistry, model, demoJudgeLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) };
  process.env.DEMO_MODE = "1";
});
afterEach(() => {
  delete process.env.DEMO_MODE;
});

const cookieFor = async (accountId: string) => `${SESSION_COOKIE}=${await createSession(h.deps.db, accountId)}`;
const press = (cookie: string) =>
  runSample(new Request("http://up.test/api/demo/sample-session", { method: "POST", headers: { cookie, origin: "http://up.test", host: "up.test" } }));
type Answer = { receipt: { id: string; items: Array<{ name: string }> }; changed: boolean };

describe("the sample session", () => {
  it("is the receipt the upstream CLI would build from the recorded Claude Code session", () => {
    const p = samplePayload(new Date("2026-10-14T10:00:00Z"));
    expect(ReceiptPayload.safeParse(p).success).toBe(true);
    expect(p.sessionId.startsWith("sample:")).toBe(true);
    expect(p.agent).toBe("claude-code");
    expect(p.endedAt).toBe("2026-10-14T10:00:00.000Z");
    expect(p.packages.map((x) => x.name)).toEqual(expect.arrayContaining(["hono", "zod", "nanoid", "vitest"]));
  });

  it("runs once per demo account through the real receipt pipeline, and a second press shows the same receipt", async () => {
    const cookie = await cookieFor(await createDemoAccount(h.deps.db));
    const first = await press(cookie);
    expect(first.status).toBe(200);
    const a = (await first.json()) as Answer;
    expect(a.changed).toBe(true);
    expect(a.receipt.items.map((i) => i.name)).toContain("hono");
    const again = (await (await press(cookie)).json()) as Answer;
    expect(again).toMatchObject({ changed: false, receipt: { id: a.receipt.id } });
    const [row] = await h.deps.db.select({ judgeCount: receipts.judgeCount }).from(receipts).where(eq(receipts.id, a.receipt.id));
    expect(row!.judgeCount).toBe(1);
    expect(calls).toBe(1);
  });

  it("asks the AI judge within a daily budget for the whole demo, and estimates without AI past it", async () => {
    await press(await cookieFor(await createDemoAccount(h.deps.db)));
    const second = (await (await press(await cookieFor(await createDemoAccount(h.deps.db)))).json()) as Answer & { receipt: { source: string } };
    expect(calls).toBe(1);
    expect(second.receipt.source).toBe("fallback");
  });

  it("is only for demo accounts, on the demo server", async () => {
    const { accountId } = await createDevice(h.deps.db, null);
    expect((await press(await cookieFor(accountId))).status).toBe(403);
    delete process.env.DEMO_MODE;
    expect((await press(await cookieFor(await createDemoAccount(h.deps.db)))).status).toBe(404);
  });
});
