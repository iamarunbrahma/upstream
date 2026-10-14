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
