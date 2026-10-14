# Upstream Plan 3b: Render, Launch and Submission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upstream is live on Render, and its demo really pays Arun's sandbox maintainer account. `upstream-pay` is on npm, the demo video is on YouTube, and the Devpost entry is submitted before 13 Nov 2026, 1:30 AM IST.

**Architecture:**
- **Render Workflows run the three jobs**: the AI judge, settlements, and the payout check. The web app starts a task with the Render SDK and waits for its result (`startTask(...).get()`), so the CLI flow doesn't change. Without `RENDER_API_KEY` and `RENDER_WORKFLOW_SLUG`, every job runs in-process exactly as before. A failed judge run falls back to judging in-process. When the demo's judge budget is spent, nothing is sent.
- **One Blueprint (`render.yaml`)** holds everything:
  - the web service, the `upstream-jobs` workflow service, a monthly settlement cron and a daily payout-check cron (both start workflow tasks)
  - Postgres
  - shared non-secret settings
  - secrets as `sync: false`, so they are entered on Render and never committed
- **The demo pays Arun honestly.** `.github/FUNDING.yml` names him, `upstream-pay` links to the repo, and the recorded sample session installs `upstream-pay`. His sandbox maintainer account links through the hosted maintainer page at least 7 days before the video is recorded.

**Tech Stack:** Plan 3a's stack, plus `@renderinc/sdk` 1.2.0 and the Render CLI 2.29 (local task server and Blueprint validation).

**Spec:** `docs/superpowers/specs/2026-10-14-upstream-design.md`. It covers section 9 (the demo path and the video), section 12 (compliance and sponsor tools) and section 16 (the Plan 3 decisions).

**Verified 14 Oct 2026** in a scratch worktree of `plan-3a-demo-ui` (commits 663ef02, ebc336c and c30e5bf):
- 335 tests pass, with one skipped.
- On Render's local task server (`render workflows dev`), all three tasks registered. The judge task ran with real Gemini (fastapi 56%, pydantic 44%), and the app's `runTask` started the payouts task through the SDK and got its report back.
- `render blueprints validate` needs `render login` on Arun's account, so it runs in Task 4.

**Builds on:** Plan 3a merged to `main`.

## Global Constraints

- Every Plan 1 to 3a constraint still applies.
- **Steps marked (Arun) are his alone:** signing in, payment details, publishing under his name, his voice, and his own statements on Devpost. Claude prepares everything around them and never types his passwords or card.
- Nothing secret is committed: `.env.local`, the Render API key and the sandbox passwords stay out of git. Sandbox logins appear only in Devpost's private testing notes, which Arun approved on 14 Oct.
- The usage-index list is shown to Arun before the branch is pushed (Plan 3a constraint).
- The video stays under 3 minutes, is public on YouTube, and has no copyrighted music or third-party logos beyond the product's own screens.

## Review Focus

1. **A workflow run is slow or queued.** Settle now waits on `.get()`. If Render's proxy times out first, the visitor sees an error while the settlement still finishes. Check the timing live, and switch to polling if a run passes about 25 s.
2. **The workflow service starts while the web app is migrating.** Every process migrates on start. On the first deploy, the web app migrates before any task runs, because tasks only start on demand. Watch the first deploy's logs.
3. **PayPal and 1-cent payouts.** If the sandbox refuses an item below some minimum, raise `MIN_PAYOUT_CENTS` on the demo (Plan 3a ruling).
4. **The webhook and sign-in return URLs** must match the hosted address exactly (https, no trailing slash).
5. **A judge visiting on a phone** gets the same flow (checked in Plan 3a) through Render's proxy and its `X-Forwarded-For`.

---

### Task 1: Run the judge, settlement and payout checks as Render Workflows tasks

**Files:**
- Create: `apps/web/lib/jobs/workflows.ts`, `apps/web/lib/jobs/run.ts`, `apps/web/workflows/index.ts`, `apps/web/test/jobs.test.ts`
- Modify:
  - `apps/web/lib/receipts/service.ts` (the `Deps.workflows` field, and `judgeWith` in place of `judgeReceipt`)
  - `apps/web/lib/deps.ts`
  - `apps/web/app/api/demo/settle/route.ts`
  - `apps/web/app/api/settle/route.ts`
  - `apps/web/jobs/settle.ts`
  - `apps/web/package.json` (`@renderinc/sdk` 1.2.0 and the `workflows` script)
  - `apps/web/tsconfig.json` (typecheck `workflows` and `jobs`)
  - `pnpm-lock.yaml`

