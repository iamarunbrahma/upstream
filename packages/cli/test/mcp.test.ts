import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Api } from "../src/api";
import { addMoneyTool, approveTool, budgetTool, paymentStatusTool, receiptTool } from "../src/mcp";
import { view } from "./helpers";

const fixturePath = new URL("./fixtures/session.jsonl", import.meta.url).pathname;
const decided: Array<[string, string]> = [];
const api = {
  submit: async () => ({ receipt: view, changed: true }),
  decide: async (id: string, action: "approve" | "skip") => {
    decided.push([id, action]);
    return { receipt: { ...view, status: action === "approve" ? "approved" : "skipped" } };
  },
} as unknown as Api;
const base = { api, cwd: "/work/app", readFile: (p: string) => readFileSync(p, "utf8") };

describe("MCP tools", () => {
  it("upstream_receipt builds, submits and shows the receipt with how to approve it", async () => {
    const res = await receiptTool({ ...base, findTranscript: () => fixturePath });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("Upstream receipt - Build a todo API with FastAPI");
    expect(res.content[0]!.text).toContain(`receiptId ${view.id}`);
  });

  it("upstream_receipt reports a clear error when no transcript exists", async () => {
    const res = await receiptTool({ ...base, findTranscript: () => null });
    expect(res.isError).toBe(true);
  });

  it("upstream_approve passes the decision through", async () => {
    const res = await approveTool(base, { receiptId: view.id, action: "approve" });
    expect(decided).toEqual([[view.id, "approve"]]);
    expect(res.content[0]!.text).toContain("Approved.");
  });
});

describe("paying from the agent", () => {
  const sent: number[] = [];
  const statuses: Record<string, unknown> = {
    "ORDER-1": { status: "waiting", budgetCents: 434 },
    "ORDER-2": { status: "added", addedCents: 916, budgetCents: 1350 },
    "ORDER-3": { status: "cancelled", budgetCents: 434 },
  };
  const payApi = {
    addMoney: async (cents: number) => {
      sent.push(cents);
      return { orderId: "ORDER-9", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-9", cents };
    },
    paymentStatus: async (id: string) => {
      if (!statuses[id]) throw new Error("No such payment for this machine.");
      return statuses[id];
    },
    me: async () => ({ balanceCents: 1350, givenCents: 120, subscription: { tier: "starter", status: "ACTIVE" } }),
  } as unknown as Api;

  it("upstream_add_money sends exact cents and shows the PayPal link, saying nothing is charged until approved", async () => {
    const res = await addMoneyTool({ api: payApi }, { dollars: 9.99 });
    await addMoneyTool({ api: payApi }, { dollars: 10 });
    expect(sent).toEqual([999, 1000]);
    expect(res.content[0]!.text).toContain("https://www.sandbox.paypal.com/checkoutnow?token=ORDER-9");
    expect(res.content[0]!.text).toContain("$9.99");
    expect(res.content[0]!.text).toContain("Nothing is charged until you approve it");
    expect(res.content[0]!.text).toContain("ORDER-9");
  });

  it("upstream_payment_status words each outcome plainly", async () => {
    expect((await paymentStatusTool({ api: payApi }, { orderId: "ORDER-1" })).content[0]!.text).toContain("still waiting for you to approve");
    expect((await paymentStatusTool({ api: payApi }, { orderId: "ORDER-2" })).content[0]!.text).toBe(
      "Added $9.16 to your Upstream budget, after PayPal's fee. Your budget is now $13.50.",
    );
    expect((await paymentStatusTool({ api: payApi }, { orderId: "ORDER-3" })).content[0]!.text).toContain("Nothing was charged");
    const missing = await paymentStatusTool({ api: payApi }, { orderId: "ORDER-NOPE" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toBe("Upstream couldn't check the payment: No such payment for this machine.");
  });

  it("upstream_budget shows the budget, what's set aside, and the monthly plan", async () => {
    expect((await budgetTool({ api: payApi })).content[0]!.text).toBe(
      "Your Upstream budget: $13.50. Set aside for maintainers so far: $1.20. You give $5 a month.",
    );
  });
});
