import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import type { PaypalOrder } from "./api";
import { PayPalError, SANDBOX_API } from "./client";
import { fromCents } from "./money";

/**
 * What Upstream needs from PayPal to take a payment the developer's coding agent started. The real one is PayPal's
 * Agent Toolkit (orders create, get and capture only); tests use FakeAgentOrders.
 */
export interface AgentOrders {
  createOrder(cents: number, returnUrl: string, cancelUrl: string): Promise<{ id: string; status: string; approveUrl: string }>;
  getOrder(id: string): Promise<PaypalOrder>;
  captureOrder(id: string): Promise<PaypalOrder>;
}

/** The toolkit's tools as Upstream calls them: by name, each answering with a JSON string. */
export type ToolkitTools = Record<string, { execute?(args: unknown, options: unknown): PromiseLike<unknown> } | undefined>;

export const AGENT_ORDER_ITEM = "Upstream open-source budget";

export function isSandboxBase(apiBase: string): boolean {
  return apiBase.trim().replace(/\/+$/, "") === SANDBOX_API;
}

const badAnswer = () => new PayPalError(502, "TOOLKIT_BAD_ANSWER", "PayPal's Agent Toolkit gave an answer Upstream couldn't read", null);

/** Runs one toolkit tool. Its `run` never throws: failures come back as {code, message, status} or {error: {...}}. */
async function call(tools: ToolkitTools, name: "create_order" | "get_order" | "pay_order", args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = tools[name];
  if (!tool?.execute) throw new PayPalError(500, "TOOL_NOT_ENABLED", `The PayPal Agent Toolkit tool ${name} isn't enabled`, null);
  const raw = await tool.execute(args, { toolCallId: `upstream-${name}`, messages: [] });
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      throw badAnswer();
    }
  }
  if (!data || typeof data !== "object") throw badAnswer();
  const d = data as Record<string, unknown>;
  const failure = d.error && typeof d.error === "object" ? (d.error as Record<string, unknown>) : d.code && d.message && !d.id ? d : null;
  if (failure) {
    throw new PayPalError(Number(failure.status) || 502, String(failure.code ?? failure.type ?? "PAYPAL_TOOL_ERROR"), String(failure.message ?? "PayPal returned an error"), null);
  }
  return d;
}

interface OrderWithLinks extends PaypalOrder {
  links?: Array<{ rel?: string; href?: string }>;
}

/** An order answer has at least a string id and status; anything else is an answer we can't trust. */
function asOrder(value: unknown): PaypalOrder {
  const o = value as Partial<PaypalOrder> | null;
  if (!o || typeof o !== "object" || typeof o.id !== "string" || typeof o.status !== "string") throw badAnswer();
  return o as PaypalOrder;
}

/** AgentOrders over toolkit tools. `makeTools` runs for every call, so each call gets a fresh PayPal token. */
export function agentOrdersFromTools(makeTools: () => ToolkitTools): AgentOrders {
  return {
    async createOrder(cents, returnUrl, cancelUrl) {
      const dollars = Number(fromCents(cents));
      const o = (await call(makeTools(), "create_order", {
        currencyCode: "USD",
        items: [{ name: AGENT_ORDER_ITEM, quantity: 1, itemCost: dollars, itemTotal: dollars, taxPercent: 0 }],
        returnUrl,
        cancelUrl,
      })) as unknown as OrderWithLinks;
      const link = o.links?.find((l) => l.rel === "payer-action") ?? o.links?.find((l) => l.rel === "approve");
      if (!o.id || !link?.href) throw new PayPalError(502, "NO_APPROVAL_LINK", "PayPal didn't return a link to approve the payment", null);
      return { id: o.id, status: o.status, approveUrl: link.href };
    },
    async getOrder(id) {
      return asOrder(await call(makeTools(), "get_order", { id }));
    },
    async captureOrder(id) {
      const r = await call(makeTools(), "pay_order", { id });
      if (r.status !== "success" || !r.response || typeof r.response !== "object") {
        throw new PayPalError(502, "CAPTURE_FAILED", "PayPal couldn't capture the payment", null);
      }
      return asOrder(r.response);
    },
  };
}

/** PayPal's Agent Toolkit with only creating, reading and capturing orders switched on, on the sandbox. */
export function toolkitTools(cfg: { clientId: string; clientSecret: string }): ToolkitTools {
  const toolkit = new PayPalAgentToolkit({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    configuration: { actions: { orders: { create: true, get: true, capture: true } }, context: { sandbox: true } },
  });
  return toolkit.getTools() as unknown as ToolkitTools;
}

export function createAgentOrders(cfg: { clientId: string; clientSecret: string; apiBase: string }): AgentOrders {
  if (!isSandboxBase(cfg.apiBase)) throw new Error("Payments from the agent run on the PayPal sandbox only");
  return agentOrdersFromTools(() => toolkitTools(cfg));
}
