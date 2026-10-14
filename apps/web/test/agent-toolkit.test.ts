import { describe, expect, it } from "vitest";
import { agentOrdersFromTools, AGENT_ORDER_ITEM, createAgentOrders, isSandboxBase, toolkitTools, type ToolkitTools } from "../lib/paypal/agent-toolkit";
import { PayPalError } from "../lib/paypal/client";

/** Toolkit tools that answer the way the real ones do: a JSON string (or a given raw string), recording each call. */
function fakeTools(answers: Record<string, unknown>, seen: Array<[string, unknown]> = []): ToolkitTools {
  return Object.fromEntries(
    Object.entries(answers).map(([name, answer]) => [
      name,
      {
        execute: async (args: unknown) => {
          seen.push([name, args]);
          return typeof answer === "string" ? answer : JSON.stringify(answer);
        },
      },
    ]),
  );
}

const order = (links: Array<{ rel: string; href: string }>) => ({ id: "5O190127TN364715T", status: "PAYER_ACTION_REQUIRED", links });

describe("the PayPal Agent Toolkit wrapper", () => {
  it("creates a USD order for the amount, with Upstream's return pages, and returns PayPal's approval link", async () => {
    const seen: Array<[string, unknown]> = [];
    const orders = agentOrdersFromTools(() =>
      fakeTools({ create_order: order([{ rel: "self", href: "x" }, { rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=5O1" }]) }, seen),
    );
    const out = await orders.createOrder(1000, "https://up.test/agent/paid", "https://up.test/agent/paid?cancelled=1");
    expect(out).toEqual({ id: "5O190127TN364715T", status: "PAYER_ACTION_REQUIRED", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=5O1" });
    expect(seen).toEqual([
      [
        "create_order",
        {
          currencyCode: "USD",
          items: [{ name: AGENT_ORDER_ITEM, quantity: 1, itemCost: 10, itemTotal: 10, taxPercent: 0 }],
          returnUrl: "https://up.test/agent/paid",
          cancelUrl: "https://up.test/agent/paid?cancelled=1",
        },
      ],
    ]);
  });

  it("falls back to the approve link, and refuses an order with no link to approve it", async () => {
    const withApprove = agentOrdersFromTools(() => fakeTools({ create_order: order([{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=A" }]) }));
    expect((await withApprove.createOrder(999, "r", "c")).approveUrl).toBe("https://www.sandbox.paypal.com/checkoutnow?token=A");
    const none = agentOrdersFromTools(() => fakeTools({ create_order: order([{ rel: "self", href: "x" }]) }));
    await expect(none.createOrder(999, "r", "c")).rejects.toBeInstanceOf(PayPalError);
  });

  it("turns the toolkit's error answers into PayPalError, whatever shape they come in", async () => {
    const httpError = agentOrdersFromTools(() => fakeTools({ get_order: { code: "PAYPAL_API_HTTP_ERROR", message: "Not found", status: 404 } }));
    await expect(httpError.getOrder("X")).rejects.toMatchObject({ status: 404, code: "PAYPAL_API_HTTP_ERROR" });
    const plainError = agentOrdersFromTools(() => fakeTools({ get_order: { error: { message: "socket hang up", type: "paypal_error" } } }));
    await expect(plainError.getOrder("X")).rejects.toMatchObject({ status: 502 });
    const notJson = agentOrdersFromTools(() => fakeTools({ get_order: "<html>Bad gateway</html>" }));
    await expect(notJson.getOrder("X")).rejects.toMatchObject({ status: 502, code: "TOOLKIT_BAD_ANSWER" });
    const nothing = agentOrdersFromTools(() => fakeTools({ get_order: "null" }));
    await expect(nothing.getOrder("X")).rejects.toMatchObject({ status: 502, code: "TOOLKIT_BAD_ANSWER" });
  });

  it("captures with pay_order and returns the captured order, or fails clearly", async () => {
    const captured = { id: "O1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "C1", status: "COMPLETED" }] } }] };
    const good = agentOrdersFromTools(() => fakeTools({ pay_order: { status: "success", response: captured } }));
    expect(await good.captureOrder("O1")).toEqual(captured);
    const bad = agentOrdersFromTools(() => fakeTools({ pay_order: { status: "error", response: { name: "UNPROCESSABLE_ENTITY" } } }));
    await expect(bad.captureOrder("O1")).rejects.toBeInstanceOf(PayPalError);
  });

  it("says so when a tool isn't enabled, and builds fresh tools for every call", async () => {
    let built = 0;
    const orders = agentOrdersFromTools(() => {
      built += 1;
      return fakeTools({ get_order: { id: "O1", status: "CREATED" } });
    });
    await orders.getOrder("O1");
    await orders.getOrder("O1");
    expect(built).toBe(2);
    await expect(orders.captureOrder("O1")).rejects.toMatchObject({ status: 500, code: "TOOL_NOT_ENABLED" });
  });

  it("runs on the PayPal sandbox only, with only the three order tools switched on", () => {
    expect(isSandboxBase("https://api-m.sandbox.paypal.com")).toBe(true);
    expect(isSandboxBase("https://api-m.sandbox.paypal.com/")).toBe(true);
    expect(isSandboxBase("https://api-m.paypal.com")).toBe(false);
    expect(() => createAgentOrders({ clientId: "id", clientSecret: "secret", apiBase: "https://api-m.paypal.com" })).toThrow(/sandbox/);
    expect(Object.keys(toolkitTools({ clientId: "id", clientSecret: "secret" })).sort()).toEqual(["create_order", "get_order", "pay_order"]);
  });
});