**Interfaces:**
- Produces:
  - `WorkflowClient`, `Workflows { client, slug }`, `workflowsFromEnv()` and `runTask<T>(client, workflow, task, input)`
  - `judgeWith(deps, title, rows)`, `settleJob(deps, opts)`, `payoutsJob(deps)`, `settleHere(deps, opts)` and `payoutsHere(deps)`
  - the workflow tasks `judge`, `settle` and `payouts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run apps/web/test/jobs.test.ts`
Expected: FAIL, "Cannot find module '../lib/jobs/workflows'".

- [ ] **Step 3: Implement**

`pnpm --filter web add -E @renderinc/sdk@1.2.0`

```ts
import { Render } from "@renderinc/sdk";

/** The part of Render's Workflows client Upstream uses: start a task run, then wait for its result. */
export interface WorkflowClient {
  startTask(slug: string, input: unknown[]): Promise<{ get(): Promise<{ status: string; results: unknown[]; error?: string }> }>;
}

/** Where Upstream's jobs run on Render Workflows: the client and the workflow's slug ("upstream-jobs"). */
export interface Workflows {
  client: WorkflowClient;
  slug: string;
}

/** Render Workflows from RENDER_API_KEY and RENDER_WORKFLOW_SLUG; null without them, so the jobs run in this process. */
export function workflowsFromEnv(): Workflows | null {
  const slug = process.env.RENDER_WORKFLOW_SLUG;
  if (!process.env.RENDER_API_KEY || !slug) return null;
  return { client: new Render().workflows, slug };
}

/** Runs one task on Render Workflows and returns what it returned. Throws when the run didn't succeed. */
export async function runTask<T>(client: WorkflowClient, workflow: string, task: string, input: unknown[]): Promise<T> {
  const done = await (await client.startTask(`${workflow}/${task}`, input)).get();
  if (done.status !== "succeeded" && done.status !== "completed") {
    throw new Error(`Workflow task ${task} ${done.status}${done.error ? `: ${done.error}` : ""}`);
  }
  return done.results[0] as T;
}
```

```ts
import { judgeReceipt } from "../judge/judge";
import type { JudgeResult, JudgeRow } from "../judge/types";
import { runPayouts, runSettlement, settlementDeps, type PayoutRunReport, type RunReport } from "../funding/run";
import type { SettleOptions } from "../funding/settle";
import type { Deps } from "../receipts/service";
import { createGithubGet } from "../resolver/recipients";
import { runTask } from "./workflows";

/**
 * The AI judge: a Render Workflows task when workflows are set up (with Render's retries and run history), or this
 * process. A failed workflow run falls back to this process. With no model allowed (the demo's daily judge budget
 * is spent), nothing is sent anywhere and the receipt is estimated without AI.
 */
export async function judgeWith(deps: Deps, title: string | null, rows: JudgeRow[]): Promise<JudgeResult> {
  if (deps.model && deps.workflows) {
    try {
      return await runTask<JudgeResult>(deps.workflows.client, deps.workflows.slug, "judge", [title, rows]);
    } catch {
      // The workflow couldn't answer; judge here instead.
    }
  }
  return judgeReceipt(title, rows, deps.model);
}

/** The settlement in this process, as the "settle" workflow task and the no-workflows path both run it. */
export function settleHere(deps: Deps, opts: SettleOptions = {}): Promise<RunReport> {
  if (!deps.paypal) throw new Error("PayPal isn't set up (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET), so nothing can be paid out.");
  return runSettlement(settlementDeps({ ...deps, paypal: deps.paypal }, createGithubGet(process.env.GITHUB_TOKEN)), opts);
}

/** The payout check and send in this process, as the "payouts" workflow task and the no-workflows path both run it. */
export function payoutsHere(deps: Deps): Promise<PayoutRunReport> {
  if (!deps.paypal) throw new Error("PayPal isn't set up (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET), so nothing can be paid out.");
  return runPayouts(settlementDeps({ ...deps, paypal: deps.paypal }, createGithubGet(process.env.GITHUB_TOKEN)));
}

/** A settlement (everyone, or one funder): the "settle" workflow task when workflows are set up, or this process. */
export function settleJob(deps: Deps, opts: SettleOptions = {}): Promise<RunReport> {
  return deps.workflows ? runTask<RunReport>(deps.workflows.client, deps.workflows.slug, "settle", [opts]) : settleHere(deps, opts);
}

/** The daily payout check and send: the "payouts" workflow task when workflows are set up, or this process. */
export function payoutsJob(deps: Deps): Promise<PayoutRunReport> {
  return deps.workflows ? runTask<PayoutRunReport>(deps.workflows.client, deps.workflows.slug, "payouts", []) : payoutsHere(deps);
}
```

