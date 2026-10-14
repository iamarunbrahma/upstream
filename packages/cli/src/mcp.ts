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

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const PLAN: Record<string, string> = { starter: "$5 a month", builder: "$15 a month", team: "$50 a month" };

export async function budgetTool(deps: Pick<McpDeps, "api">): Promise<ToolResult> {
  try {
    const me = await deps.api.me();
    const plan = me.subscription?.status === "ACTIVE" ? `You give ${PLAN[me.subscription.tier] ?? me.subscription.tier}.` : "No monthly plan.";
    return ok(`Your Upstream budget: ${usd(me.balanceCents)}. Set aside for maintainers so far: ${usd(me.givenCents)}. ${plan}`);
  } catch (e) {
    return err(`Upstream couldn't read your budget: ${reason(e)}`);
  }
}

export async function addMoneyTool(deps: Pick<McpDeps, "api">, args: { dollars: number }): Promise<ToolResult> {
  try {
    const p = await deps.api.addMoney(Math.round(args.dollars * 100));
    return ok(
      [
        `Open this link and approve the ${usd(p.cents)} payment in PayPal:`,
        p.approveUrl,
        "",
        `Nothing is charged until you approve it there. When you have, tell me and I'll finish it (payment ${p.orderId}).`,
      ].join("\n"),
    );
  } catch (e) {
    return err(`Upstream couldn't start the payment: ${reason(e)}`);
  }
}

export async function paymentStatusTool(deps: Pick<McpDeps, "api">, args: { orderId: string }): Promise<ToolResult> {
  try {
    const r = await deps.api.paymentStatus(args.orderId);
    if (r.status === "added") return ok(`Added ${usd(r.addedCents)} to your Upstream budget, after PayPal's fee. Your budget is now ${usd(r.budgetCents)}.`);
    if (r.status === "waiting") return ok("PayPal is still waiting for you to approve this payment. Open the link, approve it, then ask me to check again.");
    return ok("This payment was cancelled or expired in PayPal. Nothing was charged.");
  } catch (e) {
    return err(`Upstream couldn't check the payment: ${reason(e)}`);
  }
}

export function buildServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "upstream", version: "0.2.0" });
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
  server.registerTool(
    "upstream_budget",
    {
      description: "Show how much is in the user's Upstream budget, what has been set aside for open-source maintainers, and their monthly plan.",
      inputSchema: z.object({}),
    },
    () => budgetTool(deps),
  );
  server.registerTool(
    "upstream_add_money",
    {
      description:
        "Start a PayPal payment that adds money to the user's Upstream budget. Only call this when the user has asked to add a specific amount; never on your own initiative, and never change the amount without asking. Show the user the PayPal link it returns: nothing is charged until they approve it there.",
      inputSchema: z.object({ dollars: z.number().min(1).max(500) }),
    },
    (args) => addMoneyTool(deps, args),
  );
  server.registerTool(
    "upstream_payment_status",
    {
      description:
        "Finish an Upstream payment after the user says they approved it in PayPal: captures it and reports what was added. Only call it for a payment started with upstream_add_money.",
      inputSchema: z.object({ orderId: z.string().min(1) }),
    },
    (args) => paymentStatusTool(deps, args),
  );
  return server;
}

export async function serveMcp(deps: McpDeps): Promise<void> {
  await buildServer(deps).connect(new StdioServerTransport());
}
