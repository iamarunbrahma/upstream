import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import type { Deps } from "../lib/receipts/service";
import { fakeRegistry, payload } from "./helpers";

const h = vi.hoisted(() => ({ deps: null as unknown as Deps }));
vi.mock("../lib/deps", () => ({ getDeps: async () => h.deps }));

const { POST: postDevice } = await import("../app/api/devices/route");
const { POST: postReceipt, GET: listGet } = await import("../app/api/receipts/route");
const { GET: getOne } = await import("../app/api/receipts/[id]/route");
const { POST: postDecision } = await import("../app/api/receipts/[id]/decision/route");

const req = (url: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
  new Request(`http://test${url}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function newToken(): Promise<string> {
  const res = await postDevice(req("/api/devices", { method: "POST", body: { label: "test" } }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

beforeEach(async () => {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  h.deps = { db, http: fakeRegistry, model: null };
});

describe("API routes", () => {
  it("rejects missing and unknown tokens", async () => {
    expect((await postReceipt(req("/api/receipts", { method: "POST", body: payload() }))).status).toBe(401);
    expect((await postReceipt(req("/api/receipts", { method: "POST", token: "upk_nope", body: payload() }))).status).toBe(401);
  });

  it("rejects an invalid receipt body", async () => {
    const token = await newToken();
    const res = await postReceipt(req("/api/receipts", { method: "POST", token, body: { sessionId: "" } }));
    expect(res.status).toBe(400);
  });

  it("submits, lists, approves and fetches a receipt", async () => {
    const token = await newToken();
    const submitted = await postReceipt(req("/api/receipts", { method: "POST", token, body: payload() }));
    expect(submitted.status).toBe(200);
    const { receipt, changed } = (await submitted.json()) as { receipt: { id: string }; changed: boolean };
    expect(changed).toBe(true);

    const listed = (await (await listGet(req("/api/receipts?status=proposed", { token }))).json()) as { receipts: unknown[] };
    expect(listed.receipts).toHaveLength(1);

    const decided = await postDecision(req(`/api/receipts/${receipt.id}/decision`, { method: "POST", token, body: { action: "approve" } }), params(receipt.id));
    expect(((await decided.json()) as { receipt: { status: string } }).receipt.status).toBe("approved");

    expect((await getOne(req(`/api/receipts/${receipt.id}`, { token }), params(receipt.id))).status).toBe(200);
  });

  it("returns 404 for another account's receipt and for a malformed id", async () => {
    const owner = await newToken();
    const other = await newToken();
    const { receipt } = (await (await postReceipt(req("/api/receipts", { method: "POST", token: owner, body: payload() }))).json()) as { receipt: { id: string } };
    expect((await getOne(req(`/api/receipts/${receipt.id}`, { token: other }), params(receipt.id))).status).toBe(404);
    expect((await getOne(req("/api/receipts/not-a-uuid", { token: owner }), params("not-a-uuid"))).status).toBe(404);
  });

  it("rejects an unknown decision action", async () => {
    const token = await newToken();
    const { receipt } = (await (await postReceipt(req("/api/receipts", { method: "POST", token, body: payload() }))).json()) as { receipt: { id: string } };
    const res = await postDecision(req(`/api/receipts/${receipt.id}/decision`, { method: "POST", token, body: { action: "pay-me" } }), params(receipt.id));
    expect(res.status).toBe(400);
  });
});
