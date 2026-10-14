import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import type { Api } from "./api";
import { evidenceFromTranscript } from "./collect";
import { formatReceipt } from "./format";

export interface McpDeps {
  api: Api;
  cwd: string;
  readFile: (path: string) => string;
  findTranscript: (cwd: string) => string | null;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function receiptTool(deps: McpDeps): Promise<ToolResult> {
  const path = deps.findTranscript(deps.cwd);
  if (!path) return err("Upstream found no Claude Code transcript for this project yet.");
  try {
    const { receipt } = await deps.api.submit(evidenceFromTranscript(path, deps.readFile(path), deps.cwd));
    return ok(`${formatReceipt(receipt)}\n\nTo approve or skip, call upstream_approve with receiptId ${receipt.id}.`);
  } catch (e) {
    return err(`Upstream couldn't build the receipt: ${reason(e)}`);
  }
}

export async function approveTool(deps: Pick<McpDeps, "api">, args: { receiptId: string; action: "approve" | "skip" }): Promise<ToolResult> {
  try {
    const { receipt } = await deps.api.decide(args.receiptId, args.action);
    return ok(formatReceipt(receipt));
  } catch (e) {
    return err(`Upstream couldn't record that: ${reason(e)}`);
  }
}

export function buildServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "upstream", version: "0.1.0" });
  server.registerTool(
    "upstream_receipt",
    {
      description:
        "Build this coding session's Upstream receipt: which open-source packages you leaned on and how much each contributed. Show the result to the user and ask whether to approve it.",
      inputSchema: z.object({}),
    },
    () => receiptTool(deps),
  );
  server.registerTool(
    "upstream_approve",
    {
      description: "Approve or skip an Upstream receipt. Only call this after the user has clearly said which they want.",
      inputSchema: z.object({ receiptId: z.uuid(), action: z.enum(["approve", "skip"]) }),
    },
    (args) => approveTool(deps, args),
  );
  return server;
}

export async function serveMcp(deps: McpDeps): Promise<void> {
  await buildServer(deps).connect(new StdioServerTransport());
}