```ts
// Upstream's Render Workflows service: registers its three tasks, and Render's task server runs them.
// Start command: `pnpm --filter web workflows`. The web app and the cron jobs start runs with RENDER_API_KEY.
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { getDeps } from "../lib/deps";
import type { SettleOptions } from "../lib/funding/settle";
import { payoutsHere, settleHere } from "../lib/jobs/run";
import { judgeReceipt } from "../lib/judge/judge";
import type { JudgeRow } from "../lib/judge/types";

/** The AI judge for one receipt. It retries and falls back by itself, so Render retries only crashes. */
task({ name: "judge", timeoutSeconds: 120, retry: { maxRetries: 1, waitDurationMs: 2000, backoffScaling: 2 } }, async (_ctx: TaskContext, title: string | null, rows: JudgeRow[]) =>
  judgeReceipt(title, rows, (await getDeps()).model),
);

/** A settlement: everyone (the monthly cron) or one funder (the demo's Settle now). Safe to retry: nothing is spent twice. */
task({ name: "settle", timeoutSeconds: 900, retry: { maxRetries: 2, waitDurationMs: 30_000, backoffScaling: 2 } }, async (_ctx: TaskContext, opts: SettleOptions = {}) =>
  settleHere(await getDeps(), opts),
);

/** The daily payout check: catch up on statuses with PayPal, then send waiting payouts. */
task({ name: "payouts", timeoutSeconds: 900, retry: { maxRetries: 2, waitDurationMs: 30_000, backoffScaling: 2 } }, async () => payoutsHere(await getDeps()));
```

```diff
--- a/apps/web/lib/receipts/service.ts
+++ b/apps/web/lib/receipts/service.ts
@@ -3,5 +3,6 @@ import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
 import type { Db } from "../db/client";
 import { receiptItems, receipts, type StoredEvidence } from "../db/schema";
-import { judgeReceipt } from "../judge/judge";
+import { judgeWith } from "../jobs/run";
+import type { Workflows } from "../jobs/workflows";
 import type { JudgeModel, JudgeRow } from "../judge/types";
 import { resolveWithCache } from "../resolver/cache";
@@ -31,4 +32,6 @@ export interface Deps {
   /** Cap on AI judging for the demo's sample session, shared by every demo account. */
   demoJudgeLimiter?: RateLimiter;
+  /** Render Workflows, which run the judge, settlements and payout checks; null runs them in this process. */
+  workflows?: Workflows | null;
   /** PayPal REST client; null when the server has no PayPal credentials. */
   paypal?: PayPalApi | null;
@@ -98,5 +101,5 @@ export async function submitReceipt(
 
   const rows = await buildRows(deps, payload);
-  const judged = await judgeReceipt(payload.title, rows, deps.model);
+  const judged = await judgeWith(deps, payload.title, rows);
   const rowByKey = new Map(rows.map((r) => [packageKey(r), r]));
   const fields = {
```

```diff
--- a/apps/web/lib/deps.ts
+++ b/apps/web/lib/deps.ts
@@ -3,4 +3,5 @@ import { createPgDb, createPgliteDb } from "./db/client";
 import { migrateDb } from "./db/migrate";
 import { createGeminiModel } from "./judge/gemini";
+import { workflowsFromEnv } from "./jobs/workflows";
 import { createRateLimiter } from "./limits";
 import { createGithubOAuth } from "./maintainers/github-oauth";
@@ -51,4 +52,5 @@ export function getDeps(): Promise<Deps> {
           : null,
       planIds: planIdsFromEnv(),
+      workflows: workflowsFromEnv(),
       webhookId: process.env.PAYPAL_WEBHOOK_ID ?? null,
       githubOAuth:
```

