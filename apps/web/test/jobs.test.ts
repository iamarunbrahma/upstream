import { beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { runTask, type WorkflowClient } from "../lib/jobs/workflows";
import { judgeWith, settleJob } from "../lib/jobs/run";
import type { JudgeModel, JudgeResult } from "../lib/judge/types";
import { FakePayPal } from "../lib/paypal/fake";
import { submitReceipt, type Deps } from "../lib/receipts/service";
import { createDevice } from "../lib/auth";
import { fakeRegistry, payload } from "./helpers";

/** A stand-in for Render's Workflows client: records each run and answers with `answer`. */
function fakeWorkflows(answer: (slug: string, input: unknown[]) => { status: string; results?: unknown[]; error?: string }) {
  const runs: Array<{ slug: string; input: unknown[] }> = [];
  const client: WorkflowClient = {
    startTask: async (slug, input) => {
      runs.push({ slug, input });
      return { get: async () => ({ results: [], ...answer(slug, input) }) };
    },
  };
  return { runs, client };
}

const judged: JudgeResult = {
  allocations: [
    { ecosystem: "pypi", name: "fastapi", weightBp: 7000, role: "foundation", reason: "Built on it" },
    { ecosystem: "pypi", name: "pydantic", weightBp: 3000, role: "feature", reason: "Models" },
  ],
  source: "ai",
  modelId: "workflow-model",
  promptVersion: "judge-v2",
  raw: "{}",
};
const model: JudgeModel = { id: "local-model", generate: async () => JSON.stringify({ packages: [] }) };

describe("runTask", () => {
  it("starts the task by its slug, waits for it, and returns what it returned", async () => {
    const w = fakeWorkflows(() => ({ status: "succeeded", results: [{ ok: 1 }] }));
    expect(await runTask(w.client, "upstream-jobs", "settle", [{ funderId: "f" }])).toEqual({ ok: 1 });
    expect(w.runs).toEqual([{ slug: "upstream-jobs/settle", input: [{ funderId: "f" }] }]);
  });

  it("throws when the run didn't succeed", async () => {
    const w = fakeWorkflows(() => ({ status: "failed", error: "boom" }));
    await expect(runTask(w.client, "upstream-jobs", "payouts", [])).rejects.toThrow("Workflow task payouts failed: boom");
  });
});

describe("the AI judge on Render Workflows", () => {
  let deps: Deps;
  beforeEach(async () => {
    const db = createPgliteDb();
    await migrateDb(db, "pglite");
    deps = { db, http: fakeRegistry, model };
  });

  it("runs as a workflow task when workflows are set up, and the receipt keeps its answer", async () => {
    const w = fakeWorkflows(() => ({ status: "succeeded", results: [judged] }));
    const { accountId } = await createDevice(deps.db, null);
    const { view } = await submitReceipt({ ...deps, workflows: { client: w.client, slug: "upstream-jobs" } }, accountId, payload());
    expect(w.runs.map((r) => r.slug)).toEqual(["upstream-jobs/judge"]);
    expect(view).toMatchObject({ source: "ai", modelId: "workflow-model" });
    expect(view.items.map((i) => [i.name, i.weightBp])).toEqual([["fastapi", 7000], ["pydantic", 3000]]);
  });

  it("judges in this process when the workflow run fails", async () => {
    const w = fakeWorkflows(() => ({ status: "failed", error: "down" }));
    const result = await judgeWith({ ...deps, workflows: { client: w.client, slug: "upstream-jobs" } }, "A title", []);
    expect(w.runs).toHaveLength(1);
    expect(result.modelId).not.toBe("workflow-model");
  });

  it("never sends work to the workflow when no model may be used (the demo's judge budget is spent)", async () => {
    const w = fakeWorkflows(() => ({ status: "succeeded", results: [judged] }));
    const result = await judgeWith({ ...deps, model: null, workflows: { client: w.client, slug: "upstream-jobs" } }, "A title", []);
    expect(w.runs).toHaveLength(0);
    expect(result.source).toBe("fallback");
  });
});

describe("the settlement on Render Workflows", () => {
  it("starts the settle task with the funder when workflows are set up", async () => {
    const report = { settlementId: "s", settledFunders: 1 };
    const w = fakeWorkflows(() => ({ status: "succeeded", results: [report] }));
    const db = createPgliteDb();
    const deps: Deps = { db, http: fakeRegistry, model: null, paypal: new FakePayPal(), workflows: { client: w.client, slug: "upstream-jobs" } };
    expect(await settleJob(deps, { funderId: "f-1" })).toEqual(report);
    expect(w.runs).toEqual([{ slug: "upstream-jobs/settle", input: [{ funderId: "f-1" }] }]);
  });
});
