import { beforeEach, describe, expect, it } from "vitest";
import { createDevice } from "../lib/auth";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import type { JudgeModel } from "../lib/judge/types";
import { decideReceipt, getReceipt, listReceipts, submitReceipt, type Deps } from "../lib/receipts/service";
import { formatPercent } from "../lib/receipts/view";
import { ev, fakeRegistry, payload } from "./helpers";

let deps: Deps;
let account: string;

beforeEach(async () => {
  const db = createPgliteDb();
  await migrateDb(db, "pglite");
  deps = { db, http: fakeRegistry, model: null };
  account = (await createDevice(db, null)).accountId;
});

describe("submitReceipt", () => {
  it("stores a receipt summing to 10000 bp, matching docs reads to the package's docs host", async () => {
    const { view, changed } = await submitReceipt(deps, account, payload());
    expect(changed).toBe(true);
    expect(view.status).toBe("proposed");
    expect(view.source).toBe("fallback");
    expect(view.items.reduce((s, i) => s + i.weightBp, 0)).toBe(10000);
    const fastapi = view.items.find((i) => i.name === "fastapi")!;
    expect(fastapi.evidence).toMatchObject({ docsReads: 2, description: "FastAPI framework" });
    expect(view.items.find((i) => i.name === "pydantic")!.evidence.docsReads).toBe(0);
    expect(view.items[0]!.name).toBe("fastapi");
  });

  it("uses the model when it returns valid output and stores the raw output", async () => {
    const raw = JSON.stringify({ packages: [
      { package: "fastapi", weight: 80, role: "foundation", reason: "Your whole API layer is built on it." },
      { package: "pydantic", weight: 20, role: "feature", reason: "Every request model." },
    ] });
    const model: JudgeModel = { id: "fake-model", generate: async () => raw };
    const { view } = await submitReceipt({ ...deps, model }, account, payload());
    expect(view).toMatchObject({ source: "ai", modelId: "fake-model", promptVersion: "judge-v1" });
    expect(view.items[0]).toMatchObject({ name: "fastapi", role: "foundation", percent: "79.4%" });
  });

  it("updates one receipt while proposed and never touches it once decided", async () => {
    const first = await submitReceipt(deps, account, payload());
    const second = await submitReceipt(deps, account, payload({ packages: [...payload().packages, ev("httpx")] }));
    expect(second.view.id).toBe(first.view.id);
    expect(second.changed).toBe(true);
    expect(second.view.items).toHaveLength(3);

    await decideReceipt(deps, account, first.view.id, "approve");
    const third = await submitReceipt(deps, account, payload({ packages: [ev("pydantic")] }));
    expect(third.changed).toBe(false);
    expect(third.view.id).toBe(first.view.id);
    expect(third.view.status).toBe("approved");
    expect(third.view.items).toHaveLength(3);
  });

  it("keeps packages that no registry knows, with an empty description", async () => {
    const { view } = await submitReceipt(deps, account, payload({ packages: [ev("fastapi"), ev("fastapy-typo")] }));
    expect(view.items.map((i) => i.name).sort()).toEqual(["fastapi", "fastapy-typo"]);
    expect(view.items.find((i) => i.name === "fastapy-typo")!.evidence.description).toBeNull();
  });

  it("accepts a session with no packages", async () => {
    const { view } = await submitReceipt(deps, account, payload({ packages: [] }));
    expect(view.items).toEqual([]);
  });
});

describe("decide, get and list", () => {
  it("approves once; a later skip doesn't flip it", async () => {
    const { view } = await submitReceipt(deps, account, payload());
    expect((await decideReceipt(deps, account, view.id, "approve"))!.status).toBe("approved");
    expect((await decideReceipt(deps, account, view.id, "skip"))!.status).toBe("approved");
  });

  it("keeps accounts apart", async () => {
    const { view } = await submitReceipt(deps, account, payload());
    const other = (await createDevice(deps.db, null)).accountId;
    expect(await getReceipt(deps, other, view.id)).toBeNull();
    expect(await decideReceipt(deps, other, view.id, "approve")).toBeNull();
    expect(await listReceipts(deps, other)).toEqual([]);
  });

  it("filters the list by status", async () => {
    const a = await submitReceipt(deps, account, payload({ sessionId: "a" }));
    await submitReceipt(deps, account, payload({ sessionId: "b" }));
    await decideReceipt(deps, account, a.view.id, "approve");
    expect((await listReceipts(deps, account, "proposed")).map((r) => r.sessionId)).toEqual(["b"]);
    expect(await listReceipts(deps, account)).toHaveLength(2);
  });
});

describe("formatPercent", () => {
  it("shows whole numbers without decimals", () => {
    expect(formatPercent(10000)).toBe("100%");
    expect(formatPercent(100)).toBe("1%");
    expect(formatPercent(4630)).toBe("46.3%");
  });
});