```diff
--- a/apps/web/app/api/demo/settle/route.ts
+++ b/apps/web/app/api/demo/settle/route.ts
@@ -1,7 +1,6 @@
 import { demoEnabled, isDemoAccount } from "../../../../lib/demo/accounts";
 import { describeSettleNow, settleNowBlocker } from "../../../../lib/demo/settle-now";
-import { runSettlement, settlementDeps } from "../../../../lib/funding/run";
 import { json, withAccount } from "../../../../lib/http";
-import { createGithubGet } from "../../../../lib/resolver/recipients";
+import { settleJob } from "../../../../lib/jobs/run";
 
 export const runtime = "nodejs";
@@ -18,6 +17,5 @@ export async function POST(req: Request): Promise<Response> {
     const blocker = await settleNowBlocker(deps.db, accountId);
     if (blocker) return json({ error: blocker }, 409);
-    const run = settlementDeps({ ...deps, paypal: deps.paypal }, createGithubGet(process.env.GITHUB_TOKEN));
-    const report = await runSettlement(run, { funderId: accountId });
+    const report = await settleJob(deps, { funderId: accountId });
     return json(describeSettleNow(report));
   });
```

```diff
--- a/apps/web/app/api/settle/route.ts
+++ b/apps/web/app/api/settle/route.ts
@@ -2,7 +2,7 @@ import { createHash, timingSafeEqual } from "node:crypto";
 import { bearerToken } from "../../../lib/auth";
 import { getDeps } from "../../../lib/deps";
-import { describeRun, runSettlement, settlementDeps } from "../../../lib/funding/run";
+import { describeRun } from "../../../lib/funding/run";
 import { json } from "../../../lib/http";
-import { createGithubGet } from "../../../lib/resolver/recipients";
+import { settleJob } from "../../../lib/jobs/run";
 
 export const runtime = "nodejs";
@@ -17,5 +17,5 @@ export async function POST(req: Request): Promise<Response> {
   const deps = await getDeps();
   if (!deps.paypal) return json({ error: "Payments aren't set up on this server yet" }, 503);
-  const report = await runSettlement(settlementDeps({ ...deps, paypal: deps.paypal }, createGithubGet(process.env.GITHUB_TOKEN)));
+  const report = await settleJob(deps);
   return json({ report, summary: describeRun(report) });
 }
```

```diff
--- a/apps/web/jobs/settle.ts
+++ b/apps/web/jobs/settle.ts
@@ -2,7 +2,8 @@
 // instead: only one process may open a PGlite database, and the dev server already has it.
 // Monthly: `pnpm --filter web settle`. Daily: `pnpm --filter web settle --payouts-only` checks and sends payouts.
+// With Render Workflows set up (RENDER_API_KEY, RENDER_WORKFLOW_SLUG), each run is a workflow task with its own retries and history.
 import { getDeps } from "../lib/deps";
-import { describeRun, runPayouts, runSettlement, settlementDeps } from "../lib/funding/run";
-import { createGithubGet } from "../lib/resolver/recipients";
+import { describeRun } from "../lib/funding/run";
+import { payoutsJob, settleJob } from "../lib/jobs/run";
 
 const deps = await getDeps();
@@ -11,6 +12,5 @@ if (!deps.paypal) {
   process.exit(1);
 }
-const runDeps = settlementDeps({ ...deps, paypal: deps.paypal }, createGithubGet(process.env.GITHUB_TOKEN));
-const report = process.argv.includes("--payouts-only") ? await runPayouts(runDeps) : await runSettlement(runDeps);
+const report = process.argv.includes("--payouts-only") ? await payoutsJob(deps) : await settleJob(deps);
 for (const line of describeRun(report)) console.log(line);
 process.exit(0);
```

```diff
--- a/apps/web/package.json
+++ b/apps/web/package.json
@@ -15,5 +15,6 @@
     "claim-maintainer": "node --env-file-if-exists=.env.local --import tsx scripts/claim-maintainer.ts",
     "resolve-payout-check": "node --env-file-if-exists=.env.local --import tsx scripts/resolve-payout-check.ts",
-    "usage-index": "node --import tsx scripts/usage-index.ts"
+    "usage-index": "node --import tsx scripts/usage-index.ts",
+    "workflows": "node --env-file-if-exists=.env.local --import tsx workflows/index.ts"
   },
   "dependencies": {
@@ -21,4 +22,5 @@
     "@google/genai": "2.29.1",
     "@paypal/react-paypal-js": "10.6.0",
+    "@renderinc/sdk": "1.2.0",
     "@upstream/core": "workspace:*",
     "class-variance-authority": "0.7.1",
```

```diff
--- a/apps/web/tsconfig.json
+++ b/apps/web/tsconfig.json
@@ -7,5 +7,5 @@
     "paths": { "@/*": ["./*"] }
   },
-  "include": ["next-env.d.ts", "app", "lib", "scripts", "test", "drizzle.config.ts", "next.config.ts"],
+  "include": ["next-env.d.ts", "app", "lib", "scripts", "test", "workflows", "jobs", "drizzle.config.ts", "next.config.ts"],
   "exclude": ["node_modules", ".next"]
 }
```

- [ ] **Step 4: Run the tests and the local task server**

Run: `pnpm test && pnpm typecheck`
Expected: 335 passed, 1 skipped; typecheck exits 0.

Then:
- From `apps/web`, run `render workflows dev --confirm -o text -- node --env-file-if-exists=.env.local --import tsx workflows/index.ts`.
- Run the judge on the fastapi example with `render workflows start judge --local --input='[...]'`.

Expected: "3 tasks found: judge, payouts, settle". The judge run succeeds with `source: "ai"`.

- [ ] **Step 5: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "Run the judge, settlement and payout checks as Render Workflows tasks"
```

### Task 2: The Blueprint

**Files:**
- Create: `render.yaml`

- [ ] **Step 1: Write it**

```yaml
# Upstream on Render: the web app, the Workflows service that runs the AI judge, settlements and payout checks,
# a monthly settlement and a daily payout check (both start Workflows tasks), and Postgres.
# Secrets are `sync: false`: Render asks for them when the Blueprint is created, and they never live in this file.

databases:
  - name: upstream-db
    plan: basic-256mb
    region: oregon
    postgresMajorVersion: "17"

envVarGroups:
  - name: upstream-shared
    envVars:
      - key: NODE_VERSION
        value: "24"
      # The hosted sandbox demo: "Try the demo" accounts, and payouts at any amount (the real rule is $1).
      - key: DEMO_MODE
        value: "1"
      - key: MIN_PAYOUT_CENTS
        value: "1"
      - key: GEMINI_MODEL
        value: gemini-2.5-flash-lite
      - key: PAYPAL_API_BASE
        value: https://api-m.sandbox.paypal.com
      - key: NEXT_PUBLIC_PAYPAL_ENV
        value: sandbox

services:
  - type: web
    name: upstream
    runtime: node
    region: oregon
    plan: starter
    buildCommand: corepack enable && pnpm install --frozen-lockfile && pnpm --filter web build
    startCommand: pnpm --filter web start
    healthCheckPath: /
    envVars:
      - fromGroup: upstream-shared
      - key: DATABASE_URL
        fromDatabase:
          name: upstream-db
          property: connectionString
      - key: RENDER_WORKFLOW_SLUG
        fromService:
          type: workflow
          name: upstream-jobs
          property: slug
      - key: SETTLE_TOKEN
        generateValue: true
      - key: PUBLIC_URL
        sync: false
      - key: PAYPAL_CLIENT_ID
        sync: false
      - key: NEXT_PUBLIC_PAYPAL_CLIENT_ID
        sync: false
      - key: PAYPAL_CLIENT_SECRET
        sync: false
      - key: PAYPAL_WEBHOOK_ID
        sync: false
      - key: PAYPAL_PLAN_STARTER
        sync: false
      - key: PAYPAL_PLAN_BUILDER
        sync: false
      - key: PAYPAL_PLAN_TEAM
        sync: false
      - key: GEMINI_API_KEY
        sync: false
      - key: GITHUB_TOKEN
        sync: false
      - key: GITHUB_CLIENT_ID
        sync: false
      - key: GITHUB_CLIENT_SECRET
        sync: false
      - key: RENDER_API_KEY
        sync: false

  - type: workflow
    name: upstream-jobs
    runtime: node
    region: oregon
    buildCommand: corepack enable && pnpm install --frozen-lockfile
    startCommand: pnpm --filter web workflows
    envVars:
      - fromGroup: upstream-shared
      - key: DATABASE_URL
        fromDatabase:
          name: upstream-db
          property: connectionString
      - key: PAYPAL_CLIENT_ID
        sync: false
      - key: PAYPAL_CLIENT_SECRET
        sync: false
      - key: GEMINI_API_KEY
        sync: false
      - key: GITHUB_TOKEN
        sync: false

  # On the 1st of each month: settle every budget (a Workflows "settle" run).
  - type: cron
    name: upstream-settle-monthly
    runtime: node
    region: oregon
    plan: starter
    schedule: "0 6 1 * *"
    buildCommand: corepack enable && pnpm install --frozen-lockfile
    startCommand: pnpm --filter web settle
    envVars:
      - fromGroup: upstream-shared
      - key: DATABASE_URL
        fromDatabase:
          name: upstream-db
          property: connectionString
      - key: RENDER_WORKFLOW_SLUG
        fromService:
          type: workflow
          name: upstream-jobs
          property: slug
      - key: PAYPAL_CLIENT_ID
        sync: false
      - key: PAYPAL_CLIENT_SECRET
        sync: false
      - key: RENDER_API_KEY
        sync: false

  # Every day: check payout statuses with PayPal and send what's waiting (a Workflows "payouts" run).
  - type: cron
    name: upstream-payouts-daily
    runtime: node
    region: oregon
    plan: starter
    schedule: "0 7 * * *"
    buildCommand: corepack enable && pnpm install --frozen-lockfile
    startCommand: pnpm --filter web settle --payouts-only
    envVars:
      - fromGroup: upstream-shared
      - key: DATABASE_URL
        fromDatabase:
          name: upstream-db
          property: connectionString
      - key: RENDER_WORKFLOW_SLUG
        fromService:
          type: workflow
          name: upstream-jobs
          property: slug
      - key: PAYPAL_CLIENT_ID
        sync: false
      - key: PAYPAL_CLIENT_SECRET
        sync: false
      - key: RENDER_API_KEY
        sync: false
```

- [ ] **Step 2: Commit**

```bash
git add render.yaml
git commit -m "Describe the Render deploy in a Blueprint"
```

### Task 3: Name the maintainer, and link the package to its repo

**Files:**
- Create: `.github/FUNDING.yml`
- Modify: `packages/cli/package.json` (`repository` and `homepage`)

- [ ] **Step 1: Write them**

```yaml
github: [iamarunbrahma]
```

```diff
--- a/packages/cli/package.json
+++ b/packages/cli/package.json
@@ -4,4 +4,6 @@
   "description": "Your AI coding agent pays back the open source it builds with.",
   "license": "MIT",
+  "repository": { "type": "git", "url": "git+https://github.com/iamarunbrahma/upstream.git", "directory": "packages/cli" },
+  "homepage": "https://github.com/iamarunbrahma/upstream",
   "type": "module",
   "bin": { "upstream": "./plugin/dist/upstream.mjs" },
```

- [ ] **Step 2: Commit**

```bash
git add .github/FUNDING.yml packages/cli/package.json
git commit -m "Name the maintainer in FUNDING.yml and link upstream-pay to its repo"
```

GitHub shows a "Sponsor" button for FUNDING.yml. It points at github.com/sponsors/iamarunbrahma, which may not exist. Arun decides whether to keep it before the push.

### Task 4: Deploy on Render (Arun, then Claude)

- [ ] **Step 1 (Arun):** Apply the hackathon credit and add a card, which lifts the suspension. Create a Render API key and put it in `apps/web/.env.local` as `RENDER_API_KEY`. Run `render login` once.
- [ ] **Step 2:** Run `render blueprints validate ./render.yaml`. Expected: valid. Fix any field it names.
- [ ] **Step 3:** Merge to `main` and push. This needs Arun's go-ahead, after he has seen the usage list.
- [ ] **Step 4 (Arun, with Claude driving the browser):** In the Render Dashboard, go to Blueprints, then New Blueprint Instance, and pick the repo. Enter the `sync: false` values from `.env.local`, with `PUBLIC_URL` left empty for now. Expected: the web service, `upstream-jobs`, two crons and `upstream-db` all go live.
- [ ] **Step 5:** Set `PUBLIC_URL` to the web service's `https://...onrender.com` address. Then check the deploy:
  - `curl -sI` on `/` gives 200, with `X-Frame-Options: DENY`.
  - Try the demo, then Run a sample session, works on the hosted site.
  - `upstream-jobs` shows a `judge` run in the Render Dashboard.
- [ ] **Step 6:** Re-run `settle-pg.test.ts` against Render's Postgres with an external connection string to a throwaway database, never `upstream-db` itself (the test wipes it). Expected: 1 passed.

### Task 5: The CLI points at the hosted server, and is published (Arun's go-ahead)

**Files:**
- Modify: `packages/cli/src/config.ts` (`DEFAULT_API_URL` becomes the hosted URL), `packages/cli/package.json` (version 0.1.0 stays)

- [ ] **Step 1:** Change `DEFAULT_API_URL`, and update its comment. Run `pnpm test`. Expected: all pass. The CLI tests use `UPSTREAM_API_URL`.
- [ ] **Step 2:** Run `pnpm --filter upstream-pay build`, then `npm pack --dry-run` in `packages/cli`. Expected: only `plugin/` files and `package.json`, with no source maps holding paths.
- [ ] **Step 3 (Arun):** Run `npm login` once. **Claude asks before** running `npm publish --access public` in `packages/cli`. Expected: `npm view upstream-pay repository.url` shows the GitHub repo.
- [ ] **Step 4:** Commit, with the message "Point the CLI at the hosted Upstream".

### Task 6: PayPal and GitHub settings for the hosted address (Arun signs in, Claude configures)

- [ ] **Step 1:** Register the webhook at `<PUBLIC_URL>/api/paypal/webhook` in the sandbox app, for the events in `docs/e2e-plan-2b.md`. Set `PAYPAL_WEBHOOK_ID` on the web service.
- [ ] **Step 2:** Log in with PayPal. Set the return URL to `<PUBLIC_URL>/maintainer/paypal/callback`, with "PayPal account ID" and "Account verification status" turned on.
- [ ] **Step 3:** Create a GitHub OAuth app with the callback `<PUBLIC_URL>/maintainer/github/callback`. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
- [ ] **Step 4:** Do Plan 2c's Task 7, the live sign-in. Arun signs in on the hosted `/maintainer` with GitHub, then links the sandbox maintainer account `sb-ls07n53353609` (PayPal account ID `SSDWP3LEBURPJ`). Record whether PayPal echoes `state`. **This starts his 7-day first-payout hold, so do it as early as possible.**

### Task 7: The sample session, recorded again with upstream-pay in it

**Files:**
- Replace: `apps/web/lib/demo/sample-session.json`; update `docs/demo-sample-session.md`
- Modify: `apps/web/test/demo-sample.test.ts` (it also expects `upstream-pay`)

- [ ] **Step 1:** Record an interactive Claude Code session that builds the same link shortener and runs `npm install -D upstream-pay`, adding an `upstream` script so CI can send receipts for other agents. An interactive session gets a title. This can be Arun's session for the video, or a helper agent's.
- [ ] **Step 2:** Strip it down and anonymise it as `docs/demo-sample-session.md` describes, and check it contains no paths, names or emails.
- [ ] **Step 3:** Add `upstream-pay` to the test's expected packages, watch it fail on the old file, swap in the new file, and watch it pass.
- [ ] **Step 4:** Commit, with the message "Record the sample session again with upstream-pay in it".

### Task 8: The live demo, end to end

- [ ] Do this once Arun's hold has ended (7 days after Task 6 Step 4):
  1. Try the demo, add $5 with the sandbox buyer, run the sample session, approve it, then Settle now.
  2. Expected: the `upstream-pay` share is "On its way via PayPal" for @iamarunbrahma, then "Paid via PayPal" when the webhook arrives, and the maintainer page shows the payout.
- [ ] Record the run in `docs/e2e-plan-3b.md`, with timings, the payout status and fee, and any differences from local.

### Task 9: The video and the Devpost submission (Arun's voice and statements)

- [ ] **Step 1 (Arun):** Record the screen and voiceover from `devpost/video-script.md`, upload the video to YouTube as public, and paste the link into the Devpost draft.
- [ ] **Step 2:** In the Devpost draft (submission 1237265):
  - Set the demo URL to the hosted address.
  - Write the testing notes with the hosted URL, the sandbox buyer login, and the four demo steps.
  - Add the story's Render section, now that it's true.
  - Upload three screenshots from the hosted site.
- [ ] **Step 3 (Arun):** Answer the Additional info questions that are his alone: the PayPal rating and feedback, whether PayPal may contact him, the three eligibility statements, the learning level and career value. Then tick the rules box and press **Submit project**. Expected: Devpost shows the project as submitted, not a draft, before the deadline.
